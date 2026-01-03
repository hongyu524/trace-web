import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

// Generates a simple cinematic slideshow video
// - scales/crops to 1920x1080 or 1080x1920 based on aspect
// - uses 24fps default
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

  // Timing calculation: ensure balanced per-image durations
  // T = target film duration, N = number of images, X = crossfade duration
  const crossfade = 0.35; // Crossfade duration in seconds
  const targetDuration = Math.max(12, Math.min(18, frameCount * 1.7)); // Target 12-18s for reasonable clip counts
  const hold = Math.max(0.9, Math.min(2.2, (targetDuration / frameCount) - crossfade));
  const totalSeconds = Math.round(frameCount * hold + (frameCount - 1) * crossfade);
  
  // Sanity checks
  const timelineDiff = Math.abs(totalSeconds - targetDuration);
  if (timelineDiff > 0.5) {
    console.warn(`[PLAN] Timeline duration differs from target: totalSeconds=${totalSeconds} target=${targetDuration.toFixed(2)} diff=${timelineDiff.toFixed(2)}`);
  }
  if (hold > 2.5) {
    console.warn(`[PLAN] Hold duration exceeds safe limit: hold=${hold.toFixed(2)}`);
  }
  
  console.log(`[PLAN] N=${frameCount} T=${targetDuration.toFixed(2)} hold=${hold.toFixed(2)} xfade=${crossfade} totalSeconds=${totalSeconds}`);

  // We create an input pattern 0001.jpg, 0002.jpg...
  // Use -framerate to control image input rate; then enforce output fps
  // We also apply scale + crop to fill frame.
  const inputPattern = path.join(framesDir, '%04d.jpg');

  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `fps=${fps}`,
    `format=yuv420p`,
  ].join(',');

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    // image2 demuxer:
    '-framerate',
    String(1 / hold), // how quickly images advance (based on hold duration)
    '-i',
    inputPattern,
    '-t',
    String(totalSeconds),
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    outPath,
  ];

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
    } = req.body || {};

    console.log('[CREATE_MEMORY] received aspectRatio =', rawAspectRatio);
    console.log('[CREATE_MEMORY] received fps =', rawFps);
    console.log('[CREATE_MEMORY] received frameRate =', rawFrameRate);

    console.log('[IMAGES] receivedKeys=', Array.isArray(photoKeys) ? photoKeys.length : 'not-array');
    console.log('[IMAGES] first3Keys=', Array.isArray(photoKeys) ? photoKeys.slice(0, 3) : null);
    console.log('[IMAGES] last3Keys=', Array.isArray(photoKeys) ? photoKeys.slice(-3) : null);

    // Normalize aspectRatio and fps
    const aspectRatio = normalizeAspectRatio(rawAspectRatio);
    const fps = normalizeFps(rawFps || rawFrameRate);
    
    console.log('[CREATE_MEMORY] normalized aspectRatio =', aspectRatio);
    console.log('[CREATE_MEMORY] normalized fps =', fps);

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

    console.log(`[IMAGES] usableImages=${usableImages.length}`);
    
    // Enforce all images must be used
    if (usableImages.length !== photoKeys.length) {
      const missing = photoKeys.filter(k => !usableImages.includes(k));
      console.error(`[IMAGES] IMAGE_MISMATCH: requested=${photoKeys.length} usable=${usableImages.length} missing=${missing.slice(0, 5).join(', ')}`);
      return jsonError(res, 400, 'IMAGE_MISMATCH', `Not all images could be processed: requested ${photoKeys.length}, usable ${usableImages.length}`, {
        requestedImageCount: photoKeys.length,
        usableImageCount: usableImages.length,
        missingKeys: missing,
      });
    }
    
    if (missingKeys.length > 0) {
      console.log(`[IMAGES] missingKeys=${missingKeys.join(',')}`);
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

    // Apply order to usable images
    const orderedKeys = finalOrder.map((idx) => usableImages[idx]);

    console.log(`[IMAGES] finalOrder=[${finalOrder.join(',')}]`);

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

    // Render silent video
    const silentMp4 = path.join(outDir, 'silent.mp4');
    console.log(`[CREATE_MEMORY] ffmpeg start -> ${silentMp4}`);
    await renderSlideshow({
      framesDir,
      frameCount: orderedKeys.length,
      outPath: silentMp4,
      fps,
      aspectRatio,
    });

    const silentStat = await fsp.stat(silentMp4);
    console.log(`[CREATE_MEMORY] ffmpeg done size=${silentStat.size} bytes`);

    // Get video duration for fades and music muxing
    const videoDuration = await getVideoDuration(silentMp4);
    console.log(`[VIDEO] Silent video duration=${videoDuration.toFixed(2)}s`);

    // Apply video fades to silent video first
    const videoWithFades = path.join(outDir, 'video_with_fades.mp4');
    await applyFades(silentMp4, videoWithFades, videoDuration);

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
        imageCountUsed,
        usableImageCount: usableImages.length,
        requestedImageCount: photoKeys.length,
      });
    }

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
      missingKeys: [],
      orderUsed: finalOrder,
      musicKeyUsed: musicKeyUsed,
      aspectRatioUsed: aspectRatio,
      fpsUsed: fps,
    });
  } catch (err) {
    console.error('[CREATE_MEMORY] ERROR', err?.message || err, err?.stderr || '');
    return jsonError(res, 500, 'render_failed', err?.message || 'unknown_error');
  }
}

export { createMemoryRenderOnly };
