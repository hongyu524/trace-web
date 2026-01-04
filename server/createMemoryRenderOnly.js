import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createFramePlan, applyFramePlan, createFramePlansBatch } from './auto-reframe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Firebase Admin SDK (lazy-loaded to avoid startup dependency if not configured)
let firebaseAdmin = null;
let firebaseApp = null;

async function initFirebaseAdmin() {
  if (firebaseAdmin) return firebaseAdmin; // Already initialized
  
  try {
    // Only import if FIREBASE_PROJECT_ID is set (indicates Firebase is configured)
    if (!process.env.FIREBASE_PROJECT_ID) {
      return null; // Firebase not configured
    }
    
    firebaseAdmin = await import('firebase-admin');
    
    // Initialize Firebase Admin if not already initialized
    if (!firebaseApp) {
      // Use service account key if provided, otherwise use default credentials
      if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
        firebaseApp = firebaseAdmin.default.initializeApp({
          credential: firebaseAdmin.default.credential.cert(serviceAccount),
        });
      } else {
        // Try default credentials (e.g., from GCP environment)
        firebaseApp = firebaseAdmin.default.initializeApp();
      }
    }
    
    return firebaseAdmin;
  } catch (err) {
    console.warn('[AUTH] Firebase Admin initialization failed:', err.message);
    return null;
  }
}

/**
 * Verify Bearer token and extract user plan from Firebase
 * Returns { uid, plan: 'free' | 'premium', verified: true } or { verified: false, plan: 'free' }
 */
async function verifyUserPlan(authHeader) {
  // Default to free if no auth header
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { verified: false, plan: 'free', uid: null };
  }
  
  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  
  try {
    const admin = await initFirebaseAdmin();
    if (!admin) {
      // Firebase not configured - default to free
      console.warn('[AUTH] Firebase not configured, defaulting to free plan');
      return { verified: false, plan: 'free', uid: null };
    }
    
    // Verify the token
    const decodedToken = await admin.default.auth().verifyIdToken(token);
    const uid = decodedToken.uid;
    
    // Check custom claims first (preferred method)
    // Firebase custom claims are properties directly on decodedToken
    const plan = decodedToken.plan;
    if (plan === 'premium') {
      return { verified: true, plan: 'premium', uid };
    }
    
    // Fallback to Firestore lookup if custom claim not set
    try {
      const db = admin.default.firestore();
      const userDoc = await db.collection('users').doc(uid).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        const firestorePlan = userData?.plan;
        if (firestorePlan === 'premium') {
          return { verified: true, plan: 'premium', uid };
        }
      }
    } catch (firestoreErr) {
      console.warn('[AUTH] Firestore lookup failed:', firestoreErr.message);
    }
    
    // Default to free if not premium
    return { verified: true, plan: 'free', uid };
  } catch (err) {
    console.warn('[AUTH] Token verification failed:', err.message);
    // Invalid token - default to free
    return { verified: false, plan: 'free', uid: null };
  }
}

// -------------------- Config --------------------
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2';
const S3_BUCKET = process.env.S3_BUCKET;

if (!S3_BUCKET) {
  // Do not throw at import-time in serverless; throw inside handler on request
  console.warn('[CREATE_MEMORY] Missing S3_BUCKET env var');
}

const s3 = new S3Client({ region: AWS_REGION });

// -------------------- Helpers --------------------
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isInt(n) {
  return Number.isInteger(n);
}

function isValidPermutation(order, n) {
  if (!Array.isArray(order) || order.length !== n) return false;
  const seen = new Array(n).fill(false);
  for (const idx of order) {
    if (!isInt(idx) || idx < 0 || idx >= n) return false;
    if (seen[idx]) return false;
    seen[idx] = true;
  }
  return true;
}

function isImageKey(key) {
  const ext = path.extname(key).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
}

function isAudioKey(key) {
  const ext = path.extname(key).toLowerCase();
  return ['.mp3', '.m4a', '.wav', '.aac', '.ogg'].includes(ext);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function streamToFile(readable, filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    readable.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

async function downloadImageFromS3(bucket, key, destPath) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!resp || !resp.Body) throw new Error(`S3 GetObject returned empty body for key=${key}`);
  await streamToFile(resp.Body, destPath);
}

async function uploadFileToS3(bucket, key, filePath, contentType) {
  const body = fs.createReadStream(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function pickFfmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function pickFfprobePath() {
  const ffmpegPath = pickFfmpegPath();
  const ffmpegDir = path.dirname(ffmpegPath);
  const ext = path.extname(ffmpegPath);
  const candidate = path.join(ffmpegDir, `ffprobe${ext}`);
  if (fs.existsSync(candidate)) return candidate;
  return process.env.FFPROBE_PATH || 'ffprobe';
}

async function ffprobeHasAudio(filePath) {
  const ffprobe = pickFfprobePath();
  try {
    const { stdout } = await run(ffprobe, [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'json',
      filePath,
    ]);
    const parsed = JSON.parse(stdout);
    const audioStreams = parsed.streams?.filter((s) => s.codec_type === 'audio') || [];
    return audioStreams.length > 0;
  } catch (err) {
    console.error(`[FFPROBE] Error checking audio: ${err.message}`);
    return false;
  }
}

function parseManifest(manifestBuf) {
  try {
    const text = manifestBuf.toString('utf-8');
    const data = JSON.parse(text);
    return {
      tracks: Array.isArray(data.tracks) ? data.tracks : [],
    };
  } catch (err) {
    console.warn('[MUSIC] Failed to parse manifest:', err.message);
    return { tracks: [] };
  }
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

async function selectMusicTrack(bucket, context = '', photoKeys = [], musicPrefix = 'music/') {
  console.log('[MUSIC] enabled=true');
  
  // Try manifest first
  const manifestKey = `${musicPrefix}manifest.json`;
  let manifestFound = false;
  let tracks = [];
  
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: manifestKey }));
    if (resp && resp.Body) {
      const chunks = [];
      for await (const chunk of resp.Body) {
        chunks.push(chunk);
      }
      const manifestBuf = Buffer.concat(chunks);
      const manifest = parseManifest(manifestBuf);
      tracks = manifest.tracks || [];
      manifestFound = true;
      console.log('[MUSIC] manifestFound=true tracks=' + tracks.length);
    }
  } catch (err) {
    console.log('[MUSIC] manifestFound=false (not found or error)');
  }
  
  // If no tracks from manifest, list S3 objects
  if (tracks.length === 0) {
    try {
      const listResp = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: musicPrefix,
        })
      );
      
      const audioKeys = (listResp.Contents || [])
        .map((obj) => obj.Key)
        .filter((key) => key && isAudioKey(key) && !key.endsWith('manifest.json'))
        .sort();
      
      tracks = audioKeys.map((key) => ({ key }));
      console.log('[MUSIC] Listed S3 objects, found ' + audioKeys.length + ' audio files');
    } catch (err) {
      console.error('[MUSIC] Failed to list S3 objects:', err.message);
    }
  }
  
  if (tracks.length === 0) {
    throw new Error('No music tracks available in S3');
  }
  
  // Select deterministically using stable hash
  const seedString = context + photoKeys.join('|');
  const seed = simpleHash(seedString);
  const index = seed % tracks.length;
  const selected = tracks[index];
  const selectedKey = selected.key || selected;
  
  console.log('[MUSIC] seed=' + seed + ' index=' + index + ' candidates=' + tracks.length + ' selectedKey=' + selectedKey);
  
  return selectedKey;
}

