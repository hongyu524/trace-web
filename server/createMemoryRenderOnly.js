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
  const timeoutMs = opts.timeout || 240000; // Default 4 minutes, can be overridden
  const stage = opts.stage || 'unknown';
  
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    // Log BEFORE spawn
    const cmdStr = `${cmd} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
    console.log(`[PIPE] ============`);
    console.log(`[PIPE] stage=${stage} BEFORE_SPAWN`);
    console.log(`[PIPE] cmd=${cmd}`);
    console.log(`[PIPE] args=${args.length} items timeout=${timeoutMs}ms`);
    console.log(`[PIPE] fullCommand=${cmdStr}`);
    console.log(`[PIPE] ============`);
    
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    
    // Timeout handler
    const timeoutId = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      console.error(`[PIPE] ============`);
      console.error(`[PIPE] stage=${stage} TIMEOUT`);
      console.error(`[PIPE] elapsed=${elapsed}ms timeout=${timeoutMs}ms`);
      console.error(`[PIPE] cmd=${cmd}`);
      console.error(`[PIPE] ============`);
      p.kill('SIGTERM');
      // Force kill after 2 seconds if still running
      setTimeout(() => {
        try {
          if (!p.killed) {
            p.kill('SIGKILL');
          }
        } catch (e) {
          // Process already dead
        }
      }, 2000);
      const err = new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`);
      err.code = 'TIMEOUT';
      err.stage = stage;
      err.stdout = stdout;
      err.stderr = stderr;
      err.elapsed = elapsed;
      reject(err);
    }, timeoutMs);
    
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', (err) => {
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      console.error(`[PIPE] ============`);
      console.error(`[PIPE] stage=${stage} SPAWN_ERROR`);
      console.error(`[PIPE] elapsed=${elapsed}ms error=${err.message}`);
      console.error(`[PIPE] ============`);
      reject(err);
    });
    p.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      const stderrTail = stderr.slice(-500);
      
      if (code === 0) {
        console.log(`[PIPE] ============`);
        console.log(`[PIPE] stage=${stage} AFTER_EXIT (SUCCESS)`);
        console.log(`[PIPE] exitCode=${code} signal=${signal || 'null'} wallTime=${elapsed}ms`);
        console.log(`[PIPE] stdoutLength=${stdout.length} stderrLength=${stderr.length}`);
        console.log(`[PIPE] ============`);
        return resolve({ stdout, stderr });
      }
      
      // Failure case
      console.error(`[PIPE] ============`);
      console.error(`[PIPE] stage=${stage} AFTER_EXIT (FAILURE)`);
      console.error(`[PIPE] exitCode=${code} signal=${signal || 'null'} wallTime=${elapsed}ms`);
      console.error(`[PIPE] stdoutLength=${stdout.length} stderrLength=${stderr.length}`);
      console.error(`[PIPE] stderrTail=${stderrTail}`);
      console.error(`[PIPE] ============`);
      
      const err = new Error(`Command failed (${code}${signal ? `, signal=${signal}` : ''}): ${cmd} ${args.join(' ')}`);
      err.code = code;
      err.signal = signal;
      err.stdout = stdout;
      err.stderr = stderr;
      err.stage = stage;
      err.elapsed = elapsed;
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
    ], {
      timeout: 30000, // 30 seconds
      stage: 'ffprobe_has_audio'
    });
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
    ], {
      timeout: 30000, // 30 seconds
      stage: 'ffprobe_duration'
    });
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
  const { stdout } = await run(ffprobe, args, {
    timeout: 30000, // 30 seconds
    stage: 'ffprobe_duration_seconds'
  });
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
  const result = await run(ffmpeg, args, { 
    env: process.env,
    timeout: 120000, // 2 minutes for video fades
    stage: 'apply_fades'
  });
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
  const startTime = Date.now();
  const logoPath = findLogoPath();
  
  // Comprehensive fail-loud logging
  console.log('[ENDCAP] ============');
  console.log('[ENDCAP] Starting end cap append');
  console.log('[ENDCAP] inputMp4Path=', inputMp4Path);
  console.log('[ENDCAP] outputMp4Path=', outputMp4Path);
  console.log('[ENDCAP] logoPath=', logoPath);
  console.log('[ENDCAP] logoPath exists=', logoPath ? fs.existsSync(logoPath) : false);
  console.log('[ENDCAP] TRACE_ENDCAP_STRICT=', process.env.TRACE_ENDCAP_STRICT);
  console.log('[ENDCAP] ============');
  
  if (!logoPath) {
    const error = new Error('TRACE logo not found in assets directory');
    console.error('[ENDCAP] FATAL: Logo not found - checked all paths');
    if (process.env.TRACE_ENDCAP_STRICT === '1') {
      throw error;
    }
    throw error;
  }
  
  if (!fs.existsSync(logoPath)) {
    const error = new Error(`TRACE logo path exists but file not found: ${logoPath}`);
    console.error('[ENDCAP] FATAL: Logo file does not exist at path');
    if (process.env.TRACE_ENDCAP_STRICT === '1') {
      throw error;
    }
    throw error;
  }
  
  // Get video dimensions and duration
  const videoDuration = await ffprobeDurationSeconds(inputMp4Path);
  const ffprobe = pickFfprobePath();
  
  // Get video dimensions and fps
  const { stdout: probeStdout } = await run(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate',
    '-of', 'json',
    inputMp4Path,
  ], {
    timeout: 30000, // 30 seconds for probe
    stage: 'endcap_probe'
  });
  const probeData = JSON.parse(probeStdout);
  const width = probeData.streams?.[0]?.width || 1920;
  const height = probeData.streams?.[0]?.height || 1080;
  // Parse fps from r_frame_rate (e.g., "30/1" or "30000/1001")
  const rFrameRate = probeData.streams?.[0]?.r_frame_rate || '30/1';
  const [num, den] = rFrameRate.split('/').map(Number);
  const fps = den ? num / den : 30;
  
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
  
  // Calculate frame counts for efficient looping (avoid infinite loop)
  const freezeFadeFrames = Math.ceil((freezeDuration + fadeDuration) * fps);
  const freezeFrames = Math.ceil(freezeDuration * fps);
  
  // More efficient approach: extract last frame, loop with specific frame count, then fade
  // This avoids the infinite loop that causes massive frame duplication
  const filterComplex = [
    // Extract last frame, loop it for the freeze+fade duration (with exact frame count)
    `[0:v]trim=start=${Math.max(0, videoDuration - 0.01)}:end=${videoDuration},setpts=PTS-STARTPTS,loop=loop=${freezeFadeFrames}:size=1:start=0,setpts=PTS-STARTPTS,fade=t=out:st=${freezeDuration}:d=${fadeDuration}[freeze_fade]`,
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
  console.log('[ENDCAP] Output path:', outputMp4Path);
  
  try {
    await run(ffmpeg, args, { 
      env: process.env,
      timeout: 180000, // 3 minutes max for end cap
      stage: 'append_endcap'
    });
    
    // Log success and verify output duration
    const elapsed = Date.now() - startTime;
    const outputDuration = await ffprobeDurationSeconds(outputMp4Path);
    const outputStat = await fsp.stat(outputMp4Path).catch(() => null);
    const outputSize = outputStat ? outputStat.size : 0;
    
    console.log('[ENDCAP] ============');
    console.log('[ENDCAP] Success!');
    console.log('[ENDCAP] wallTime=', elapsed, 'ms');
    console.log('[ENDCAP] inputDuration=', videoDuration.toFixed(2), 's');
    console.log('[ENDCAP] outputDuration=', outputDuration.toFixed(2), 's');
    console.log('[ENDCAP] endCapDuration=', endCapDuration.toFixed(2), 's');
    console.log('[ENDCAP] outputSize=', outputSize, 'bytes');
    console.log('[ENDCAP] ============');
  } catch (endCapErr) {
    // Fail-loud logging
    const elapsed = Date.now() - startTime;
    const stderrTail = (endCapErr.stderr || endCapErr.message || '').slice(-500);
    
    console.error('[ENDCAP] ============');
    console.error('[ENDCAP] FFmpeg command FAILED');
    console.error('[ENDCAP] wallTime=', elapsed, 'ms');
    console.error('[ENDCAP] exitCode=', endCapErr.code || 'unknown');
    console.error('[ENDCAP] signal=', endCapErr.signal || 'none');
    console.error('[ENDCAP] stderr tail:', stderrTail);
    console.error('[ENDCAP] ============');
    
    // Strict mode: fail loud if enabled
    if (process.env.TRACE_ENDCAP_STRICT === '1') {
      const strictErr = new Error(`End cap failed in strict mode: ${endCapErr.message}`);
      strictErr.stderr = endCapErr.stderr;
      strictErr.code = endCapErr.code;
      throw strictErr;
    }
    
    // Otherwise, re-throw to be caught by caller
    throw endCapErr;
  }
}

