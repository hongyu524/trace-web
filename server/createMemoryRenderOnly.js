import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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
      // You can add CacheControl or ACL here if you use them
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
  // Your Railway logs show: Found in PATH: /usr/bin/ffmpeg
  return process.env.FFMPEG_PATH || 'ffmpeg';
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

  // Determine output dimensions
  const isPortrait = aspectRatio === '9:16' || aspectRatio === 'portrait';
  const width = isPortrait ? 1080 : 1920;
  const height = isPortrait ? 1920 : 1080;

  // Make each image last ~2.5s; you can tune this
  const secondsPerImage = 2.5;
  const totalSeconds = Math.max(3, Math.round(frameCount * secondsPerImage));

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
    String(1 / secondsPerImage), // how quickly images advance
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
      aspectRatio = '16:9',
      frameRate = 24,
      context = '',
    } = req.body || {};

    if (!Array.isArray(photoKeys) || photoKeys.length < 1) {
      return jsonError(res, 400, 'invalid_request', 'photoKeys must be a non-empty array');
    }
    if (!photoKeys.every(isNonEmptyString)) {
      return jsonError(res, 400, 'invalid_request', 'photoKeys must be an array of strings');
    }

    if (!isValidPermutation(order, photoKeys.length)) {
      return jsonError(
        res,
        400,
        'invalid_request',
        'order must be a valid permutation array matching photoKeys length'
      );
    }

    const fps = Number(frameRate);
    if (!Number.isFinite(fps) || fps < 1 || fps > 60) {
      return jsonError(res, 400, 'invalid_request', 'frameRate must be a number between 1 and 60');
    }

    // Build ordered keys
    const orderedKeys = order.map((i) => photoKeys[i]);

    const jobId =
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

    const baseDir = path.join(os.tmpdir(), 'trace_jobs', jobId);
    const framesDir = path.join(baseDir, 'frames');
    const outDir = path.join(baseDir, 'out');
    await ensureDir(framesDir);
    await ensureDir(outDir);

    console.log(
      `[CREATE_MEMORY] jobId=${jobId} photoKeys=${photoKeys.length} fps=${fps} aspect=${aspectRatio} contextLen=${String(context || '').length}`
    );

    // Download images into frames as 0001.jpg, 0002.jpg...
    for (let idx = 0; idx < orderedKeys.length; idx++) {
      const key = orderedKeys[idx];

      // Defensive: enforce drafts prefix if you want (optional)
      // if (!key.startsWith('videos/drafts/')) { ... }

      const frameName = String(idx + 1).padStart(4, '0') + '.jpg';
      const dest = path.join(framesDir, frameName);
      console.log(`[CREATE_MEMORY] downloading ${key} -> ${frameName}`);
      await downloadImageFromS3(S3_BUCKET, key, dest);
    }

    // Render
    const outMp4 = path.join(outDir, 'final.mp4');
    console.log(`[CREATE_MEMORY] ffmpeg start -> ${outMp4}`);
    await renderSlideshow({
      framesDir,
      frameCount: orderedKeys.length,
      outPath: outMp4,
      fps,
      aspectRatio,
    });

    const stat = await fsp.stat(outMp4);
    console.log(`[CREATE_MEMORY] ffmpeg done size=${stat.size} bytes`);

    // Upload to published
    const videoKey = `videos/published/${jobId}.mp4`;
    console.log(`[CREATE_MEMORY] ========================================`);
    console.log(`[CREATE_MEMORY] S3_UPLOAD_START`);
    console.log(`[CREATE_MEMORY] S3_BUCKET=${S3_BUCKET}`);
    console.log(`[CREATE_MEMORY] AWS_REGION=${AWS_REGION}`);
    console.log(`[CREATE_MEMORY] videoKey=${videoKey}`);
    console.log(`[CREATE_MEMORY] localFile=${outMp4}`);
    console.log(`[CREATE_MEMORY] fileSize=${stat.size} bytes`);
    
    try {
      await uploadFileToS3(S3_BUCKET, videoKey, outMp4, 'video/mp4');
      console.log(`[CREATE_MEMORY] S3_UPLOAD_SUCCESS key=${videoKey}`);
    } catch (uploadError) {
      console.error(`[CREATE_MEMORY] S3_UPLOAD_FAILED key=${videoKey}`);
      console.error(`[CREATE_MEMORY] uploadError=${uploadError.message || uploadError}`);
      console.error(`[CREATE_MEMORY] uploadErrorCode=${uploadError.code || 'unknown'}`);
      console.error(`[CREATE_MEMORY] uploadErrorName=${uploadError.name || 'unknown'}`);
      throw uploadError; // Re-throw to be caught by outer catch
    }
    
    console.log(`[CREATE_MEMORY] ========================================`);

    // Optional: return a short-lived signed URL so frontend can play immediately
    const playbackUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: videoKey }),
      { expiresIn: 60 * 30 } // 30 minutes
    );

    console.log(`[CREATE_MEMORY] uploaded OK key=${videoKey}`);

    // Cleanup best-effort
    fsp.rm(baseDir, { recursive: true, force: true }).catch(() => {});

    return res.status(200).json({
      ok: true,
      jobId,
      videoKey,
      playbackUrl,
    });
  } catch (err) {
    console.error('[CREATE_MEMORY] ERROR', err?.message || err, err?.stderr || '');
    return jsonError(res, 500, 'render_failed', err?.message || 'unknown_error');
  }
}

export { createMemoryRenderOnly };