async function downloadMusicTrack(bucket, key, destPath) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!resp || !resp.Body) throw new Error(`S3 GetObject returned empty body for key=${key}`);
  
  const chunks = [];
  for await (const chunk of resp.Body) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  
  if (buffer.length < 50 * 1024) {
    throw new Error(`Music file too small: ${buffer.length} bytes (minimum 50KB)`);
  }
  
  fs.writeFileSync(destPath, buffer);
  console.log('[MUSIC] downloadedBytes=' + buffer.length);
  return buffer.length;
}

async function getVideoDuration(videoPath) {
  const ffprobe = pickFfprobePath();
  try {
    const { stdout } = await run(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    return parseFloat(stdout) || 0;
  } catch (err) {
    console.warn('[VIDEO] Could not determine duration:', err.message);
    return 0;
  }
}

async function ffprobeDurationSeconds(filePath) {
  const ffprobe = pickFfprobePath();
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  const { stdout } = await run(ffprobe, args);
  const v = parseFloat(String(stdout).trim());
  return Number.isFinite(v) ? v : 0;
}

async function ensureMinDurationMp4(filePath, minSeconds, { tolerance = 0.08 } = {}) {
  const actual = await ffprobeDurationSeconds(filePath);
  if (actual >= (minSeconds - tolerance)) return { padded: false, actual };

  const delta = Math.max(0, minSeconds - actual);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const tmp = path.join(dir, `${base}.padtmp.mp4`);

  // Clone last frame for `delta` seconds
  const ffmpeg = pickFfmpegPath();
  const args = [
    '-y',
    '-i', filePath,
    '-vf', `tpad=stop_mode=clone:stop_duration=${delta.toFixed(3)}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    tmp
  ];

  await run(ffmpeg, args, { logPrefix: '[FFMPEG_PAD]' });

  await fsp.rename(tmp, filePath);
  const after = await ffprobeDurationSeconds(filePath);
  return { padded: true, before: actual, after, delta };
}

async function applyFades(inputVideoPath, outputPath, duration) {
  const ffmpeg = pickFfmpegPath();
  const fadeIn = 0.6;
  const fadeOut = 0.8;
  
  // Video fade: fade in from black, fade out to black
  const videoFilter = `fade=t=in:st=0:d=${fadeIn},fade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}`;
  
  const args = [
    '-y',
    '-i', inputVideoPath,
    '-vf', videoFilter,
    '-c:v', 'libx264',
    '-c:a', 'copy', // Copy audio as-is (fades applied separately)
    outputPath,
  ];
  
  console.log('[FADE] videoFadeIn=' + fadeIn + ' videoFadeOut=' + fadeOut + ' duration=' + duration);
  const result = await run(ffmpeg, args, { env: process.env });
  return result;
}

// Logo path cache (lazy initialization)
let cachedLogoPath = null;
let logoPathChecked = false;

/**
 * Find the assets directory containing the TRACE logo
 */
function findLogoPath() {
  // Cache the result after first check
  if (logoPathChecked) {
    return cachedLogoPath;
  }
  
  const logoName = 'Trace_Logo_1K_v2_hy001.png';
  const possiblePaths = [
    path.join(__dirname, 'assets', logoName), // Check server/assets first (recommended)
    path.join(process.cwd(), 'server', 'assets', logoName),
    path.join(process.cwd(), 'assets', logoName),
    path.join(__dirname, '..', 'assets', logoName),
  ];
  
  for (const logoPath of possiblePaths) {
    if (fs.existsSync(logoPath)) {
      cachedLogoPath = logoPath;
      logoPathChecked = true;
      console.log('[ENDCAP] logoPath=', logoPath, 'exists=', true);
      return logoPath;
    }
  }
  
  logoPathChecked = true;
  cachedLogoPath = null;
  console.log('[ENDCAP] logoPath=null exists=false (checked paths:', possiblePaths.join(', '), ')');
  return null;
}

/**
 * Append cinematic end cap to video (freeze last frame → fade to black → logo overlay)
 * @param {string} inputMp4Path - Input video path
 * @param {string} outputMp4Path - Output video path (with end cap appended)
 * @returns {Promise<void>}
 */
async function appendEndCap(inputMp4Path, outputMp4Path) {
  const ffmpeg = pickFfmpegPath();
  const logoPath = findLogoPath();
  
  if (!logoPath) {
    throw new Error('TRACE logo not found in assets directory');
  }
  
  // Get video dimensions and duration
  const videoDuration = await ffprobeDurationSeconds(inputMp4Path);
  const ffprobe = pickFfprobePath();
  
  // Get video dimensions
  const { stdout: probeStdout } = await run(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    inputMp4Path,
  ]);
  const probeData = JSON.parse(probeStdout);
  const width = probeData.streams?.[0]?.width || 1920;
  const height = probeData.streams?.[0]?.height || 1080;
  
  // End cap timings:
  // - Freeze last frame: 0.75s
  // - Fade to black: 1.0s (starts at 0.75s, ends at 1.75s)
  // - Black hold with logo: 1.25s (starts at 1.75s, ends at 3.0s)
  // Total end cap duration: 3.0s
  const freezeDuration = 0.75;
  const fadeDuration = 1.0;
  const blackHoldDuration = 1.25;
  const endCapDuration = freezeDuration + fadeDuration + blackHoldDuration; // 3.0s
  
  // Audio fade out over last 2.0s of final output
  const audioFadeOutDuration = 2.0;
  const audioFadeOutStart = videoDuration + endCapDuration - audioFadeOutDuration;
  
  // Filtergraph approach:
  // Step 1: Extract last frame, freeze for 0.75s, fade to black over 1.0s (1.75s total) → [freeze_fade]
  // Step 2: Create black background with logo for 1.25s → [black_logo]
  // Step 3: Concatenate [freeze_fade] + [black_logo] → [endcap] (3.0s total)
  // Step 4: Concatenate original video + [endcap] → [vout]
  // Step 5: Apply audio fade out → [aout]
  
  const logoScale = Math.min(width, height) * 0.3; // 30% of smaller dimension
  const logoX = `(W-w)/2`; // Center X
  const logoY = `(H-h)/2`; // Center Y
  
  const filterComplex = [
    // Extract last frame, freeze for 0.75s, then fade to black over 1.0s (total 1.75s)
    `[0:v]trim=start=${Math.max(0, videoDuration - 0.01)}:end=${videoDuration},setpts=PTS-STARTPTS,loop=loop=-1:size=1:start=0,trim=duration=${freezeDuration + fadeDuration},setpts=PTS-STARTPTS,fade=t=out:st=${freezeDuration}:d=${fadeDuration}[freeze_fade]`,
    // Create black background with logo for black hold duration (1.25s)
    `color=c=black:s=${width}x${height}:d=${blackHoldDuration}[blackbg]`,
    `[1:v]scale=${logoScale}:-1:flags=lanczos[logo_scaled]`,
    `[blackbg][logo_scaled]overlay=${logoX}:${logoY}[black_logo]`,
    // Concatenate freeze+fade segment with black+logo segment to create end cap (3.0s total)
    `[freeze_fade][black_logo]concat=n=2:v=1:a=0[endcap]`,
    // Concatenate original video with end cap
    `[0:v][endcap]concat=n=2:v=1:a=0[vout]`,
    // Audio fade out over last 2.0s of final output
    `[0:a]afade=t=out:st=${audioFadeOutStart}:d=${audioFadeOutDuration}[aout]`,
  ].join(';');
  
  const args = [
    '-y',
    '-i', inputMp4Path,
    '-i', logoPath,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputMp4Path,
  ];
  
  console.log('[ENDCAP] Appending end cap: freeze=0.75s fade=1.0s black_hold=1.25s logo_overlay total=' + endCapDuration + 's');
  console.log('[ENDCAP] FFmpeg command:', ffmpeg, args.join(' '));
  await run(ffmpeg, args, { env: process.env });
  
  // Log success and verify output duration
  const outputDuration = await ffprobeDurationSeconds(outputMp4Path);
  console.log('[ENDCAP] Success! Output duration=', outputDuration.toFixed(2), 's (input was', videoDuration.toFixed(2), 's, endcap adds', endCapDuration.toFixed(2), 's)');
}

async function muxAudioVideo(videoPath, audioPath, outputPath, videoDuration) {
  const ffmpeg = pickFfmpegPath();
  
  // Audio fade parameters
  const audioFadeIn = 0.7;
  const audioFadeOut = Math.min(1.5, Math.max(0.3, videoDuration * 0.1)); // Clamp fade-out, at least 0.3s
  const audioFadeOutStart = Math.max(0, videoDuration - audioFadeOut);
  
  // Audio filter: fade in and fade out
  const audioFilter = `afade=t=in:st=0:d=${audioFadeIn},afade=t=out:st=${audioFadeOutStart}:d=${audioFadeOut}`;
  
  const args = [
    '-y',
    '-i', videoPath,
    '-stream_loop', '-1',
    '-i', audioPath,
    '-shortest',
    '-c:v', 'copy',
    '-filter:a', audioFilter,
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath,
  ];
  
  console.log('[FADE] audioFadeIn=' + audioFadeIn + ' audioFadeOut=' + audioFadeOut + ' duration=' + videoDuration);
  console.log('[MUSIC] ffmpegCmd=' + ffmpeg + ' ' + args.join(' '));
  const result = await run(ffmpeg, args, { env: process.env });
  return result;
}

// Generates a cinematic slideshow video with xfade transitions
// - scales/crops to target dimensions based on aspect ratio
// - uses cumulative xfade offsets to ensure correct timeline duration
async function renderSlideshow({
  framesDir,
  frameCount,
  outPath,
  fps = 24,
  aspectRatio = '16:9',
}) {
  const ffmpeg = pickFfmpegPath();

  // Determine output dimensions based on aspect ratio
  let width, height;
  if (aspectRatio === '1:1') {
    // Square
    width = 1080;
    height = 1080;
  } else if (aspectRatio === '9:16' || aspectRatio === 'portrait') {
    // Portrait
    width = 1080;
    height = 1920;
  } else if (aspectRatio === '2.39:1' || aspectRatio === '239:100') {
    // Ultrawide (CinemaScope)
    width = 1920;
    height = 803; // 1920 / 2.39 ≈ 803
  } else {
    // Default: 16:9 landscape
    width = 1920;
    height = 1080;
  }
  
  console.log(`[RENDER] aspectRatio=${aspectRatio} dimensions=${width}x${height} fps=${fps}`);

  // Timing calculation with deterministic filtergraph
  // N = number of images, xf = crossfade duration
  // xfade overlap model: totalDuration = N * hold + xf
  const N = frameCount;
  const xf = 0.35; // Crossfade duration in seconds
  const targetDuration = Math.max(12, Math.min(30, N * 1.7)); // 9 images -> 15.3s
  // Correct formula: hold = (targetDuration - xf) / N
  const hold = Math.max(0.9, (targetDuration - xf) / N);
  const clipDur = hold + xf; // Each clip includes overlap room for xfade
  
  // Calculate cumulative offsets for xfade transitions
  // Offset for transition i (from stream i to i+1): (i+1) * hold + i * xf
  const offsets = [];
  for (let i = 0; i < N - 1; i++) {
    const offset = (i + 1) * hold + i * xf;
    offsets.push(offset);
  }
  
  // Expected total duration (xfade overlap model: N * hold + xf)
  const expectedTotalSeconds = N * hold + xf;
  
  // Fail-loud check: prevent hold from being too long
  if (hold > 3.0) {
    throw new Error(`HOLD_TOO_LONG_BUG: hold=${hold.toFixed(2)} for N=${N} targetDuration=${targetDuration.toFixed(2)}`);
  }
  
  // Log plan
  console.log(`[PLAN] ========================================`);
  console.log(`[PLAN] RENDER_PLAN`);
  console.log(`[PLAN] N=${N} targetDurationSec=${targetDuration.toFixed(2)} holdSec=${hold.toFixed(2)} xfadeSec=${xf} clipDurSec=${clipDur.toFixed(2)}`);
  console.log(`[PLAN] expectedTotalSeconds=${expectedTotalSeconds.toFixed(2)}`);
  console.log(`[PLAN] inputCount=${N}`);
  console.log(`[PLAN] offsets=[${offsets.map(o => o.toFixed(2)).join(', ')}]`);
  console.log(`[PLAN] lastOffset=${offsets.length > 0 ? offsets[offsets.length - 1].toFixed(2) : 'N/A'}`);
  console.log(`[PLAN] ========================================`);

  // Build FFmpeg inputs (one per image)
  // Note: We use loop/trim in the filtergraph, so inputs are just regular image inputs
  const inputArgs = [];
  for (let i = 0; i < N; i++) {
    const frameNum = String(i + 1).padStart(4, '0');
    const imagePath = path.join(framesDir, `${frameNum}.jpg`);
    inputArgs.push('-i', imagePath);
  }

  // Build filtergraph: process each image, then chain xfade transitions
  const filterParts = [];
  
  // Process each input image: loop, trim, scale, crop, fps, format
  const baseFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},format=yuv420p`;
  for (let i = 0; i < N; i++) {
    filterParts.push(`[${i}:v]loop=loop=-1:size=1:start=0,trim=duration=${clipDur},setpts=PTS-STARTPTS,${baseFilter}[img${i}]`);
  }
  
  // Chain xfade transitions with cumulative offsets
  // First transition: [img0][img1]xfade=...:offset=offset0[xf0]
  // Second: [xf0][img2]xfade=...:offset=offset1[xf1]
  // etc.
  if (N === 1) {
    // Single image: no xfade needed
    filterParts.push(`[img0]trim=duration=${hold}[out]`);
  } else {
    // First xfade
    filterParts.push(`[img0][img1]xfade=transition=fade:duration=${xf}:offset=${offsets[0].toFixed(3)}[xf0]`);
    
    // Subsequent xfades (chain previous result with next image)
    for (let i = 1; i < N - 1; i++) {
      const prevLabel = i === 1 ? 'xf0' : `xf${i - 1}`;
      filterParts.push(`[${prevLabel}][img${i + 1}]xfade=transition=fade:duration=${xf}:offset=${offsets[i].toFixed(3)}[xf${i}]`);
    }
    
    // Final output label
    const finalLabel = N === 2 ? 'xf0' : `xf${N - 2}`;
    filterParts.push(`[${finalLabel}]trim=duration=${expectedTotalSeconds}[out]`);
  }
  
  const filtergraph = filterParts.join(';');
  
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    ...inputArgs,
    '-filter_complex', filtergraph,
    '-map', '[out]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    outPath,
  ];
  
  console.log(`[PLAN] FFmpeg inputCount=${N} offsets=[${offsets.map(o => o.toFixed(2)).join(',')}]`);
  console.log(`[PLAN] FFmpeg filtergraph length=${filtergraph.length} chars`);

  return run(ffmpeg, args, { env: process.env });
}