async function muxAudioVideo(videoPath, audioPath, outputPath, videoDuration) {
  const ffmpeg = pickFfmpegPath();
  const startTime = Date.now();
  
  // Step 1: Detect if video has audio stream
  const hasVideoAudio = await ffprobeHasAudio(videoPath);
  console.log(`[MUSIC] Video has audio stream: ${hasVideoAudio}`);
  
  // Step 2: Get exact video duration from ffprobe (more reliable than passed value)
  const actualVideoDuration = await ffprobeDurationSeconds(videoPath);
  const durationSec = Math.max(actualVideoDuration, videoDuration);
  console.log(`[MUSIC] Video duration: ${durationSec.toFixed(3)}s (passed: ${videoDuration.toFixed(3)}s)`);
  
  // Step 3: Audio fade parameters
  const audioFadeIn = 0.7;
  const audioFadeOut = 2.0; // Fixed 2s fade out
  const audioFadeOutStart = Math.max(0, durationSec - audioFadeOut);
  
  // Step 4: Build filtergraph based on whether video has audio
  let audioFilter;
  let mapArgs;
  
  if (hasVideoAudio) {
    // Mixing case: video has audio, mix with music
    // Music chain: trim to duration, fade out
    const musicChain = `[1:a]atrim=0:${durationSec},asetpts=PTS-STARTPTS,afade=t=out:st=${audioFadeOutStart}:d=${audioFadeOut}[m]`;
    // Video audio: resample and set volume
    const videoAudioChain = `[0:a]aresample=48000,volume=1.0[v0]`;
    // Music: resample and set volume (60% for background)
    const musicResampleChain = `[m]aresample=48000,volume=0.60[m0]`;
    // Mix both
    const mixChain = `[v0][m0]amix=inputs=2:duration=first:dropout_transition=2[aout]`;
    audioFilter = `${musicChain};${videoAudioChain};${musicResampleChain};${mixChain}`;
    mapArgs = ['-map', '0:v:0', '-map', '[aout]'];
  } else {
    // No video audio: use music only
    const musicChain = `[1:a]atrim=0:${durationSec},asetpts=PTS-STARTPTS,afade=t=out:st=${audioFadeOutStart}:d=${audioFadeOut}[aout]`;
    audioFilter = musicChain;
    mapArgs = ['-map', '0:v:0', '-map', '[aout]'];
  }
  
  // Step 5: Build FFmpeg args with explicit mapping and hard duration cap
  const args = [
    '-y',
    '-i', videoPath,
    '-stream_loop', '-1', // Loop music
    '-i', audioPath,
    '-filter_complex', audioFilter,
    ...mapArgs,
    '-c:v', 'copy', // Copy video (no re-encode)
    '-c:a', 'aac',
    '-b:a', '192k',
    '-t', durationSec.toFixed(3), // HARD CAP: explicit duration limit
    '-shortest', // Secondary safety: stop when shortest stream ends
    '-movflags', '+faststart',
    outputPath,
  ];
  
  // Step 6: Log command before spawn
  const cmdStr = `${ffmpeg} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
  console.log(`[MUSIC] ============`);
  console.log(`[MUSIC] FFmpeg command (before spawn):`);
  console.log(`[MUSIC] ${cmdStr}`);
  console.log(`[MUSIC] hasVideoAudio=${hasVideoAudio} durationSec=${durationSec.toFixed(3)}`);
  console.log(`[MUSIC] audioFilter length=${audioFilter.length} chars`);
  console.log(`[MUSIC] ============`);
  
    // Step 7: Spawn FFmpeg with shorter timeout (2 minutes) for fail-fast
    try {
      const result = await run(ffmpeg, args, { 
        env: process.env,
        timeout: 120000, // 2 minutes max for fail-fast
        stage: 'add_music'
      });
    
    // Step 8: Log success with details
    const elapsed = Date.now() - startTime;
    const outputStat = await fsp.stat(outputPath).catch(() => null);
    const outputSize = outputStat ? outputStat.size : 0;
    console.log(`[MUSIC] ============`);
    console.log(`[MUSIC] FFmpeg completed successfully`);
    console.log(`[MUSIC] exitCode=0 signal=null wallTime=${elapsed}ms`);
    console.log(`[MUSIC] outputFile=${outputPath}`);
    console.log(`[MUSIC] outputSize=${outputSize} bytes`);
    console.log(`[MUSIC] ============`);
    
    return result;
  } catch (err) {
    // Step 9: Log failure with comprehensive details
    const elapsed = Date.now() - startTime;
    const outputStat = await fsp.stat(outputPath).catch(() => null);
    const outputSize = outputStat ? outputStat.size : 0;
    const stderrTail = (err.stderr || err.message || '').slice(-500);
    console.error(`[MUSIC] ============`);
    console.error(`[MUSIC] FFmpeg FAILED`);
    console.error(`[MUSIC] exitCode=${err.code || 'unknown'} signal=${err.signal || 'none'} wallTime=${elapsed}ms`);
    console.error(`[MUSIC] outputFile=${outputPath}`);
    console.error(`[MUSIC] outputSize=${outputSize} bytes`);
    console.error(`[MUSIC] stderrTail=${stderrTail}`);
    console.error(`[MUSIC] ============`);
    throw err;
  }
}

/**
 * Quintic smootherstep: jerk-limited S-curve (0..1 -> 0..1 with 0 vel/acc at ends)
 * Closer to stabilized camera motion, removes "robotic ease" feeling
 */
function smootherstep(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Clamp helper
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Build FFmpeg zoompan expression using Documentary Gimbal Move plan
 * 0.7s hard hold locked to focal point, then one move (push-in/pull-out/pan)
 * Driven by quintic smootherstep (jerk-limited)
 * @param {Object} params
 * @param {number} params.startZoom - Starting zoom (1.0 = no zoom)
 * @param {number} params.endZoom - Ending zoom
 * @param {number} params.focalX - Focal point X (normalized 0..1)
 * @param {number} params.focalY - Focal point Y (normalized 0..1)
 * @param {number} params.panOffsetX - Pan offset X (normalized -1..1)
 * @param {number} params.panOffsetY - Pan offset Y (normalized -1..1)
 * @param {number} params.holdSeconds - Hold duration in seconds (0.7s hard hold)
 * @param {number} params.frames - Number of output frames
 * @param {number} params.fps - Frame rate
 * @param {number} params.W - Output width
 * @param {number} params.H - Output height
 * @returns {string} FFmpeg zoompan filter string
 */
function buildZoompanExpr({ startZoom, endZoom, focalX, focalY, panOffsetX, panOffsetY, holdSeconds, frames, fps, W, H }) {
  // Phase split: 0.7s hard hold (absolute time), then move
  const holdFrames = Math.max(1, Math.floor(holdSeconds * fps));
  const moveFrames = frames - holdFrames;

  // Eased progress during move phase only (0..1)
  // During hold phase: progress = 0
  // During move phase: progress = smootherstep(u)
  const nMinus1 = Math.max(1, moveFrames - 1);
  const frameInMovePhase = `max(0, on - ${holdFrames})`;
  const tMoveRaw = `${frameInMovePhase} / ${nMinus1}`;
  const tMoveClamped = `min(1, max(0, ${tMoveRaw}))`;
  
  // Quintic smootherstep: t*t*t*(t*(t*6 - 15) + 10)
  // This provides jerk-limited S-curve with 0 velocity/acceleration at ends
  const smootherstepExpr = `${tMoveClamped} * ${tMoveClamped} * ${tMoveClamped} * (${tMoveClamped} * (${tMoveClamped} * 6 - 15) + 10)`;

  // Zoom curve: hold at startZoom during hold phase, then smootherstep to endZoom
  const zoomExpr = `if(lt(on, ${holdFrames}), ${startZoom}, ${startZoom} + (${endZoom} - ${startZoom}) * ${smootherstepExpr})`;

  // Focal point in pixels (normalized to image dimensions)
  // Crop focuses on focal point first - locked during hold phase
  const focalPX = `${focalX} * iw`;
  const focalPY = `${focalY} * ih`;

  // Pan offset (only applied during move phase, clamped to 1-3% of frame width)
  // Use 2% as middle ground (within 1-3% range)
  const PAN_NORM = 0.02;  // 2% of frame width (within 1-3% range)
  const panDX = `${panOffsetX} * ${PAN_NORM} * iw`;
  const panDY = `${panOffsetY} * ${PAN_NORM} * ih * 0.5`;

  // Center position: locked to focal point during hold phase (zero movement)
  // Then apply subtle drift during move phase using smootherstep
  const centerXExpr = `if(lt(on, ${holdFrames}), ${focalPX}, ${focalPX} + ${panDX} * ${smootherstepExpr})`;
  const centerYExpr = `if(lt(on, ${holdFrames}), ${focalPY}, ${focalPY} + ${panDY} * ${smootherstepExpr})`;

  // Pan X/Y: center - output/2 (zoompan expects top-left corner)
  const panXExpr = `${centerXExpr} - ow / 2`;
  const panYExpr = `${centerYExpr} - oh / 2`;

  // Build zoompan filter (no rotation)
  // zoompan=z='zoom_expr':x='panX_expr':y='panY_expr':d=frames
  return `zoompan=z='${zoomExpr}':x='${panXExpr}':y='${panYExpr}':d=${frames}`;
}

// Generates a cinematic slideshow video with xfade transitions
// - scales/crops to target dimensions based on aspect ratio
// - uses cumulative xfade offsets to ensure correct timeline duration
// - applies Phase 1 motion (Ken Burns) per segment
async function renderSlideshow({
  framesDir,
  frameCount,
  outPath,
  fps = 24,
  aspectRatio = '16:9',
  motionPack = 'default',
  motionSeed = null,
}) {
  const ffmpeg = pickFfmpegPath();

  // Determine output dimensions based on aspect ratio
  // Render at 4K (3840x2160) and downscale to 1080p with lanczos to eliminate integer stepping/jitter
  let renderWidth, renderHeight;
  let outputWidth, outputHeight;
  
  if (aspectRatio === '1:1') {
    // Square - 4K: 2160x2160, output: 1080x1080
    renderWidth = 2160;
    renderHeight = 2160;
    outputWidth = 1080;
    outputHeight = 1080;
  } else if (aspectRatio === '9:16' || aspectRatio === 'portrait') {
    // Portrait - 4K: 2160x3840, output: 1080x1920
    renderWidth = 2160;
    renderHeight = 3840;
    outputWidth = 1080;
    outputHeight = 1920;
  } else if (aspectRatio === '2.39:1' || aspectRatio === '239:100') {
    // Ultrawide (CinemaScope) - 4K: 3840x1607, output: 1920x803
    renderWidth = 3840;
    renderHeight = 1607; // 3840 / 2.39 ≈ 1607
    outputWidth = 1920;
    outputHeight = 803;
  } else {
    // Default: 16:9 landscape - 4K: 3840x2160, output: 1920x1080
    renderWidth = 3840;
    renderHeight = 2160;
    outputWidth = 1920;
    outputHeight = 1080;
  }
  
  console.log(`[RENDER] aspectRatio=${aspectRatio} renderDimensions=${renderWidth}x${renderHeight} outputDimensions=${outputWidth}x${outputHeight} fps=${fps}`);

  // Timing calculation with deterministic filtergraph
  // N = number of images, xf = crossfade duration
  // xfade overlap model: totalDuration = N * hold + xf
  const N = frameCount;
  const xf = 0.4; // Crossfade duration in seconds (increased from 0.35s for smoother transitions)
  const targetDuration = Math.max(12, Math.min(30, N * 1.7)); // 9 images -> 15.3s
  // Correct formula: hold = (targetDuration - xf) / N
  const hold = Math.max(1.0, (targetDuration - xf) / N); // Increased min hold to 1.0s for better dissolve support
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

  // Generate Phase 1 motion specs
  const { generatePhase1Motions } = await import('./motion-phase1.js');
  const motions = generatePhase1Motions({
    count: N,
    pack: motionPack,
    aspectRatio,
    fps,
    seed: motionSeed,
  });

  // Log motion summary
  const motionCounts = {};
  let maxZoomUsed = 1.0;
  let movedCount = 0;
  motions.forEach((m, idx) => {
    motionCounts[m.type] = (motionCounts[m.type] || 0) + 1;
    maxZoomUsed = Math.max(maxZoomUsed, m.startZoom, m.endZoom);
    if (m.startZoom !== 1.0 || m.endZoom !== 1.0 || Math.abs(m.panOffsetX) > 0.001 || Math.abs(m.panOffsetY) > 0.001) {
      movedCount++;
    }
  });
  console.log(`[FOCUS_THEN_MOVE] pack=${motionPack} counts=${JSON.stringify(motionCounts)} maxZoom=${maxZoomUsed.toFixed(3)} movedFrames=${movedCount}/${N}`);

  // Build filtergraph: process each image with motion, then chain xfade transitions
  const filterParts = [];
  
  // Calculate frames per segment (must match exactly for correct duration)
  const segmentFrames = Math.round(clipDur * fps);
  const xfadeFrames = Math.round(xf * fps);
  
  // Log per-segment timing for verification
  console.log(`[PLAN] clipDur=${clipDur.toFixed(3)}s segmentFrames=${segmentFrames} xfadeFrames=${xfadeFrames} hold=${hold.toFixed(3)}s xfade=${xf.toFixed(3)}s`);
  
  // Process each input image: apply Documentary Gimbal Move via zoompan at 4K, then downscale
  for (let i = 0; i < N; i++) {
    const motion = motions[i];
    
    // Scale source to base size (larger than render resolution to allow zoom)
    // Use render dimensions * maxZoom to ensure we have headroom
    const maxZoom = Math.max(motion.startZoom, motion.endZoom, 1.055);
    const baseWidth = Math.round(renderWidth * maxZoom);
    const baseHeight = Math.round(renderHeight * maxZoom);
    
    // Build zoompan expression using Documentary Gimbal Move plan (render at 4K)
    const zoompanExpr = buildZoompanExpr({
      startZoom: motion.startZoom,
      endZoom: motion.endZoom,
      focalX: motion.focalX,
      focalY: motion.focalY,
      panOffsetX: motion.panOffsetX,
      panOffsetY: motion.panOffsetY,
      holdSeconds: motion.holdSeconds,
      frames: segmentFrames,
      fps: fps,
      W: renderWidth,
      H: renderHeight,
    });
    
    // Log segment motion (sample a few)
    if (i < 3 || i >= N - 1) {
      console.log(`[DOC_GIMBAL] seg#${i} type=${motion.type} zoom ${motion.startZoom.toFixed(3)}→${motion.endZoom.toFixed(3)} focal=(${motion.focalX.toFixed(2)},${motion.focalY.toFixed(2)}) pan=(${motion.panOffsetX.toFixed(3)},${motion.panOffsetY.toFixed(3)}) hold=${motion.holdSeconds}s duration=${clipDur.toFixed(2)}s`);
    }
    
    // Process image: scale to base, apply zoompan motion at 4K (no rotation), downscale to output with lanczos, set fps and format
    // Note: zoompan outputs exactly 'd' frames, so we don't need loop/trim
    // Use lanczos downscaling to eliminate integer stepping/jitter
    filterParts.push(
      `[${i}:v]scale=${baseWidth}:${baseHeight}:force_original_aspect_ratio=increase,` +
      `${zoompanExpr},` +
      `scale=${outputWidth}:${outputHeight}:flags=lanczos,` +
      `fps=${fps},` +
      `format=yuv420p[img${i}]`
    );
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

  return run(ffmpeg, args, { 
    env: process.env,
    timeout: 300000, // 5 minutes for video rendering
    stage: 'render_slideshow'
  });
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
  const handlerStartTime = Date.now();
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
    
    // Phase 1 motion is enabled by default (can be disabled via motionPack='none' in future)
    const motionEnabled = finalMotionPack !== 'none';
    console.log('[RENDER] motionEnabled=', motionEnabled, 'motionPack=', finalMotionPack);
    
    // Generate seed for deterministic motion (use jobId hash)
    const motionSeed = jobId;
    
    const renderStartTime = Date.now();
    console.log(`[PIPE] stage=render_slideshow start jobId=${jobId}`);
    try {
      await renderSlideshow({
        framesDir: renderFramesDir,
        frameCount: orderedKeys.length,
        outPath: silentMp4,
        fps,
        aspectRatio,
        motionPack: finalMotionPack,
        motionSeed,
      });
      const renderElapsed = Date.now() - renderStartTime;
      console.log(`[PIPE] stage=render_slideshow done ms=${renderElapsed} jobId=${jobId}`);
    } catch (renderErr) {
      const renderElapsed = Date.now() - renderStartTime;
      console.error(`[PIPE] stage=render_slideshow fail ms=${renderElapsed} jobId=${jobId} error=${renderErr.message}`);
      throw renderErr;
    }

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
    const outputXf = 0.4; // Match renderSlideshow xfade duration
    const outputTargetDuration = Math.max(12, Math.min(30, outputN * 1.7));
    const outputHold = Math.max(1.0, (outputTargetDuration - outputXf) / outputN); // Match renderSlideshow min hold
    const expectedTotalSeconds = outputN * outputHold + outputXf;
    const expectedMinDuration = expectedTotalSeconds - 0.5;
    
    // Calculate offsets for error reporting
    const offsets = [];
    for (let i = 0; i < outputN - 1; i++) {
      offsets.push((i + 1) * outputHold + i * outputXf);
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
      console.error(`[CREATE_MEMORY] DURATION_TOO_SHORT: actual=${videoDuration.toFixed(2)}s target=${outputTargetDuration.toFixed(2)}s expectedTotal=${expectedTotalSeconds.toFixed(2)}s hold=${outputHold.toFixed(2)}s xfade=${outputXf}s`);
      console.error(`[CREATE_MEMORY] offsets=[${offsets.map(o => o.toFixed(2)).join(',')}] inputCount=${outputN}`);
      return jsonError(res, 500, 'DURATION_TOO_SHORT', `Video duration ${videoDuration.toFixed(2)}s is too short for ${outputN} images (expected >= ${expectedMinDuration.toFixed(2)}s)`, {
        ok: false,
        error: 'DURATION_TOO_SHORT',
        actualDurationSec: parseFloat(videoDuration.toFixed(2)),
        targetDurationSec: parseFloat(outputTargetDuration.toFixed(2)),
        expectedTotalSeconds: parseFloat(expectedTotalSeconds.toFixed(2)),
        holdSec: parseFloat(outputHold.toFixed(2)),
        xfadeSec: outputXf,
        offsets: offsets.map(o => parseFloat(o.toFixed(2))),
        ffmpegInputCount: outputN,
      });
    }
    
    console.log(`[CREATE_MEMORY] OUTPUT_VALIDATION_PASSED: duration=${videoDuration.toFixed(2)}s >= expectedMin=${expectedMinDuration.toFixed(2)}s`);
    console.log(`[CREATE_MEMORY] RENDER_COMPLETE`);
    console.log(`[CREATE_MEMORY] plan: imageCountUsed=${outputN} targetDurationSec=${outputTargetDuration.toFixed(2)} holdSec=${outputHold.toFixed(2)} xfadeSec=${outputXf} expectedTotalSeconds=${expectedTotalSeconds.toFixed(2)}`);

    // Apply video fades to silent video first
    progressStore.set(jobId, { percent: 88, step: 'rendering', detail: 'Applying video effects...' });
    const videoWithFades = path.join(outDir, 'video_with_fades.mp4');
    const fadeStartTime = Date.now();
    console.log(`[PIPE] stage=apply_fades start jobId=${jobId}`);
    try {
      await applyFades(silentMp4, videoWithFades, videoDuration);
      const fadeElapsed = Date.now() - fadeStartTime;
      console.log(`[PIPE] stage=apply_fades done ms=${fadeElapsed} jobId=${jobId}`);
    } catch (fadeErr) {
      const fadeElapsed = Date.now() - fadeStartTime;
      console.error(`[PIPE] stage=apply_fades fail ms=${fadeElapsed} jobId=${jobId} error=${fadeErr.message}`);
      throw fadeErr;
    }
    
    // Music muxing stage
    progressStore.set(jobId, { percent: 92, step: 'rendering', detail: 'Adding music...' });

    // Music muxing (with audio fades)
    let finalMp4 = videoWithFades;
    let musicKeyUsed = null;

    if (enableMusic) {
      const musicStartTime = Date.now();
      console.log(`[PIPE] stage=add_music start jobId=${jobId} videoDur=${videoDuration.toFixed(3)}`);
      try {
        // Select and download music
        const musicKey = await selectMusicTrack(S3_BUCKET, context, photoKeys);
        const musicPath = path.join(outDir, path.basename(musicKey));
        await downloadMusicTrack(S3_BUCKET, musicKey, musicPath);

        // Mux audio and video (with audio fades)
        finalMp4 = path.join(outDir, 'final_with_music.mp4');
        console.log(`[MUSIC] Starting mux... videoDur=${videoDuration.toFixed(3)} track=${musicKey}`);
        progressStore.set(jobId, { percent: 94, step: 'rendering', detail: 'Muxing audio and video...' });
        await muxAudioVideo(videoWithFades, musicPath, finalMp4, videoDuration);
        console.log(`[PIPE] stage=add_music done out=${finalMp4}`);
        console.log('[MUSIC] Mux complete');
        progressStore.set(jobId, { percent: 96, step: 'rendering', detail: 'Music added successfully...' });

        // Verify audio stream exists
        const hasAudio = await ffprobeHasAudio(finalMp4);
        console.log(`[MUSIC] ffprobeAudioStreams=${hasAudio ? 1 : 0}`);

        if (!hasAudio) {
          throw new Error('Muxed video has no audio stream');
        }

        musicKeyUsed = musicKey;
        const musicElapsed = Date.now() - musicStartTime;
        console.log(`[PIPE] stage=add_music done ms=${musicElapsed} jobId=${jobId} musicKey=${musicKey}`);
      } catch (musicErr) {
        const musicElapsed = Date.now() - musicStartTime;
        console.error(`[PIPE] stage=add_music fail ms=${musicElapsed} jobId=${jobId} code=${musicErr.code || 'unknown'} signal=${musicErr.signal || 'none'} stderrTail=${(musicErr.stderr?.slice(-200) || musicErr.message).slice(-200)}`);
        console.error('[MUSIC] Music mux failed:', musicErr.message);
        console.error('[MUSIC] ffmpegExitCode=' + (musicErr.code || 'unknown'));
        console.error('[MUSIC] stderrTail=' + (musicErr.stderr?.slice(-200) || ''));
        console.error('[MUSIC] Falling back to video without music');
        // Fallback: continue without music (use videoWithFades as finalMp4)
        finalMp4 = videoWithFades;
        musicKeyUsed = null;
        // Don't fail the whole job, just proceed without music
      }
    } else {
      console.log(`[PIPE] stage=add_music skipped (music disabled) jobId=${jobId}`);
    }

    const finalStat = await fsp.stat(finalMp4);
    console.log(`[CREATE_MEMORY] Final video size=${finalStat.size} bytes`);

    // End cap removed completely - was causing issues and pausing at 95%
    console.log('[ENDCAP] End cap completely removed from pipeline');

    // Upload to published
    progressStore.set(jobId, { percent: 99, step: 'rendering', detail: 'Uploading final video...' });
    const videoKey = `videos/published/${jobId}.mp4`;
    console.log(`[CREATE_MEMORY] ========================================`);
    console.log(`[CREATE_MEMORY] S3_UPLOAD_START`);
    console.log(`[CREATE_MEMORY] S3_BUCKET=${S3_BUCKET}`);
    console.log(`[CREATE_MEMORY] AWS_REGION=${AWS_REGION}`);
    console.log(`[CREATE_MEMORY] videoKey=${videoKey}`);
    console.log(`[CREATE_MEMORY] localFile=${finalMp4}`);
    console.log(`[CREATE_MEMORY] fileSize=${finalStat.size} bytes`);

    const uploadStartTime = Date.now();
    console.log(`[PIPE] stage=s3_upload start jobId=${jobId}`);
    try {
      await uploadFileToS3(S3_BUCKET, videoKey, finalMp4, 'video/mp4');
      console.log(`[CREATE_MEMORY] S3_UPLOAD_SUCCESS key=${videoKey}`);
      progressStore.set(jobId, { percent: 100, step: 'complete', detail: 'Video ready!' });
      const uploadElapsed = Date.now() - uploadStartTime;
      console.log(`[PIPE] stage=s3_upload done ms=${uploadElapsed} jobId=${jobId}`);
    } catch (uploadError) {
      const uploadElapsed = Date.now() - uploadStartTime;
      console.error(`[PIPE] stage=s3_upload fail ms=${uploadElapsed} jobId=${jobId} error=${uploadError.message}`);
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
    
    // Get actual final video duration (after all processing: music, end cap, etc.)
    let finalDurationSec = null;
    try {
      // Use the finalMp4 path (which may have end cap if enabled)
      if (await fsp.access(finalMp4).then(() => true).catch(() => false)) {
        finalDurationSec = await ffprobeDurationSeconds(finalMp4);
      } else {
        // Fallback to videoDuration
        finalDurationSec = videoDuration;
      }
    } catch (e) {
      // Ignore if we can't get duration
      finalDurationSec = videoDuration;
    }

    console.log(`[CREATE_MEMORY] ========================================`);
    console.log(`[CREATE_MEMORY] RESPONSE_PREP`);
    console.log(`[CREATE_MEMORY] requestedImageCount = ${photoKeys.length}`);
    console.log(`[CREATE_MEMORY] usableImageCount = ${usableImages.length}`);
    console.log(`[CREATE_MEMORY] imageCountUsed = ${imageCountUsed}`);
    console.log(`[CREATE_MEMORY] targetDurationSec = ${targetDuration.toFixed(2)}`);
    console.log(`[CREATE_MEMORY] holdSec = ${hold.toFixed(2)}`);
    console.log(`[CREATE_MEMORY] xfadeSec = ${xfade}`);
    console.log(`[CREATE_MEMORY] finalDurationSec = ${finalDurationSec ? finalDurationSec.toFixed(2) : 'null'}`);
    console.log(`[CREATE_MEMORY] motionPackUsed = ${finalMotionPack}`);
    console.log(`[CREATE_MEMORY] motionEnabled = ${motionEnabled}`);
    console.log(`[CREATE_MEMORY] endCapEnabled = false (removed)`);
    console.log(`[CREATE_MEMORY] musicTrackUsed = ${musicKeyUsed || 'none'}`);
    console.log(`[CREATE_MEMORY] ========================================`);

    // Cleanup best-effort
    fsp.rm(baseDir, { recursive: true, force: true }).catch(() => {});

    const responseStartTime = Date.now();
    console.log(`[PIPE] stage=response_send start jobId=${jobId}`);
    
    const responseData = {
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
      finalDurationSec: finalDurationSec ? parseFloat(finalDurationSec.toFixed(2)) : null,
      motionPackUsed: finalMotionPack,
      motionEnabled: motionEnabled,
      endCapEnabled: false,
      musicTrackUsed: musicKeyUsed || null,
      missingKeys: [],
      orderUsed: order || [],
      musicKeyUsed: musicKeyUsed,
      aspectRatioUsed: aspectRatio,
      fpsUsed: fps,
      reframeNeedsReview: reframeNeedsReview.length > 0 ? reframeNeedsReview : undefined,
    };
    
    res.status(200).json(responseData);
    const responseElapsed = Date.now() - responseStartTime;
    console.log(`[PIPE] stage=response_send done ms=${responseElapsed} jobId=${jobId}`);
  } catch (err) {
    console.error('[CREATE_MEMORY] ERROR', err?.message || err, err?.stderr || '');
    return jsonError(res, 500, 'render_failed', err?.message || 'unknown_error');
  }
}

export { createMemoryRenderOnly };