function normalizeAspectRatio(input) {
  if (!input || typeof input !== 'string') return '16:9';
  
  const normalized = input.trim().toLowerCase();
  
  // Handle common label strings
  if (normalized.includes('square') || normalized === '1:1') return '1:1';
  if (normalized.includes('portrait') || normalized === '9:16') return '9:16';
  if (normalized.includes('wide') || normalized.includes('film') || normalized === '2.39:1' || normalized === '239:100') return '2.39:1';
  if (normalized.includes('hd') || normalized === '16:9') return '16:9';
  
  // Try to parse as ratio (e.g., "16:9", "1:1", "2.39:1")
  if (/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(normalized)) {
    return input.trim(); // Return original to preserve exact format
  }
  
  // Default fallback
  return '16:9';
}

/**
 * Convert aspect ratio string (e.g., "16:9") to numeric value (e.g., 1.777)
 */
function aspectRatioToNumber(aspectRatioStr) {
  const ratioMatch = aspectRatioStr.match(/^(\d+(?:\.\d+)?)[:\/](\d+(?:\.\d+)?)$/);
  if (ratioMatch) {
    const num = parseFloat(ratioMatch[1]);
    const den = parseFloat(ratioMatch[2]);
    if (den > 0) {
      return num / den;
    }
  }
  // Default to 16:9
  return 16 / 9;
}

function normalizeFps(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(1, Math.min(60, Math.round(input)));
  }
  if (typeof input === 'string') {
    const parsed = parseFloat(input);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(60, Math.round(parsed)));
    }
  }
  return 24; // Default
}

function jsonError(res, status, error, detail, extra = {}) {
  return res.status(status).json({ error, detail, ...extra });
}

// In-memory progress tracking: Map<jobId, {percent: number, step: string, detail: string}>
const progressStore = new Map();

// Clean up old progress entries (older than 1 hour)
setInterval(() => {
  // Progress entries are cleaned up after completion, but this prevents memory leaks
  // if jobs fail silently
}, 3600000); // 1 hour

// -------------------- Main Handler --------------------
async function createMemoryRenderOnly(req, res) {
  console.log('[CREATE_MEMORY] render-only handler hit');
  try {
    if (!S3_BUCKET) {
      return jsonError(res, 500, 'server_misconfigured', 'Missing S3_BUCKET env var');
    }

    // CORS (keep simple; match your domain)
    res.setHeader('Access-Control-Allow-Origin', 'https://tracememory.store');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

    if (req.method === 'OPTIONS') return res.status(204).end();

    const {
      photoKeys,
      order,
      aspectRatio: rawAspectRatio,
      fps: rawFps,
      frameRate: rawFrameRate, // Accept both fps and frameRate for compatibility
      context = '',
      enableMusic = true,
      motionPack = 'default',
      autoReframe = true, // Default true
    } = req.body || {};
    
    // Override motionPack from req.body if provided
    const finalMotionPack = req.body?.motionPack || motionPack;

    // Comprehensive logging at handler start
    console.log('[CREATE_MEMORY] ========================================');
    console.log('[CREATE_MEMORY] BACKEND_HANDLER_START');
    console.log('[CREATE_MEMORY] received photoKeys.length =', Array.isArray(photoKeys) ? photoKeys.length : 'not-array');
    console.log('[CREATE_MEMORY] received photoKeys.first3 =', Array.isArray(photoKeys) ? photoKeys.slice(0, 3) : null);
    console.log('[CREATE_MEMORY] received photoKeys.last3 =', Array.isArray(photoKeys) ? photoKeys.slice(-3) : null);
    console.log('[CREATE_MEMORY] received aspectRatio =', rawAspectRatio);
    console.log('[CREATE_MEMORY] received fps =', rawFps);
    console.log('[CREATE_MEMORY] received frameRate =', rawFrameRate);
    console.log('[CREATE_MEMORY] received order.length =', Array.isArray(order) ? order.length : 'not-array');
    console.log('[CREATE_MEMORY] received order.first5 =', Array.isArray(order) ? order.slice(0, 5) : null);
    console.log('[CREATE_MEMORY] received order.last5 =', Array.isArray(order) ? order.slice(-5) : null);
    console.log('[CREATE_MEMORY] received context.length =', String(context || '').length);

    // Normalize aspectRatio and fps
    const aspectRatio = normalizeAspectRatio(rawAspectRatio);
    const fps = normalizeFps(rawFps || rawFrameRate);
    
    console.log('[CREATE_MEMORY] normalized aspectRatio =', aspectRatio);
    console.log('[CREATE_MEMORY] normalized fps =', fps);
    console.log('[CREATE_MEMORY] motionPack =', req.body?.motionPack);
    console.log('[CREATE_MEMORY] motionPack (final) =', finalMotionPack);
    console.log('[CREATE_MEMORY] autoReframe =', autoReframe);

    // Validate photoKeys
    if (!Array.isArray(photoKeys) || photoKeys.length < 2) {
      return jsonError(res, 400, 'invalid_request', 'photoKeys must be an array with at least 2 items');
    }
    if (!photoKeys.every(isNonEmptyString)) {
      return jsonError(res, 400, 'invalid_request', 'photoKeys must be an array of strings');
    }

    // Validate and download images
    const usableImages = [];
    const missingKeys = [];
    
    for (const key of photoKeys) {
      if (!isImageKey(key)) {
        console.warn(`[IMAGES] Skipping non-image key: ${key}`);
        missingKeys.push(key);
        continue;
      }
      
      try {
        // Test download to temp location first
        const tempPath = path.join(os.tmpdir(), `test_${Date.now()}_${path.basename(key)}`);
        await downloadImageFromS3(S3_BUCKET, key, tempPath);
        
        // Verify file exists and has content
        const stat = await fsp.stat(tempPath);
        if (stat.size > 0) {
          usableImages.push(key);
          // Clean up temp file
          await fsp.unlink(tempPath).catch(() => {});
        } else {
          missingKeys.push(key);
          await fsp.unlink(tempPath).catch(() => {});
        }
      } catch (err) {
        console.error(`[IMAGES] Failed to download ${key}:`, err.message);
        missingKeys.push(key);
        return jsonError(res, 400, 'IMAGE_DOWNLOAD_FAILED', `Failed to download image: ${key}`, {
          key,
          reason: err.message,
        });
      }
    }

    console.log(`[IMAGES] ========================================`);
    console.log(`[IMAGES] VALIDATION_COMPLETE`);
    console.log(`[IMAGES] usableImages.length = ${usableImages.length}`);
    console.log(`[IMAGES] photoKeys.length = ${photoKeys.length}`);
    
    // Enforce all images must be used - use Set for accurate comparison
    if (usableImages.length !== photoKeys.length) {
      const usableSet = new Set(usableImages);
      const missing = photoKeys.filter(k => !usableSet.has(k));
      console.error(`[IMAGES] IMAGE_VALIDATION_FAILED: requested=${photoKeys.length} usable=${usableImages.length} missing=${missing.slice(0, 5).join(', ')}`);
      return jsonError(res, 400, 'IMAGE_VALIDATION_FAILED', `Not all images could be processed: requested ${photoKeys.length}, usable ${usableImages.length}`, {
        ok: false,
        error: 'IMAGE_VALIDATION_FAILED',
        requestedImageCount: photoKeys.length,
        usableImageCount: usableImages.length,
        missingKeys: missing,
      });
    }
    
    if (missingKeys.length > 0) {
      console.log(`[IMAGES] missingKeys=${missingKeys.join(',')}`);
    }
    
    // Validate minimum image count
    if (!Array.isArray(photoKeys) || photoKeys.length < 2) {
      return jsonError(res, 400, 'NOT_ENOUGH_IMAGES', 'photoKeys must be an array with at least 2 items', {
        ok: false,
        error: 'NOT_ENOUGH_IMAGES',
        requestedImageCount: Array.isArray(photoKeys) ? photoKeys.length : 0,
      });
    }

    // Determine order
    // Build mapping from original photoKeys indices to usableImages indices
    const keyToUsableIndex = new Map();
    usableImages.forEach((key, idx) => {
      const origIdx = photoKeys.indexOf(key);
      if (origIdx >= 0) {
        keyToUsableIndex.set(origIdx, idx);
      }
    });

    let finalOrder;
    if (Array.isArray(order) && isValidPermutation(order, photoKeys.length)) {
      // Map order indices (which reference photoKeys) to usableImages indices
      finalOrder = order
        .map((origIdx) => keyToUsableIndex.get(origIdx))
        .filter((idx) => idx !== undefined);
      
      // If mapping resulted in fewer items, use default order
      if (finalOrder.length !== usableImages.length) {
        console.log(`[IMAGES] Order mapping incomplete, using default order`);
        finalOrder = Array.from({ length: usableImages.length }, (_, i) => i);
      }
    } else {
      // Storytelling order fallback: use input order (deterministic)
      console.log(`[IMAGES] order missing or invalid, using input order [0..${usableImages.length - 1}]`);
      finalOrder = Array.from({ length: usableImages.length }, (_, i) => i);
    }

    // Apply order to usable images - ensure correct indexing
    console.log(`[IMAGES] ========================================`);
    console.log(`[IMAGES] ORDER_MAPPING`);
    console.log(`[IMAGES] usableImages.length = ${usableImages.length}`);
    console.log(`[IMAGES] finalOrder.length = ${finalOrder.length}`);
    console.log(`[IMAGES] finalOrder.first5 = [${finalOrder.slice(0, 5).join(',')}]`);
    console.log(`[IMAGES] finalOrder.last5 = [${finalOrder.slice(-5).join(',')}]`);
    
    // Validate finalOrder indices are within bounds
    const invalidIndices = finalOrder.filter(idx => idx < 0 || idx >= usableImages.length);
    if (invalidIndices.length > 0) {
      console.error(`[IMAGES] ORDER_MAPPING_ERROR: invalid indices ${invalidIndices.join(', ')} for usableImages.length=${usableImages.length}`);
      return jsonError(res, 400, 'INVALID_ORDER', `Order contains invalid indices: ${invalidIndices.slice(0, 5).join(', ')}`, {
        ok: false,
        error: 'INVALID_ORDER',
        invalidIndices: invalidIndices,
        usableImageCount: usableImages.length,
      });
    }
    
    // Ensure finalOrder length matches usableImages
    if (finalOrder.length !== usableImages.length) {
      console.error(`[IMAGES] ORDER_LENGTH_MISMATCH: finalOrder.length=${finalOrder.length} !== usableImages.length=${usableImages.length}`);
      return jsonError(res, 400, 'ORDER_LENGTH_MISMATCH', `Order length ${finalOrder.length} does not match usable images ${usableImages.length}`, {
        ok: false,
        error: 'ORDER_LENGTH_MISMATCH',
        orderLength: finalOrder.length,
        usableImageCount: usableImages.length,
      });
    }
    
    const orderedKeys = finalOrder.map((idx) => usableImages[idx]);
    console.log(`[IMAGES] orderedKeys.length = ${orderedKeys.length}`);
    console.log(`[IMAGES] ========================================`);

    // fps is already normalized above, no need to validate again

    const jobId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

    const baseDir = path.join(os.tmpdir(), 'trace_jobs', jobId);
    const framesDir = path.join(baseDir, 'frames');
    const outDir = path.join(baseDir, 'out');
    await ensureDir(framesDir);
    await ensureDir(outDir);

    console.log(
      `[CREATE_MEMORY] jobId=${jobId} photoKeys=${orderedKeys.length} fps=${fps} aspect=${aspectRatio} contextLen=${String(context || '').length}`
    );

    // Download images into frames as 0001.jpg, 0002.jpg...
    for (let idx = 0; idx < orderedKeys.length; idx++) {
      const key = orderedKeys[idx];
      const frameName = String(idx + 1).padStart(4, '0') + '.jpg';
      const dest = path.join(framesDir, frameName);
      console.log(`[CREATE_MEMORY] downloading ${key} -> ${frameName}`);
      await downloadImageFromS3(S3_BUCKET, key, dest);
    }

    // Auto-reframe images: fix orientation and compute smart crops
    let renderFramesDir = framesDir;
    const reframeNeedsReview = []; // Collect images that need review
    if (autoReframe) {
      const normalizedFramesDir = path.join(framesDir, 'normalized');
      await ensureDir(normalizedFramesDir);
      const targetAspectNum = aspectRatioToNumber(aspectRatio);
      
      // Read images as buffers, create frame plans, and apply them
      for (let idx = 0; idx < orderedKeys.length; idx++) {
        const key = orderedKeys[idx];
        const frameName = String(idx + 1).padStart(4, '0') + '.jpg';
        const originalPath = path.join(framesDir, frameName);
        const normalizedPath = path.join(normalizedFramesDir, frameName);
        
        try {
          const imageBuffer = await fsp.readFile(originalPath);
          const plan = await createFramePlan(imageBuffer, targetAspectNum, {
            imageKey: key, // Use S3 key for caching
            confidenceThreshold: 0.55,
            headroomBias: 0.075,
            highConfidenceThreshold: 0.75,
          });
          
          // Collect needsReview items for response
          if (plan.needsReview) {
            reframeNeedsReview.push({
              imageKey: key,
              confidence: plan.confidence,
              reason: plan.reason,
              safeModeUsed: plan.safeModeUsed || false,
            });
          }
          
          // Log only if needsReview or confidence below threshold
          if (plan.needsReview || plan.confidence < 0.55) {
            console.log(`[AUTO-REFRAme] [${idx + 1}/${orderedKeys.length}] ${key} rotation=${plan.rotationDeg}° crop=${plan.crop.w}x${plan.crop.h} confidence=${plan.confidence.toFixed(2)} ${plan.needsReview ? '[NEEDS_REVIEW]' : ''} ${plan.safeModeUsed ? '[SAFE_MODE]' : ''}`);
          }
          
          // Apply frame plan (rotate + crop)
          const reframedBuffer = await applyFramePlan(imageBuffer, plan);
          // Write to normalized path (do not overwrite original)
          await fsp.writeFile(normalizedPath, reframedBuffer);
        } catch (err) {
          console.error(`[AUTO-REFRAme] Error processing ${key}:`, err.message);
          // Copy original to normalized path if reframing fails
          await fsp.copyFile(originalPath, normalizedPath).catch(() => {});
        }
      }
      
      // Use normalized frames directory for rendering
      renderFramesDir = normalizedFramesDir;
      
      // TEMPORARY LOGGING: Count needsReview
      console.log(`[CREATE_MEMORY] reframeNeedsReview count = ${reframeNeedsReview.length}`);
    }

    // Render silent video
    const silentMp4 = path.join(outDir, 'silent.mp4');
    console.log(`[CREATE_MEMORY] ========================================`);
    console.log(`[CREATE_MEMORY] RENDER_START`);
    console.log(`[CREATE_MEMORY] orderedKeys.length = ${orderedKeys.length}`);
    console.log(`[CREATE_MEMORY] framesDir = ${renderFramesDir}`);
    console.log(`[CREATE_MEMORY] ffmpeg start -> ${silentMp4}`);
    
    // Log motion status (currently motion is not applied in renderSlideshow)
    const motionPlanUsed = null; // Motion planning is not currently integrated
    console.log('[RENDER] motionEnabled=', Boolean(motionPlanUsed), '(motion not currently applied to frames)');
    
    await renderSlideshow({
      framesDir: renderFramesDir,
      frameCount: orderedKeys.length,
      outPath: silentMp4,
      fps,
      aspectRatio,
    });

    const silentStat = await fsp.stat(silentMp4);
    console.log(`[CREATE_MEMORY] ffmpeg done size=${silentStat.size} bytes`);
    progressStore.set(jobId, { percent: 85, step: 'rendering', detail: 'Video rendered, applying effects...' });

    // Get video duration for fades and music muxing
    let videoDuration = await getVideoDuration(silentMp4);
    console.log(`[VIDEO] Silent video duration=${videoDuration.toFixed(2)}s`);
    
    // Validate output with ffprobe (using centralized duration calculation)
    console.log(`[CREATE_MEMORY] ========================================`);
    console.log(`[CREATE_MEMORY] OUTPUT_VALIDATION_START`);
    const outputN = orderedKeys.length;
    
    // Use centralized duration calculation (defined in renderSlideshow, but recalculate here for validation)
    const outputXf = 0.35;
    const outputTargetDuration = Math.max(12, Math.min(30, outputN * 1.7));
    const outputHold = Math.max(0.9, (outputTargetDuration - outputXf) / outputN);
    const expectedTotalSeconds = outputN * outputHold + outputXf;
    const expectedMinDuration = expectedTotalSeconds - 0.5;
    
    // Calculate offsets for error reporting
    const offsets = [];
    for (let i = 0; i < outputN - 1; i++) {
      offsets.push((i + 1) * outputHold + i * outputXf);
    }
    
    // Calculate offsets for error reporting
    const offsets = [];
    for (let i = 0; i < outputN - 1; i++) {
      offsets.push((i + 1) * outputHold + i * outputXfade);
    }
    
    // Ensure minimum duration by padding if needed
    const padResult = await ensureMinDurationMp4(silentMp4, expectedMinDuration);
    console.log('[DURATION_GUARD]', { minDurationSeconds: expectedMinDuration, ...padResult });
    
    // Re-check duration after padding
    videoDuration = await getVideoDuration(silentMp4);
    
    // Log duration comparison
    console.log(`[DURATION] expected=${expectedTotalSeconds.toFixed(2)} actual=${videoDuration.toFixed(2)} images=${outputN} fps=${fps}`);
    
    // Fail if duration is too short (with small tolerance for ffprobe rounding)
    if (videoDuration < expectedMinDuration - 0.15) {
      console.error(`[CREATE_MEMORY] OUTPUT_VALIDATION_FAILED: videoDuration=${videoDuration.toFixed(2)}s < expectedMin=${expectedMinDuration.toFixed(2)}s for N=${outputN}`);
      console.error(`[CREATE_MEMORY] DURATION_TOO_SHORT: actual=${videoDuration.toFixed(2)}s target=${outputTargetDuration.toFixed(2)}s expectedTotal=${expectedTotalSeconds.toFixed(2)}s hold=${outputHold.toFixed(2)}s xfade=${outputXfade}s`);
      console.error(`[CREATE_MEMORY] offsets=[${offsets.map(o => o.toFixed(2)).join(',')}] inputCount=${outputN}`);
      return jsonError(res, 500, 'DURATION_TOO_SHORT', `Video duration ${videoDuration.toFixed(2)}s is too short for ${outputN} images (expected >= ${expectedMinDuration.toFixed(2)}s)`, {
        ok: false,
        error: 'DURATION_TOO_SHORT',
        actualDurationSec: parseFloat(videoDuration.toFixed(2)),
        targetDurationSec: parseFloat(outputTargetDuration.toFixed(2)),
        expectedTotalSeconds: parseFloat(expectedTotalSeconds.toFixed(2)),
        holdSec: parseFloat(outputHold.toFixed(2)),
        xfadeSec: outputXfade,
        offsets: offsets.map(o => parseFloat(o.toFixed(2))),
        ffmpegInputCount: outputN,
      });
    }
    
    console.log(`[CREATE_MEMORY] OUTPUT_VALIDATION_PASSED: duration=${videoDuration.toFixed(2)}s >= expectedMin=${expectedMinDuration.toFixed(2)}s`);
    console.log(`[CREATE_MEMORY] RENDER_COMPLETE`);
    console.log(`[CREATE_MEMORY] plan: imageCountUsed=${outputN} targetDurationSec=${outputTargetDuration.toFixed(2)} holdSec=${outputHold.toFixed(2)} xfadeSec=${outputXfade} expectedTotalSeconds=${expectedTotalSeconds.toFixed(2)}`);

    // Apply video fades to silent video first
    progressStore.set(jobId, { percent: 88, step: 'rendering', detail: 'Applying video effects...' });
    const videoWithFades = path.join(outDir, 'video_with_fades.mp4');
    await applyFades(silentMp4, videoWithFades, videoDuration);
    progressStore.set(jobId, { percent: 92, step: 'rendering', detail: 'Adding music...' });

    // Music muxing (with audio fades)
    let finalMp4 = videoWithFades;
    let musicKeyUsed = null;

    if (enableMusic) {
      try {
        // Select and download music
        const musicKey = await selectMusicTrack(S3_BUCKET, context, photoKeys);
        const musicPath = path.join(outDir, path.basename(musicKey));
        await downloadMusicTrack(S3_BUCKET, musicKey, musicPath);

        // Mux audio and video (with audio fades)
        finalMp4 = path.join(outDir, 'final_with_music.mp4');
        console.log('[MUSIC] Starting mux...');
        await muxAudioVideo(videoWithFades, musicPath, finalMp4, videoDuration);
        console.log('[MUSIC] Mux complete');

        // Verify audio stream exists
        const hasAudio = await ffprobeHasAudio(finalMp4);
        console.log(`[MUSIC] ffprobeAudioStreams=${hasAudio ? 1 : 0}`);

        if (!hasAudio) {
          throw new Error('Muxed video has no audio stream');
        }

        musicKeyUsed = musicKey;
        console.log('[MUSIC] Music mux successful');
      } catch (musicErr) {
        console.error('[MUSIC] Music mux failed:', musicErr.message);
        console.error('[MUSIC] ffmpegExitCode=' + (musicErr.code || 'unknown'));
        console.error('[MUSIC] stderrTail=' + (musicErr.stderr?.slice(-200) || ''));
        return jsonError(res, 500, 'MUSIC_MUX_FAILED', 'Failed to add music to video', {
          ffmpegExitCode: musicErr.code || 'unknown',
          stderrTail: musicErr.stderr?.slice(-200) || musicErr.message,
        });
      }
    }

    const finalStat = await fsp.stat(finalMp4);
    console.log(`[CREATE_MEMORY] Final video size=${finalStat.size} bytes`);

    // End cap policy enforcement (server-side, authoritative)
    // Free users: FORCED ON (no override)
    // Premium users: OPTIONAL (can disable via endCap: false)
    
    // Verify user plan from Authorization token (authoritative source)
    const authHeader = req.headers.authorization;
    const userPlanInfo = await verifyUserPlan(authHeader);
    const verifiedPlan = userPlanInfo.plan; // 'free' or 'premium' (from Firebase)
    const isPremium = verifiedPlan === 'premium';
    
    // Log client-claimed plan for debugging (not trusted for enforcement)
    const clientClaimedPlan = req.body?.plan;
    if (clientClaimedPlan && clientClaimedPlan !== verifiedPlan) {
      console.log(`[AUTH] Plan mismatch: client claimed=${clientClaimedPlan} verified=${verifiedPlan} uid=${userPlanInfo.uid || 'none'}`);
    }
    
    const requestedEndCap = req.body?.endCap; // true, false, or undefined
    
    // Determine if end cap should be enabled
    let enableEndCap;
    if (process.env.TRACE_ENDCAP === '0') {
      // Admin/debug override: disable for all
      enableEndCap = false;
      console.log('[ENDCAP] Admin override: TRACE_ENDCAP=0 (disabled for all)');
    } else if (isPremium) {
      // Premium users: end cap ON unless explicitly disabled
      enableEndCap = requestedEndCap !== false;
      console.log(`[ENDCAP] Premium user (verified): endCap=${enableEndCap} (requested=${requestedEndCap}) uid=${userPlanInfo.uid || 'none'}`);
    } else {
      // Free users: FORCED ON (ignore any endCap: false from frontend)
      enableEndCap = true;
      if (requestedEndCap === false) {
        console.log(`[ENDCAP] Free user attempted to disable end cap - ignoring (FORCED ON) uid=${userPlanInfo.uid || 'none'}`);
      } else {
        console.log(`[ENDCAP] Free user (verified): end cap FORCED ON (no override allowed) uid=${userPlanInfo.uid || 'none'}`);
      }
    }
    
    // Log end cap enablement before calling appendEndCap
    console.log('[ENDCAP] enabled=', enableEndCap, 'TRACE_ENDCAP=', process.env.TRACE_ENDCAP);
    
    if (enableEndCap) {
      try {
        const endCapMp4 = path.join(outDir, 'final_with_endcap.mp4');
        console.log('[ENDCAP] Starting end cap append...');
        await appendEndCap(finalMp4, endCapMp4);
        console.log('[ENDCAP] End cap appended successfully');
        // Replace finalMp4 with end cap version
        await fsp.rename(endCapMp4, finalMp4);
        const endCapStat = await fsp.stat(finalMp4);
        console.log(`[ENDCAP] Final video with end cap size=${endCapStat.size} bytes`);
      } catch (endCapError) {
        console.error('[ENDCAP] Failed to append end cap:', endCapError.message);
        console.error('[ENDCAP] Falling back to original video (no end cap)');
        // Continue with original finalMp4 (no end cap)
      }
    } else {
      console.log('[ENDCAP] End cap disabled (premium user opted out or admin override)');
    }

    // Upload to published
    const videoKey = `videos/published/${jobId}.mp4`;
    console.log(`[CREATE_MEMORY] ========================================`);
    console.log(`[CREATE_MEMORY] S3_UPLOAD_START`);
    console.log(`[CREATE_MEMORY] S3_BUCKET=${S3_BUCKET}`);
    console.log(`[CREATE_MEMORY] AWS_REGION=${AWS_REGION}`);
    console.log(`[CREATE_MEMORY] videoKey=${videoKey}`);
    console.log(`[CREATE_MEMORY] localFile=${finalMp4}`);
    console.log(`[CREATE_MEMORY] fileSize=${finalStat.size} bytes`);

    try {
      await uploadFileToS3(S3_BUCKET, videoKey, finalMp4, 'video/mp4');
      console.log(`[CREATE_MEMORY] S3_UPLOAD_SUCCESS key=${videoKey}`);
    } catch (uploadError) {
      console.error(`[CREATE_MEMORY] S3_UPLOAD_FAILED key=${videoKey}`);
      console.error(`[CREATE_MEMORY] uploadError=${uploadError.message || uploadError}`);
      console.error(`[CREATE_MEMORY] uploadErrorCode=${uploadError.code || 'unknown'}`);
      console.error(`[CREATE_MEMORY] uploadErrorName=${uploadError.name || 'unknown'}`);
      throw uploadError;
    }

    console.log(`[CREATE_MEMORY] ========================================`);

    // Return signed URL
    const playbackUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: videoKey }),
      { expiresIn: 60 * 30 } // 30 minutes
    );

    console.log(`[CREATE_MEMORY] uploaded OK key=${videoKey}`);

    // Enforce image count used matches usable images
    const imageCountUsed = orderedKeys.length;
    if (imageCountUsed !== usableImages.length) {
      console.error(`[CREATE_MEMORY] IMAGE_COUNT_USED_MISMATCH: imageCountUsed=${imageCountUsed} usableImages=${usableImages.length}`);
      return jsonError(res, 500, 'IMAGE_COUNT_USED_MISMATCH', `Image count mismatch: used ${imageCountUsed}, usable ${usableImages.length}`, {
        ok: false,
        error: 'IMAGE_COUNT_USED_MISMATCH',
        imageCountUsed,
        usableImageCount: usableImages.length,
        requestedImageCount: photoKeys.length,
      });
    }
    
    // Calculate final render stats for response
    const N = imageCountUsed;
    const xfade = 0.35;
    const targetDuration = Math.max(12, Math.min(30, N * 1.7));
    // Correct xfade overlap formula: hold = (targetDuration - xf) / N
    const hold = Math.max(0.9, (targetDuration - xfade) / N);
    
    // Get actual video duration if available (from final output)
    let actualDuration = null;
    try {
      const finalMp4 = path.join(outDir, 'final_with_fades.mp4');
      if (await fsp.access(finalMp4).then(() => true).catch(() => false)) {
        actualDuration = await getVideoDuration(finalMp4);
      } else {
        // Fallback to silent video duration
        actualDuration = videoDuration;
      }
    } catch (e) {
      // Ignore if we can't get duration
      actualDuration = videoDuration;
    }

    console.log(`[CREATE_MEMORY] ========================================`);
    console.log(`[CREATE_MEMORY] RESPONSE_PREP`);
    console.log(`[CREATE_MEMORY] requestedImageCount = ${photoKeys.length}`);
    console.log(`[CREATE_MEMORY] usableImageCount = ${usableImages.length}`);
    console.log(`[CREATE_MEMORY] imageCountUsed = ${imageCountUsed}`);
    console.log(`[CREATE_MEMORY] targetDurationSec = ${targetDuration.toFixed(2)}`);
    console.log(`[CREATE_MEMORY] holdSec = ${hold.toFixed(2)}`);
    console.log(`[CREATE_MEMORY] xfadeSec = ${xfade}`);
    console.log(`[CREATE_MEMORY] actualDurationSec = ${actualDuration ? actualDuration.toFixed(2) : 'null'}`);
    console.log(`[CREATE_MEMORY] ========================================`);

    // Cleanup best-effort
    fsp.rm(baseDir, { recursive: true, force: true }).catch(() => {});

    return res.status(200).json({
      ok: true,
      jobId,
      videoKey,
      playbackUrl,
      requestedImageCount: photoKeys.length,
      usableImageCount: usableImages.length,
      imageCountUsed: imageCountUsed,
      targetDurationSec: parseFloat(targetDuration.toFixed(2)),
      holdSec: parseFloat(hold.toFixed(2)),
      xfadeSec: xfade,
      actualDurationSec: actualDuration ? parseFloat(actualDuration.toFixed(2)) : null,
      missingKeys: [],
      orderUsed: finalOrder,
      musicKeyUsed: musicKeyUsed,
      aspectRatioUsed: aspectRatio,
      fpsUsed: fps,
      reframeNeedsReview: reframeNeedsReview.length > 0 ? reframeNeedsReview : undefined,
    });
  } catch (err) {
    console.error('[CREATE_MEMORY] ERROR', err?.message || err, err?.stderr || '');
    return jsonError(res, 500, 'render_failed', err?.message || 'unknown_error');
  }
}

export { createMemoryRenderOnly };
