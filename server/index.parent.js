import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { spawn, spawnSync } from 'child_process';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs, { readdirSync, statSync, existsSync, createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import OpenAI from 'openai';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getTemplate } from './templates/index.js';
import { analyzeAllImages } from './vision-analysis.js';
import { createSequencePlan } from './sequence-planning.js';
import { generateMotionPlan } from './motion-planning.js';
import { createStoryLock } from './story-lock.js';
import { ProgressReporter, PROGRESS_WEIGHTS, calculateProgress } from './progress-reporter.js';
import { signVideoPath } from './cloudfront-signer.js';
import { finalizeForWeb, ffprobeInfo } from './utils/videoFinalize.js';
import { inspectUploadedMp4 } from './utils/s3InspectMp4.js';
import { signCloudFrontUrl, buildCloudFrontUrl } from './utils/cloudfrontSign.js';

// Promisify exec for ESM-safe usage
const exec = promisify(execCb);

// Build stamp
const BUILD_STAMP = "TRACE_BUILD_2025-12-25_01";

// Startup logging
console.log('[SERVER] Booting backend...');
console.log('[SERVER] PID:', process.pid);
console.log('[BUILD]', BUILD_STAMP);

// CRITICAL: Validate OpenAI API key on startup - fail fast if missing or invalid
const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  console.error('[SERVER] FATAL ERROR: OPENAI_API_KEY environment variable is missing!');
  console.error('[SERVER] Please set OPENAI_API_KEY in your .env file.');
  console.error('[SERVER] The server cannot run without a valid OpenAI API key for vision analysis.');
  process.exit(1);
}

if (!openaiApiKey.startsWith('sk-')) {
  console.error('[SERVER] FATAL ERROR: OPENAI_API_KEY does not start with "sk-"!');
  console.error(`[SERVER] Invalid key format (starts with: ${openaiApiKey.substring(0, 10)}...)`);
  console.error('[SERVER] Please verify your API key in the .env file is correct.');
  process.exit(1);
}

// Log environment variable status (only log last 6 characters for verification)
console.log('[SERVER] OPENAI_API_KEY: loaded (last6: ...' + openaiApiKey.slice(-6) + ')');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
export { app }; // Export app so index.js can register routes
const PORT = process.env.PORT || 3001;

// Constants
const MIN_PHOTOS = 6;
const MAX_PHOTOS = 36;

// AWS S3 Configuration
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2';
const S3_BUCKET = process.env.S3_BUCKET;
if (!S3_BUCKET) {
  console.error('[SERVER] FATAL ERROR: S3_BUCKET environment variable is missing!');
  console.error('[SERVER] Please set S3_BUCKET in your .env file.');
  process.exit(1);
}
console.log('[S3] Using bucket:', S3_BUCKET);
console.log('[S3] Region:', AWS_REGION);

const s3 = new S3Client({ region: AWS_REGION });

/**
 * Health check: Verify CloudFront URL is reachable with retry/backoff
 * @param {string} signedUrl - Signed CloudFront URL to check
 * @param {string} unsignedUrl - Unsigned URL for logging
 * @param {number} maxRetries - Maximum retry attempts (default 6)
 * @returns {Promise<void>}
 */
async function healthCheckCloudFrontUrl(signedUrl, unsignedUrl, maxRetries = 6) {
  const delays = [1000, 2000, 4000, 8000, 16000, 20000]; // Exponential backoff with cap
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(signedUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000), // 5s timeout per request
      });
      
      if (response.ok || response.status === 206) {
        console.log(`[CLOUDFRONT] Health check passed (attempt ${i + 1}/${maxRetries})`);
        return;
      }
      
      console.log(`[CLOUDFRONT] Health check attempt ${i + 1}/${maxRetries}: status ${response.status}`);
    } catch (error) {
      console.log(`[CLOUDFRONT] Health check attempt ${i + 1}/${maxRetries} failed:`, error.message);
    }
    
    // Wait before next retry (except on last attempt)
    if (i < maxRetries - 1) {
      const delay = delays[i] || delays[delays.length - 1];
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // If all retries failed, log warning but don't throw (allow response to proceed)
  console.warn(`[CLOUDFRONT] Health check failed after ${maxRetries} attempts. URL may not be cached yet: ${unsignedUrl}`);
}

// Upload final video to S3 and generate signed URLs
async function uploadFinalVideoToS3(rawPath, filename, musicTrack = null) {
  const key = `videos/published/${filename}`;
  const webPath = rawPath.replace(/\.mp4$/i, '_web.mp4');

  console.log("[UPLOAD][INPUT_RAW]", rawPath);
  console.log("[UPLOAD][INPUT_WEB]", webPath);

  // Music track is already selected (story-aware selection happens before upload)
  await finalizeForWeb(rawPath, webPath, true, {
    ffmpegPath: getFfmpegPath(),
    ffprobePath: getFfprobePath(),
    musicTrack: musicTrack,
  });

  const info = await ffprobeInfo(webPath, { ffprobePath: getFfprobePath() });
  console.log("[VIDEO][WEBSAFE_OK]", info);
  
  // Clean up temporary music file if it was downloaded from S3
  if (musicTrack && musicTrack._tempFile && musicTrack.path && existsSync(musicTrack.path)) {
    try {
      fs.unlinkSync(musicTrack.path);
      console.log('[MUSIC] Cleaned up temporary music file:', musicTrack.path);
    } catch (cleanupError) {
      console.warn('[MUSIC] Failed to clean up temporary music file:', cleanupError.message);
    }
  }

  if (!existsSync(webPath)) {
    throw new Error(`Upload file does not exist at ${webPath}`);
  }

  const fileBuf = fs.readFileSync(webPath);
  const sha = crypto.createHash('sha256').update(fileBuf).digest('hex');
  console.log("[UPLOAD][USING_BYTES_FROM]", webPath);
  console.log("[UPLOAD][SHA256]", sha);
  console.log("[UPLOAD][SIZE_BYTES]", fileBuf.length);
  
  console.log("[S3] Upload start", { bucket: S3_BUCKET, region: AWS_REGION, key, localPath: webPath });
  
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: createReadStream(webPath),
        ContentType: 'video/mp4',
        ContentDisposition: 'inline',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
    console.log("[S3] Uploaded WEBSAFE bytes.", { key, localPath: webPath });
    
    // Generate signed S3 URL (24h TTL) - this is the primary playback URL
    const signedS3Url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        ResponseContentType: 'video/mp4',
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: 60 * 60 * 24 } // 24 hours
    );
    
    const s3Url = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
    const resourcePath = `/videos/published/${filename}`;
    const cdnUrl = process.env.CLOUDFRONT_DOMAIN 
      ? `https://${process.env.CLOUDFRONT_DOMAIN}${resourcePath}`
      : null;
    
    return {
      key,
      s3Url: signedS3Url, // Signed S3 URL (primary - always works)
      s3UrlUnsigned: s3Url, // Unsigned URL for reference
      resourcePath,
      cdnUrl // Optional CloudFront URL (tested in frontend)
    };
  } catch (error) {
    console.error('[S3] Upload failed:', error);
    if (error.name && error.message) {
      console.error('[S3] Error code:', error.name);
      console.error('[S3] Error message:', error.message);
    }
    throw error;
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '300mb' }));
app.use(express.urlencoded({ extended: true, limit: '300mb' }));

// Configure multer for file uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Storage is configured per-request in upload endpoint to use memoryId/index_uuid.ext
const storage = multer.memoryStorage(); // Use memory storage, then save with unique paths
// Use memory storage, then save with unique paths in upload handler
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// Serve static files from uploads and outputs directories
app.use('/uploads', express.static(uploadsDir));
app.use('/outputs', express.static(path.join(process.cwd(), 'outputs')));

// Ensure directories exist
const tmpDir = path.join(__dirname, 'tmp');
const outputsDir = path.join(process.cwd(), 'outputs');
if (!existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}
if (!existsSync(outputsDir)) {
  fs.mkdirSync(outputsDir, { recursive: true });
}

/**
 * Robust FFmpeg path detection for Windows
 * Tries multiple strategies:
 * 1. where.exe (Windows command to find executables in PATH)
 * 2. Standard PATH resolution
 * 3. WinGet installation paths (direct and recursive search)
 */
function findFfmpegPath() {
  // On Windows, try using 'where.exe' first to find ffmpeg.exe
  if (process.platform === 'win32') {
    try {
      const whereResult = spawnSync('where.exe', ['ffmpeg'], {
        stdio: 'pipe',
        windowsHide: true,
        shell: false,
      });
      
      if (whereResult.status === 0 && whereResult.stdout) {
        const output = whereResult.stdout.toString().trim();
        const lines = output.split('\n').map(l => l.trim()).filter(l => l);
        for (const ffmpegPath of lines) {
          if (ffmpegPath.endsWith('.exe')) {
            // Verify it works by running -version
            const versionResult = spawnSync(ffmpegPath, ['-version'], {
              stdio: 'ignore',
              windowsHide: true,
            });
            if (versionResult.status === 0) {
              console.log(`[FFMPEG_DETECTION] Found via where.exe: ${ffmpegPath}`);
              return ffmpegPath;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[FFMPEG_DETECTION] 'where.exe ffmpeg' failed: ${e.message}`);
      // Continue to next method
    }
  }

  // Try standard PATH (works on all platforms)
  try {
    const result = spawnSync('ffmpeg', ['-version'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32', // PATH resolution on Windows
    });
    if (result.status === 0) {
      console.log(`[FFMPEG_DETECTION] Found in PATH: ffmpeg`);
      return 'ffmpeg'; // Found in PATH
    }
  } catch (e) {
    console.warn(`[FFMPEG_DETECTION] 'ffmpeg -version' in PATH failed: ${e.message}`);
    // Continue to fallback
  }

  // Windows fallback: Try common WinGet installation paths
  if (process.platform === 'win32') {
    // First, try direct known path pattern (faster for common WinGet installs)
    if (process.env.LOCALAPPDATA) {
      const pkgPath = path.join(
        process.env.LOCALAPPDATA,
        'Microsoft',
        'WinGet',
        'Packages',
        'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe'
      );
      try {
        if (statSync(pkgPath).isDirectory()) {
          const subdirs = readdirSync(pkgPath, { withFileTypes: true });
          for (const subdir of subdirs) {
            if (subdir.isDirectory() && subdir.name.startsWith('ffmpeg-')) {
              const candidate = path.join(pkgPath, subdir.name, 'bin', 'ffmpeg.exe');
              try {
                if (statSync(candidate).isFile()) {
                  const result = spawnSync(candidate, ['-version'], {
                    stdio: 'ignore',
                    windowsHide: true,
                  });
                  if (result.status === 0) {
                    console.log(`[FFMPEG_DETECTION] Found via WinGet known path: ${candidate}`);
                    return candidate;
                  }
                }
              } catch (e) {
                // Continue to next candidate
                continue;
              }
            }
          }
        }
      } catch (e) {
        console.warn(`[FFMPEG_DETECTION] WinGet known path pattern check failed: ${e.message}`);
        // Continue to general search
      }
    }
    
    // General WinGet search: recursively search for ffmpeg.exe
    const winGetBase = process.env.LOCALAPPDATA 
      ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
      : null;
    
    if (winGetBase) {
      try {
        if (statSync(winGetBase).isDirectory()) {
          const packages = readdirSync(winGetBase, { withFileTypes: true });
          
          // Helper function to recursively search for ffmpeg.exe
          const findFfmpegInDir = (dirPath, depth = 0) => {
            if (depth > 4) return null; // Limit recursion depth
            
            try {
              const entries = readdirSync(dirPath, { withFileTypes: true });
              
              for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                if (entry.isFile() && entry.name.toLowerCase() === 'ffmpeg.exe') {
                  // Found it! Test if it works
                  try {
                    const result = spawnSync(fullPath, ['-version'], {
                      stdio: 'ignore',
                      windowsHide: true,
                    });
                    if (result.status === 0) {
                      return fullPath;
                    }
                  } catch (e) {
                    continue;
                  }
                } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                  // Recursively search subdirectories
                  const found = findFfmpegInDir(fullPath, depth + 1);
                  if (found) return found;
                }
              }
            } catch (e) {
              // Skip directories we can't read
            }
            
            return null;
          };
          
          // Search in FFmpeg-related packages
          for (const pkg of packages) {
            if (pkg.isDirectory() && (pkg.name.includes('FFmpeg') || pkg.name.includes('ffmpeg'))) {
              const pkgPath = path.join(winGetBase, pkg.name);
              
              const foundPath = findFfmpegInDir(pkgPath);
              if (foundPath) {
                console.log(`[FFMPEG_DETECTION] Found via WinGet recursive search: ${foundPath}`);
                return foundPath;
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[FFMPEG_DETECTION] WinGet base path not accessible or error: ${err.message}`);
      }
    }
  }

  return null;
}

// Store FFmpeg path globally on startup (single source of truth)
const FFMPEG_PATH = (() => {
  const resolved = findFfmpegPath();
  if (resolved) {
    console.log(`[VIDEO] Using FFMPEG at: ${resolved}`);
  }
  return resolved;
})();

function getFfmpegPath() {
  if (!FFMPEG_PATH) {
    throw new Error('FFmpeg not found. Please ensure FFmpeg is installed and in your PATH.');
  }
  return FFMPEG_PATH;
}

function getFfprobePath() {
  if (!FFMPEG_PATH) {
    throw new Error('FFmpeg not found. Please ensure FFmpeg is installed and in your PATH.');
  }
  const ext = path.extname(FFMPEG_PATH);
  const candidate = path.join(path.dirname(FFMPEG_PATH), `ffprobe${ext}`);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return 'ffprobe';
}

function isFfmpegAvailable() {
  return FFMPEG_PATH !== null;
}

/**
 * Deterministic heuristic plan (fallback when AI fails)
 * Now includes transitions between photos
 */
/**
 * Create a deterministic fallback plan when AI is unavailable
 */
function createDeterministicPlan(photos, promptText, targetSeconds = 60) {
  const photoCount = photos.length;
  
  // MODE A (default): Use ALL images
  const selected = Array.from({ length: photoCount }, (_, i) => i);
  
  // Reorder for storytelling: shuffle to create visual interest (not chronological)
  // Use deterministic shuffle based on photo count for consistency
  const order = [...selected];
  // Fisher-Yates shuffle with seed based on photo count for deterministic but varied order
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor((i * 17 + photoCount * 23) % (i + 1)); // Deterministic but varied
    [order[i], order[j]] = [order[j], order[i]];
  }
  
  console.log(`[PLANNER] Deterministic fallback: selected ALL ${selected.length} photos, reordered from [${selected.join(',')}] to [${order.join(',')}]`);
  
  // Duration allocation: auto-compute durations to fit targetSeconds
  const transitionTime = 0.8; // Default crossfade duration
  const totalTransitionTime = (order.length - 1) * transitionTime;
  const availablePhotoTime = targetSeconds - totalTransitionTime;
  const baseDurationPerPhoto = availablePhotoTime / order.length;
  
  // Clamp per-image duration: min 0.8s, max 3.0s (for short videos with many images)
  const perImage = Math.max(0.8, Math.min(3.0, baseDurationPerPhoto));
  
  // Distribute durations with slight variation by beat position
  const durations = order.map((_, idx) => {
    const position = idx / (order.length - 1); // 0.0 to 1.0
    let multiplier = 1.0;
    if (position < 0.15) {
      multiplier = 0.9; // Early (intro)
    } else if (position < 0.70) {
      multiplier = 1.0; // Middle (development)
    } else if (position < 0.90) {
      multiplier = 1.15; // Climax
    } else {
      multiplier = 0.85; // Resolve
    }
    return perImage * multiplier;
  });
  
  // Normalize to ensure total matches targetSeconds exactly
  const currentTotal = durations.reduce((sum, d) => sum + d, 0) + totalTransitionTime;
  if (Math.abs(currentTotal - targetSeconds) > 0.1) {
    const scale = (targetSeconds - totalTransitionTime) / durations.reduce((sum, d) => sum + d, 0);
    for (let i = 0; i < durations.length; i++) {
      durations[i] = Math.max(0.8, Math.min(3.0, durations[i] * scale));
    }
  }
  
  // All crossfade transitions (default)
  const transitions = Array.from({ length: order.length - 1 }, () => 'crossfade');
  
  // Simple chapter cuts: divide into 5 roughly equal sections
  const chapterSize = Math.floor(order.length / 5);
  const chapterCuts = {
    arrivalEnd: Math.max(1, chapterSize),
    recognitionEnd: Math.max(2, chapterSize * 2),
    intimacyEnd: Math.max(3, chapterSize * 3),
    pauseEnd: Math.max(4, chapterSize * 4)
  };
  
  return {
    selected,
    order,
    durations,
    transitions,
    chapterCuts,
    memoryNote: promptText ? promptText.trim() : ''
  };
}

/**
 * AI Planner endpoint: POST /api/plan-memory
 * Returns a plan with selected images, order, durations, transitions, chapter cuts, and memory note
 */
app.post('/api/plan-memory', async (req, res) => {
  try {
    const { promptText, photos } = req.body;
    
    if (!photos || !Array.isArray(photos) || photos.length < MIN_PHOTOS || photos.length > MAX_PHOTOS) {
      return res.status(400).json({
        error: `Please provide between ${MIN_PHOTOS} and ${MAX_PHOTOS} photos.`
      });
    }
    
    let plan;
    
    // Try OpenAI if API key is available
    if (process.env.OPENAI_API_KEY) {
      try {
        const apiKeySuffix = process.env.OPENAI_API_KEY.slice(-6);
        const modelName = 'gpt-4o-mini';
        const endpoint = 'chat.completions.create';
        console.log(`[OPENAI] Legacy Planner - Endpoint: ${endpoint}, Model: ${modelName}, Key (last6): ...${apiKeySuffix}`);
        
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        
        const photoMetadata = photos.map((p, idx) => ({
          index: idx,
          filename: p.filename,
          width: p.width,
          height: p.height,
          sizeBytes: p.sizeBytes || 0,
          aspectRatio: p.width / p.height
        }));
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
        
        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'system',
            content: `You are a professional video editor creating a cinematic memory video. Your task is to analyze photos and create a storytelling plan.

STORYTELLING STRUCTURE (5 chapters):
1. Arrival - wider, environmental, earlier-feeling images, slower pacing
2. Recognition - faces, people together, shared context
3. Intimacy - closer moments, candid details, slightly longer holds
4. Pause - fewer images, longest holds, emotional breathing room
5. Trace (Ending) - quiet final image, no hard closure

OUTPUT FORMAT (JSON only):
{
  "selected": [0, 1, 2, 3, ...],  // Indices of ALL photos to use (must be [0..N-1] where N = total count)
  "order": [5, 0, 3, 1, ...],     // Reordered indices for storytelling flow
  "durations": [4.2, 3.8, 5.1, ...],  // Duration in seconds for each photo (3.0-5.5s normal, 4.5-7.0s pause chapters)
  "transitions": ["crossfade", "fade_black", "dissolve", ...],  // Transition type between photos (length = order.length - 1)
  "chapterCuts": {
    "arrivalEnd": 3,      // Index in order where Arrival chapter ends
    "recognitionEnd": 7,  // Index in order where Recognition chapter ends
    "intimacyEnd": 11,    // Index in order where Intimacy chapter ends
    "pauseEnd": 14        // Index in order where Pause chapter ends
  },
  "memoryNote": "A quiet moment together..."  // Optional memory note from prompt
}

RULES:
- **CRITICAL: Use ALL photos. selected = [0, 1, 2, ..., N-1] where N = total photo count**
- **CRITICAL: Reorder photos for emotional storytelling arc. DO NOT use upload order.**
- **Reorder based on visual flow: wider shots â†’ closer shots â†’ intimate moments â†’ quiet ending**
- **Analyze image metadata (width, height, size) to infer composition and reorder accordingly**
- Total video length: ~60 seconds (auto-compute per-image durations to fit)
- Per-image durations should be calculated to fit total: base = (targetSeconds - transitions) / N, then clamp to 0.8-3.0s
- Distribute slightly by beat: early 0.9x, middle 1.0x, climax 1.15x, resolve 0.85x
- Transitions: "crossfade" (default), "fade_black" (chapter boundaries only), "dissolve" (intimate moments)
- Use fade_black sparingly (e.g., before final image)
- No repeats: each selected index appears once in order
- **The "order" array MUST be different from "selected" array - reorder for storytelling!**
- Normalize durations to hit ~75s target

Return valid JSON only, no markdown.`
          }, {
            role: 'user',
            content: `Analyze these ${photos.length} photos and create a storytelling plan${promptText ? ` with context: "${promptText}"` : ''}.

Photos metadata: ${JSON.stringify(photoMetadata)}

Create a plan that organizes images into the 5-chapter emotional arc.`
          }],
          temperature: 0.3,
          max_tokens: 500
        }, {
          signal: controller.signal  // âœ… Correct: signal passed as second argument (request options)
        });
        
        clearTimeout(timeout);
        
        const content = response.choices[0].message.content.trim();
        const jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        let fallbackReason = null;
        
        try {
          plan = JSON.parse(jsonContent);
        } catch (parseError) {
          console.error('[PLANNER] Failed to parse AI response as JSON:', parseError.message);
          fallbackReason = 'invalid JSON parse';
          throw new Error('AI returned invalid JSON response');
        }
        
        // CRITICAL: Remove any beats property before validation (AI might return it)
        if (plan && typeof plan === 'object' && plan !== null && 'beats' in plan) {
          console.warn('[PLANNER] AI returned plan with "beats" property - removing it');
          delete plan.beats;
        }
        
        // Validate and clamp plan
        try {
          plan = validateAndClampPlan(plan, photos.length, promptText);
        } catch (validationError) {
          console.error('[PLANNER] Plan validation failed:', validationError.message);
          fallbackReason = 'schema validation fail';
          throw validationError;
        }
        
        console.log('[PLANNER] ========================================');
        console.log('[PLANNER] AI plan generated successfully');
        console.log(`[PLANNER] usedPlanner: ai`);
        console.log(`[PLANNER] inputCount: ${photos.length}`);
        console.log(`[PLANNER] selectedCount: ${plan.selected.length}`);
        console.log(`[PLANNER] selected indices: [${plan.selected.join(',')}]`);
        console.log(`[PLANNER] order indices: [${plan.order.join(',')}]`);
        // Log ordered filenames using correct mapping
        const selectedFilesForLog = plan.selected.map(i => photos[i]);
        const orderedFilesForLog = plan.order.map(j => selectedFilesForLog[j]);
        console.log(`[PLANNER] Ordered filenames: [${orderedFilesForLog.map(f => f?.filename || 'unknown').join(', ')}]`);
        console.log('[PLANNER] ========================================');
        
        plan.usedPlanner = 'ai';
        
        // Additional detailed logging
        const selectedFilesForLogAdditional = plan.selected.map(i => photos[i]);
        const orderedFilesForLogAdditional = plan.order.map(j => selectedFilesForLogAdditional[j]);
        console.log("[PLANNER] usedPlanner=", plan.usedPlanner);
        console.log("[PLANNER] selected=", plan.selected);
        console.log("[PLANNER] order=", plan.order);
        console.log("[PLANNER] orderedFilenames=", orderedFilesForLogAdditional.map(f => f.originalname || f.filename));
      } catch (aiError) {
        let fallbackReason = null;
        if (aiError.name === 'AbortError') {
          fallbackReason = 'timeout';
          console.warn('[PLANNER] OpenAI request timed out, using deterministic fallback');
        } else if (aiError.message && aiError.message.includes('invalid JSON')) {
          fallbackReason = fallbackReason || 'invalid JSON parse';
          console.warn('[PLANNER] OpenAI failed, using deterministic fallback:', aiError.message);
        } else if (aiError.message && aiError.message.includes('validation')) {
          fallbackReason = fallbackReason || 'schema validation fail';
          console.warn('[PLANNER] OpenAI failed, using deterministic fallback:', aiError.message);
        } else {
          fallbackReason = fallbackReason || 'unknown error';
          console.warn('[PLANNER] OpenAI failed, using deterministic fallback:', aiError.message);
        }
        plan = createDeterministicPlan(photos, promptText);
        plan.usedPlanner = 'fallback';
        console.log("[PLANNER][FALLBACK_REASON]", fallbackReason || 'unknown error');
      }
    } else {
      console.log('[PLANNER] No OPENAI_API_KEY, using deterministic plan');
      plan = createDeterministicPlan(photos, promptText);
      plan.usedPlanner = 'fallback';
      console.log("[PLANNER][FALLBACK_REASON]", "missing key");
    }
    
    // Create safe plan copy for response (remove any legacy fields)
    const safePlan = {
      selected: plan.selected,
      order: plan.order,
      durations: plan.durations,
      transitions: plan.transitions,
      chapterCuts: plan.chapterCuts,
      memoryNote: plan.memoryNote,
      usedPlanner: plan.usedPlanner
    };
    
    res.json(safePlan);
  } catch (error) {
    console.error('[PLANNER] Error:', error);
    res.status(500).json({
      error: 'Failed to create plan',
      details: error.message
    });
  }
});

/**
 * Validate and clamp AI plan to ensure it's safe for rendering
 */
function validatePlan(plan, photoCount, promptText = '') {
  // Ensure all required fields exist
  // CRITICAL: Never access plan.beats - it doesn't exist in our contract
  if (!plan || typeof plan !== 'object' || plan === null) {
    console.warn('[VALIDATE] Plan is null or invalid, creating deterministic plan');
    return createDeterministicPlan(Array.from({ length: photoCount }, (_, i) => ({ filename: `photo_${i}.jpg`, width: 1920, height: 1080, sizeBytes: 0 })), promptText);
  }
  
  // Explicitly check for and remove any legacy beats property if it exists
  if ('beats' in plan) {
    console.warn('[VALIDATE] Plan contains legacy "beats" property - removing it');
    delete plan.beats;
  }
  
  // Validate selected indices - MODE A (default): Use ALL images
  if (!Array.isArray(plan.selected) || plan.selected.length !== photoCount) {
    console.warn('[VALIDATE] Plan selected does not include all photos, forcing all photos');
    plan.selected = Array.from({ length: photoCount }, (_, i) => i);
  }
  // Ensure all selected indices are valid and unique
  plan.selected = plan.selected.filter((idx, pos, arr) => idx >= 0 && idx < photoCount && arr.indexOf(idx) === pos);
  // If any were filtered out, fill with remaining indices
  if (plan.selected.length < photoCount) {
    const missing = Array.from({ length: photoCount }, (_, i) => i).filter(i => !plan.selected.includes(i));
    plan.selected = [...plan.selected, ...missing].slice(0, photoCount);
  }
  
  // Validate order
  if (!Array.isArray(plan.order)) {
    console.warn('[VALIDATE] plan.order is not an array, creating from selected');
    plan.order = [...plan.selected];
  }
  
  // Ensure order only contains indices from selected
  const selectedSet = new Set(plan.selected);
  const validOrder = plan.order.filter(idx => selectedSet.has(idx));
  
  // Check if order was actually reordered (not just copy of selected)
  const orderIsReordered = validOrder.length === plan.selected.length && 
    validOrder.some((idx, i) => idx !== plan.selected[i]);
  
  const hasStoryAuthority = !!(plan && (plan.storyLock || plan.sequencePlan));
  if (!hasStoryAuthority && !orderIsReordered && validOrder.length > 0) {
    console.warn('[VALIDATE] plan.order appears to match selected order - AI may not have reordered. Shuffling for variety...');
    for (let i = validOrder.length - 1; i > 0; i--) {
      const j = Math.floor((i * 17 + photoCount * 23) % (i + 1));
      [validOrder[i], validOrder[j]] = [validOrder[j], validOrder[i]];
    }
  }
  
  plan.order = validOrder;
  
  // Add any missing selected indices to the end
  plan.selected.forEach(idx => {
    if (!plan.order.includes(idx)) {
      plan.order.push(idx);
    }
  });
  
  console.log(`[VALIDATE] Final order: [${plan.order.join(',')}] (selected: [${plan.selected.join(',')}])`);
  
  const targetSeconds = 60;
  const transitionTime = 0.8;
  const totalTransitionTime = (plan.order.length - 1) * transitionTime;
  const availablePhotoTime = targetSeconds - totalTransitionTime;
  const baseDurationPerPhoto = availablePhotoTime / plan.order.length;
  
  const rhythmProfile = (plan.editRhythmProfile && typeof plan.editRhythmProfile === 'object') ? plan.editRhythmProfile : {
    avgShotLength: 3.5,
    minShotLength: 2.4,
    maxShotLength: 5.2,
    introBreath: 0.8,
    climaxCompression: 0.65,
    resolveBreath: 1.2
  };

  plan.editRhythmProfile = rhythmProfile;
  
  const effectiveMin = Math.max(0.8, Math.min(rhythmProfile.minShotLength, baseDurationPerPhoto));
  const effectiveMax = Math.max(effectiveMin, rhythmProfile.maxShotLength);
  const effectiveAvg = Math.max(effectiveMin, Math.min(rhythmProfile.avgShotLength, effectiveMax));
  
  const roleOf = (position) => {
    if (position < 0.15) return 'intro';
    if (position < 0.70) return 'development';
    if (position < 0.90) return 'climax';
    return 'resolve';
  };
  const durationFactorOf = (position) => {
    const role = roleOf(position);
    if (role === 'intro') return 1 / Math.max(0.1, rhythmProfile.introBreath);
    if (role === 'climax') return Math.max(0.1, rhythmProfile.climaxCompression);
    if (role === 'resolve') return Math.max(0.1, rhythmProfile.resolveBreath);
    return 1;
  };
  
  const beatOf = (id) => {
    const b = plan?.storyLock?.beat_of ? plan.storyLock.beat_of[String(id)] : undefined;
    return typeof b === 'string' ? b : null;
  };
  const hingeId = (plan && plan.storyLock && plan.storyLock.hinge_id !== undefined && plan.storyLock.hinge_id !== null) ? Number(plan.storyLock.hinge_id) : null;
  const desiredDurationOf = (idx) => {
    const pattern = idx % 4;
    const long = 4.4;
    const med = 3.4;
    const short = 2.6;
    const base = (pattern === 0) ? long : (pattern === 1) ? med : (pattern === 2) ? short : med;
    const id = plan.order[idx];
    const beat = beatOf(id);
    const beatFactor = beat === 'arrival' ? 1.08 : beat === 'observation' ? 1.0 : beat === 'distance' ? 1.04 : beat === 'peak' ? 0.92 : beat === 'release' ? 1.12 : 1.0;
    let d = base * beatFactor;
    if (hingeId !== null && id === hingeId) d *= 0.90;
    if (idx === 0) d = Math.max(4.0, Math.min(4.5, d));
    if (idx === plan.order.length - 1) d = Math.max(4.5, Math.min(5.5, d));
    return Math.max(effectiveMin, Math.min(effectiveMax, d));
  };

  if (!Array.isArray(plan.durations) || plan.durations.length !== plan.order.length) {
    plan.durations = plan.order.map((_, idx) => desiredDurationOf(idx));
  }
  
  plan.durations = plan.durations.map(d => Math.max(effectiveMin, Math.min(effectiveMax, d)));
  if (plan.durations.length >= 2) {
    const first = plan.durations[0];
    const last = plan.durations[plan.durations.length - 1];
    const middle = plan.durations.slice(1, -1);
    const middleSum = middle.reduce((sum, d) => sum + d, 0);
    const remaining = Math.max(0, availablePhotoTime - first - last);
    const scale = (middleSum > 0) ? (remaining / middleSum) : 1;
    for (let i = 1; i < plan.durations.length - 1; i++) {
      plan.durations[i] = Math.max(effectiveMin, Math.min(effectiveMax, plan.durations[i] * scale));
    }
  }

  for (let i = 2; i < plan.durations.length; i++) {
    const a = plan.durations[i - 2];
    const b = plan.durations[i - 1];
    const c = plan.durations[i];
    if (Math.abs(a - b) < 0.15 && Math.abs(b - c) < 0.15) {
      const bump = (i % 2 === 0) ? 0.25 : -0.25;
      plan.durations[i] = Math.max(effectiveMin, Math.min(effectiveMax, plan.durations[i] + bump));
    }
  }
  
  // Validate transitions
  if (!Array.isArray(plan.transitions) || plan.transitions.length !== plan.order.length - 1) {
    // Prefer editorial-style default: most cuts are hard cuts
    plan.transitions = Array.from({ length: plan.order.length - 1 }, () => 'hard_cut');
  }
  plan.transitions = plan.transitions.map(t => {
    if (['crossfade', 'fade_black', 'dissolve', 'hard_cut', 'match_dissolve', 'breath_hold', 'dip_to_black_micro', 'push_through'].includes(t)) {
      return t;
    }
    return 'hard_cut';
  });
  
  // Validate chapterCuts
  if (!plan.chapterCuts || typeof plan.chapterCuts !== 'object') {
    const chapterSize = Math.floor(plan.order.length / 5);
    plan.chapterCuts = {
      arrivalEnd: Math.max(1, chapterSize),
      recognitionEnd: Math.max(2, chapterSize * 2),
      intimacyEnd: Math.max(3, chapterSize * 3),
      pauseEnd: Math.max(4, chapterSize * 4)
    };
  }
  
  // Clamp chapter cuts to valid range
  const maxIndex = plan.order.length - 1;
  plan.chapterCuts.arrivalEnd = Math.max(1, Math.min(maxIndex, plan.chapterCuts.arrivalEnd || 1));
  plan.chapterCuts.recognitionEnd = Math.max(plan.chapterCuts.arrivalEnd, Math.min(maxIndex, plan.chapterCuts.recognitionEnd || maxIndex));
  plan.chapterCuts.intimacyEnd = Math.max(plan.chapterCuts.recognitionEnd, Math.min(maxIndex, plan.chapterCuts.intimacyEnd || maxIndex));
  plan.chapterCuts.pauseEnd = Math.max(plan.chapterCuts.intimacyEnd, Math.min(maxIndex, plan.chapterCuts.pauseEnd || maxIndex));
  
  // Validate memoryNote
  if (typeof plan.memoryNote !== 'string') {
    plan.memoryNote = promptText ? promptText.trim() : '';
  }
  
  return plan;
}

function getZoomDirection(fromMeta, toMeta) {
  const fromDz = (fromMeta?.endZoom ?? 1) - (fromMeta?.startZoom ?? 1);
  const toDz = (toMeta?.endZoom ?? 1) - (toMeta?.startZoom ?? 1);

  const dirOf = (dz) => {
    if (Math.abs(dz) < 0.004) return 'static';
    return dz > 0 ? 'in' : 'out';
  };

  return {
    from: dirOf(fromDz),
    to: dirOf(toDz)
  };
}

function getPanDirection(meta) {
  const px = meta?.panXPercent ?? 0;
  const py = meta?.panYPercent ?? 0;

  const dirOf = (v) => {
    if (Math.abs(v) < 0.6) return 'static';
    return v > 0 ? 'pos' : 'neg';
  };

  return {
    x: dirOf(px),
    y: dirOf(py)
  };
}

function isNearStatic(meta) {
  const dz = Math.abs((meta?.endZoom ?? 1) - (meta?.startZoom ?? 1));
  const px = Math.abs(meta?.panXPercent ?? 0);
  const py = Math.abs(meta?.panYPercent ?? 0);
  return dz < 0.004 && px < 0.6 && py < 0.6;
}

function deriveEmotionalIntensity(beatPosition) {
  if (beatPosition >= 0.70 && beatPosition < 0.90) return 'high';
  if (beatPosition >= 0.15 && beatPosition < 0.70) return 'medium';
  return 'low';
}

function secondsFromFrames(frames, fps) {
  return Math.max(0, frames / Math.max(1, fps));
}

/**
 * Editor-style, story-aware transition selector.
 * Returns a preset describing how to connect two adjacent shots.
 */
function getTransitionPreset({
  beatPosition,
  fromMotionType,
  toMotionType,
  emotionalIntensity,
  isVertical,
  fps,
  fromMeta,
  toMeta
}) {
  const zoomDir = getZoomDirection(fromMeta, toMeta);
  const panDirFrom = getPanDirection(fromMeta);
  const panDirTo = getPanDirection(toMeta);

  const panConflict =
    (panDirFrom.x !== 'static' && panDirTo.x !== 'static' && panDirFrom.x !== panDirTo.x) ||
    (panDirFrom.y !== 'static' && panDirTo.y !== 'static' && panDirFrom.y !== panDirTo.y);

  const zoomFlip = zoomDir.from !== 'static' && zoomDir.to !== 'static' && zoomDir.from !== zoomDir.to;
  const bothStatic = isNearStatic(fromMeta) && isNearStatic(toMeta);
  const zoomAlign = !zoomFlip && zoomDir.from !== 'static' && zoomDir.to !== 'static' && zoomDir.from === zoomDir.to;

  const phase =
    beatPosition < 0.15 ? 'intro' :
    beatPosition < 0.70 ? 'development' :
    beatPosition < 0.90 ? 'climax' :
    'resolve';

  const hardCut = (reason) => ({
    preset: 'hard_cut',
    xfadeType: 'cut',
    duration: 0,
    holdSeconds: 0,
    reason
  });

  const matchDissolve = (reason, frames) => ({
    preset: 'match_dissolve',
    xfadeType: 'fade',
    duration: secondsFromFrames(frames, fps),
    holdSeconds: 0,
    reason
  });

  const dipToBlackMicro = (reason, frames) => ({
    preset: 'dip_to_black_micro',
    xfadeType: 'fadeblack',
    duration: secondsFromFrames(frames, fps),
    holdSeconds: 0,
    reason
  });

  const breathHold = (reason, holdFrames) => ({
    preset: 'breath_hold',
    xfadeType: 'hold_cut',
    duration: 0,
    holdSeconds: secondsFromFrames(holdFrames, fps),
    reason
  });

  const pushThrough = (reason, frames) => ({
    preset: 'push_through',
    xfadeType: 'fade',
    duration: secondsFromFrames(frames, fps),
    holdSeconds: 0,
    reason
  });

  // Continuity guards: prioritize invisible cuts when motion conflicts.
  if (panConflict) {
    return hardCut('pan_conflict_hard_cut');
  }
  if (zoomFlip) {
    return hardCut('zoom_direction_flip_hard_cut');
  }

  // Phase-based editorial logic.
  if (phase === 'intro') {
    if (zoomAlign && emotionalIntensity !== 'high') {
      return matchDissolve('intro_match_dissolve', 6);
    }
    return hardCut('intro_hard_cut');
  }

  if (phase === 'development') {
    if (zoomAlign && (zoomDir.to === 'in') && emotionalIntensity !== 'low') {
      return pushThrough('development_push_through', 6);
    }
    if (zoomAlign && emotionalIntensity === 'low' && !isVertical) {
      return matchDissolve('development_match_dissolve', 5);
    }
    return hardCut('development_hard_cut');
  }

  if (phase === 'climax') {
    if (bothStatic) {
      return breathHold('pre_climax_static_hold', 10);
    }
    if (emotionalIntensity === 'high') {
      return breathHold('pre_climax_pause', 8);
    }
    return hardCut('climax_hard_cut');
  }

  // Resolve
  if (phase === 'resolve') {
    if (beatPosition >= 0.94) {
      return dipToBlackMicro('resolve_dip_to_black_micro', 8);
    }
    if (bothStatic) {
      return breathHold('resolve_breath_hold', 12);
    }
    return hardCut('resolve_hard_cut');
  }

  return hardCut('fallback_hard_cut');
}

/**
 * Render video from plan using template-based segments with true xfade transitions
 * @param {Object} plan - Video plan with selected, order, durations, transitions
 * @param {Object} photoPathsMap - Map of filename to absolute path
 * @param {string} outputPath - Output video path
 * @param {string} memoryId - Session ID
 * @param {Array} photos - Photo metadata array
 * @param {number} fps - Frame rate (24 or 30)
 */
async function renderFromPlan(plan, photoPathsMap, outputPath, memoryId, photos, fps = 24, outputWidth = 1920, outputHeight = 1080, progressReporter = null) {
  // #region agent log
  const logDataC1 = {location:'server/index.js:624',message:'renderFromPlan entry with dimensions',data:{outputWidth:outputWidth,outputHeight:outputHeight,fps:fps},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'};
  console.log('[DEBUG][HYPOTHESIS-C]', JSON.stringify(logDataC1, null, 2));
  fetch('http://127.0.0.1:7243/ingest/f4f24cf3-2bc7-4b8e-b302-87560292ba98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(logDataC1)}).catch(()=>{});
  // #endregion
  
  // Log output dimensions at start
  const outputRatio = outputWidth === 1920 && outputHeight === 1080 ? 'HD (16:9)' :
                      outputWidth === 1920 && outputHeight === 804 ? 'Film Wide (2.39:1)' :
                      outputWidth === 1080 && outputHeight === 1080 ? 'Square (1:1)' : 'Custom';
  console.log(`[RENDER] ========================================`);
  console.log(`[RENDER] Starting renderFromPlan`);
  console.log(`[RENDER] targetW=${outputWidth} targetH=${outputHeight} ratio=${outputRatio} fps=${fps}`);
  
  // Validate new plan format
  if (!plan || !Array.isArray(plan.selected) || !Array.isArray(plan.order) || 
      !Array.isArray(plan.durations) || !Array.isArray(plan.transitions)) {
    throw new Error('Invalid plan: must have selected, order, durations, and transitions arrays');
  }
  
  if (plan.order.length !== plan.durations.length) {
    throw new Error(`Invalid plan: order.length (${plan.order.length}) != durations.length (${plan.durations.length})`);
  }
  
  if (plan.transitions.length !== plan.order.length - 1) {
    throw new Error(`Invalid plan: transitions.length (${plan.transitions.length}) != order.length - 1 (${plan.order.length - 1})`);
  }
  
  const ffmpegPath = getFfmpegPath();
  
  // Generate unique requestId for this render
  const requestId = Date.now().toString();
  
  // Create session temp directory with requestId (use absolute path)
  const sessionTmpDir = path.resolve(tmpDir, requestId);
  
  // Force regeneration: delete temp folder entirely if it exists
  if (existsSync(sessionTmpDir)) {
    console.log(`[RENDER] Deleting existing temp directory: ${sessionTmpDir}`);
    try {
      // Recursive delete using fs.rmSync (Node 14.14.0+)
      if (fs.rmSync) {
        fs.rmSync(sessionTmpDir, { recursive: true, force: true });
      } else {
        // Fallback for older Node versions
        const deleteRecursive = (dirPath) => {
          if (existsSync(dirPath)) {
            fs.readdirSync(dirPath).forEach((file) => {
              const curPath = path.join(dirPath, file);
              if (fs.statSync(curPath).isDirectory()) {
                deleteRecursive(curPath);
              } else {
                fs.unlinkSync(curPath);
              }
            });
            fs.rmdirSync(dirPath);
          }
        };
        deleteRecursive(sessionTmpDir);
      }
      console.log(`[RENDER] Temp directory deleted successfully`);
    } catch (deleteError) {
      console.warn(`[RENDER] Failed to delete temp directory: ${deleteError.message}`);
      // Continue anyway - will overwrite files
    }
  }
  
  // Create fresh temp directory
  fs.mkdirSync(sessionTmpDir, { recursive: true });
  console.log(`[RENDER] Created temp directory: ${sessionTmpDir} (requestId: ${requestId})`);
  
  console.log(`[RENDER] Rendering plan: ${plan.order.length} photos, ${plan.transitions.length} transitions`);
  if (plan.chapterCuts) {
    console.log(`[RENDER] Chapter cuts: Arrival(${plan.chapterCuts.arrivalEnd}), Recognition(${plan.chapterCuts.recognitionEnd}), Intimacy(${plan.chapterCuts.intimacyEnd}), Pause(${plan.chapterCuts.pauseEnd})`);
  }
  
  // CRITICAL: Planner contract enforcement
  // Contract: plan.selected = indices into original upload array
  //           plan.order = indices into selected array (selected-space indices)
  //           plan.durations = durations aligned with selected array (one per selected photo)
  
  // Step 1: Validate plan structure
  if (!Array.isArray(plan.selected) || plan.selected.length === 0) {
    throw new Error(`Invalid plan: selected array is empty or missing`);
  }
  if (!Array.isArray(plan.order) || plan.order.length === 0) {
    throw new Error(`Invalid plan: order array is empty or missing`);
  }
  if (!Array.isArray(plan.durations) || plan.durations.length !== plan.selected.length) {
    throw new Error(`Invalid plan: durations.length (${plan.durations?.length || 0}) != selected.length (${plan.selected.length})`);
  }
  
  // Step 2: Get selected files from original upload array using plan.selected
  const selectedFiles = plan.selected.map(i => {
    if (i >= 0 && i < photos.length) {
      return photos[i];
    }
    throw new Error(`Invalid photo index ${i} in plan.selected (photos.length=${photos.length})`);
  });
  
  // Step 3: Validate order indices are within selected array bounds
  const invalidOrderIndices = plan.order.filter(j => j < 0 || j >= selectedFiles.length);
  if (invalidOrderIndices.length > 0) {
    throw new Error(`Invalid order indices: ${invalidOrderIndices.join(', ')} (selectedFiles.length=${selectedFiles.length})`);
  }
  
  // Step 4: Check for duplicates in order
  const orderSet = new Set(plan.order);
  if (orderSet.size !== plan.order.length) {
    throw new Error(`Invalid plan: order array contains duplicates`);
  }
  
  // Step 5: Ensure all selected indices appear in order
  const selectedSet = new Set(plan.selected);
  const orderSelectedIndices = plan.order.map(j => plan.selected[j]);
  const missingInOrder = Array.from(selectedSet).filter(idx => !orderSelectedIndices.includes(idx));
  if (missingInOrder.length > 0) {
    throw new Error(`Invalid plan: selected indices ${missingInOrder.join(', ')} missing from order`);
  }
  
  // Step 6: Get ordered files from selectedFiles using plan.order (selected-space indices)
  const orderedFiles = plan.order.map(j => {
    if (j >= 0 && j < selectedFiles.length) {
      return selectedFiles[j];
    }
    throw new Error(`Invalid selected index ${j} in plan.order (selectedFiles.length=${selectedFiles.length})`);
  });
  
  // Step 7: Get ordered durations - order[j] is index into selected array, so use plan.durations[order[j]]
  // But wait: durations is aligned with selected array, so durations[j] is duration for selected[j]
  // So for orderedFiles[i] which is selectedFiles[order[i]], the duration is durations[order[i]]
  const orderedDurations = plan.order.map(j => {
    if (j >= 0 && j < plan.durations.length) {
      return plan.durations[j];
    }
    throw new Error(`Invalid duration index ${j} in plan.order (durations.length=${plan.durations.length})`);
  });
  
  // Step 8: Validate alignment
  if (orderedFiles.length !== orderedDurations.length) {
    throw new Error(`Alignment error: orderedFiles.length (${orderedFiles.length}) != orderedDurations.length (${orderedDurations.length})`);
  }
  
  // Extract filenames for logging and path mapping
  const orderedPhotoFilenames = orderedFiles.map(f => f.filename || f.originalname);
  
  // CRITICAL: Log planner details to prove ordering is correct
  console.log(`[PLANNER] uploadedCount=${photos.length} selectedCount=${plan.selected.length} orderedCount=${plan.order.length}`);
  console.log(`[PLANNER] usedPlanner=${plan.usedPlanner || 'unknown'}`);
  console.log(`[PLANNER] selected(originalIdx)=[${plan.selected.join(',')}]`);
  console.log(`[PLANNER] order(selectedIdx)=[${plan.order.join(',')}]`);
  console.log(`[PLANNER] orderedNames=[${orderedPhotoFilenames.join(', ')}]`);
  
  // Validate counts match
  if (plan.selected.length !== photos.length) {
    throw new Error(`Plan selected count (${plan.selected.length}) != uploaded count (${photos.length}). All photos must be selected.`);
  }
  if (plan.order.length !== plan.selected.length) {
    throw new Error(`Plan order count (${plan.order.length}) != selected count (${plan.selected.length}). Order must include all selected.`);
  }
  
  // CRITICAL: Verify we're using orderedFiles, NOT original upload order
  console.log(`[RENDER] ========================================`);
  console.log(`[RENDER] Photo mapping (CRITICAL: using AI order, NOT upload order):`);
  console.log(`[RENDER]   Uploaded files: ${photos.length} total`);
  console.log(`[RENDER]   Selected indices (into uploaded): [${plan.selected.join(',')}] -> ${selectedFiles.length} files`);
  console.log(`[RENDER]   Order indices (into selected): [${plan.order.join(',')}]`);
  console.log(`[RENDER]   RENDERING ORDER (AI storytelling): [${orderedPhotoFilenames.map((f, i) => `${i}:${f}`).join(', ')}]`);
  console.log(`[RENDER]   Upload order (for comparison): [${photos.map((p, i) => `${i}:${p.filename || p.originalname || 'unknown'}`).slice(0, Math.min(10, photos.length)).join(', ')}${photos.length > 10 ? '...' : ''}]`);
  console.log(`[RENDER] ========================================`);
  
  // CRITICAL: Verify order is NOT sequential (proves AI reordered)
  const isSequential = plan.order.every((val, idx) => val === idx);
  if (isSequential && plan.usedPlanner === 'ai') {
    console.warn(`[RENDER] WARNING: AI planner returned sequential order [${plan.order.join(',')}] - this suggests AI didn't reorder!`);
  } else if (!isSequential) {
    console.log(`[RENDER] âœ“ Order is NOT sequential - AI reordering confirmed`);
  }
  
  // CRITICAL: Build photoPathsMap from orderedFiles (AI order), NOT from original uploads
  // This ensures the renderer uses the storytelling order
  const orderedPhotoPathsMap = {};
  for (let i = 0; i < orderedPhotoFilenames.length; i++) {
    const filename = orderedPhotoFilenames[i];
    const photoPath = photoPathsMap[filename];
    if (!photoPath || !existsSync(photoPath)) {
      throw new Error(`Photo not found in ordered list: ${filename} (path: ${photoPath})`);
    }
    orderedPhotoPathsMap[filename] = photoPath;
  }
  
  // Render each photo segment IN AI ORDER (orderedFiles), NOT upload order
  const segments = [];
  const segmentDurations = [];
  const segmentMotionMeta = [];
  
  // Report rendering start
  if (progressReporter) {
    progressReporter.report('rendering', PROGRESS_WEIGHTS.RENDER_SEGMENTS.start, `Starting render of ${orderedFiles.length} segments...`);
  }
  
  // CRITICAL: Loop over orderedFiles (AI storytelling order), not original photos array
  for (let i = 0; i < orderedFiles.length; i++) {
    const photoFile = orderedFiles[i]; // This is from AI order
    const photoFilename = orderedPhotoFilenames[i];
    let duration = orderedDurations[i];
    
    // Use orderedPhotoPathsMap (built from orderedFiles)
    const photoPath = orderedPhotoPathsMap[photoFilename];
    if (!photoPath || !existsSync(photoPath)) {
      throw new Error(`Photo not found: ${photoFilename} (path: ${photoPath})`);
    }
    
    // Segment filename uses loop index i (which is AI order index, not upload index)
    const segmentPath = path.resolve(sessionTmpDir, `seg_${String(i).padStart(3, '0')}.mp4`);
    // Use ken_burns template for cinematic motion (zoom + pan) with output dimensions
    // Pass photo metadata to enable vertical photo detection and special handling
    // Pass totalSegments for beat position calculation
    const photoMeta = photoFile;
    const totalSegments = orderedFiles.length;
    
    // Get motion plan data for this image (if available from 3-stage pipeline)
    let motionPlanData = null;
    if (plan.motionPlan && plan.motionPlan[i]) {
      motionPlanData = plan.motionPlan[i];
      console.log(`[SEGMENT][${i}] Using motion plan: templateName=${motionPlanData.templateName || motionPlanData.movementType}, zoomStart=${motionPlanData.zoomStart}, zoomEnd=${motionPlanData.zoomEnd}`);
    }

    if (motionPlanData && typeof motionPlanData.duration_multiplier === 'number' && Number.isFinite(motionPlanData.duration_multiplier)) {
      duration = duration * motionPlanData.duration_multiplier;
    }
    if (motionPlanData && motionPlanData.movementType === 'locked_off_hold') {
      duration = Math.max(duration, 2.8);
    }
    if (motionPlanData && motionPlanData.movementType === 'final_hold') {
      duration = Math.max(4.0, Math.min(6.0, duration));
    }
    duration = Math.max(0.8, duration);
    
    // CRITICAL: Log duration before template creation to catch wrong values
    const expectedFrames = Math.round(duration * fps);
    console.log(`[SEGMENT][${i}] Duration check: duration=${duration}s, fps=${fps}, expectedFrames=${expectedFrames}`);
    if (duration > 10) {
      console.error(`[SEGMENT][${i}] ERROR: Duration ${duration}s is too long! Should be 3-7 seconds.`);
    }
    
    const templateConfig = getTemplate('ken_burns', photoPath, duration, fps, i, outputWidth, outputHeight, photoMeta, totalSegments, motionPlanData);
    
    // Verify template calculated frames correctly
    const actualFrames = templateConfig.metadata?.totalFrames || Math.round(duration * fps);
    console.log(`[SEGMENT][${i}] Template frames: ${actualFrames} (should match ${expectedFrames})`);
    if (actualFrames > 300) {
      console.error(`[SEGMENT][${i}] ERROR: Template generated ${actualFrames} frames (${(actualFrames/fps).toFixed(1)}s) - way too long!`);
    }
    
    // #region agent log
    const logDataD3 = {location:'server/index.js:810',message:'templateConfig created for segment',data:{segmentIndex:i,outputWidth:outputWidth,outputHeight:outputHeight,templateFilterStart:templateConfig.filter.substring(0,150)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'};
    console.log('[DEBUG][HYPOTHESIS-D]', JSON.stringify(logDataD3, null, 2));
    fetch('http://127.0.0.1:7243/ingest/f4f24cf3-2bc7-4b8e-b302-87560292ba98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(logDataD3)}).catch(()=>{});
    // #endregion
    
    console.log(`[VIDEO] Rendering segment ${i + 1}/${plan.order.length} (${photoFilename}, ${duration.toFixed(2)}s, ${fps}fps, target=${outputWidth}x${outputHeight})...`);
    
    // Report segment progress (72-90% range for rendering)
    if (progressReporter) {
      const renderProgress = (i + 1) / orderedFiles.length;
      const percent = calculateProgress(PROGRESS_WEIGHTS.RENDER_SEGMENTS, renderProgress);
      progressReporter.report('rendering', percent, `Rendering segment ${i + 1}/${orderedFiles.length}`);
    }
    
    // Render segment with 2-minute timeout per segment
    const segmentStartTime = Date.now();
    try {
      await renderSegment(ffmpegPath, templateConfig, segmentPath, i, photoMeta);
      const segmentDuration = ((Date.now() - segmentStartTime) / 1000).toFixed(1);
      console.log(`[VIDEO] Segment ${i + 1} rendered in ${segmentDuration}s`);
    } catch (segmentError) {
      console.error(`[VIDEO] Segment ${i + 1} FAILED after ${((Date.now() - segmentStartTime) / 1000).toFixed(1)}s:`, segmentError.message);
      throw segmentError;
    }
    
    if (!existsSync(segmentPath)) {
      throw new Error(`Failed to create segment: ${segmentPath}`);
    }
    
    // CRITICAL: Verify segment is correct size (optional check - FFmpeg should enforce it)
    // Note: This is a sanity check, the filter chain should already enforce dimensions
    const segmentStats = fs.statSync(segmentPath);
    if (segmentStats.size === 0) {
      throw new Error(`Segment file is empty: ${segmentPath}`);
    }
    console.log(`[SEGMENT][${i}] Created: ${segmentPath} (${(segmentStats.size / 1024).toFixed(1)}KB)`);
    
    // CRITICAL: Log ordered filename that was actually rendered (proves AI order is used)
    if (i === 0) {
      console.log(`[SEGMENT][${i}] FIRST SEGMENT RENDERED FROM: ${photoFilename} (AI order index 0)`);
      console.log(`[SEGMENT][${i}] Upload order would be: ${photos[0]?.filename || photos[0]?.originalname || 'unknown'}`);
      if (photoFilename !== (photos[0]?.filename || photos[0]?.originalname)) {
        console.log(`[SEGMENT][${i}] âœ“ AI ORDER CONFIRMED: First segment is NOT first upload`);
      } else {
        console.warn(`[SEGMENT][${i}] âš  WARNING: First segment matches first upload - AI may not have reordered`);
      }
    }
    
    segments.push(segmentPath);
    segmentDurations.push(duration);
    segmentMotionMeta.push({
      index: i,
      motionType: templateConfig?.metadata?.motionType,
      startZoom: templateConfig?.metadata?.startZoom,
      endZoom: templateConfig?.metadata?.endZoom,
      panXPercent: templateConfig?.metadata?.panXPercent,
      panYPercent: templateConfig?.metadata?.panYPercent,
      isVertical: !!(photoMeta && photoMeta.height && photoMeta.width && photoMeta.height > photoMeta.width)
    });
  }
  
  // CRITICAL: Render coverage validation with missing filename list
  console.log(`[SEGMENTS] Validating render coverage: expected=${orderedFiles.length} created=${segments.length}`);
  if (segments.length !== orderedFiles.length) {
    const missing = [];
    for (let i = 0; i < orderedFiles.length; i++) {
      const expectedPath = path.resolve(sessionTmpDir, `seg_${String(i).padStart(3, '0')}.mp4`);
      if (!segments.includes(expectedPath) && !existsSync(expectedPath)) {
        missing.push({ index: i, filename: orderedPhotoFilenames[i], path: expectedPath });
      }
    }
    const missingFilenames = missing.map(m => m.filename).join(', ');
    console.error(`[VALIDATION] Render incomplete: ${segments.length}/${orderedFiles.length} segments created. Missing: ${missingFilenames}`);
    throw new Error(
      `[VALIDATION] Failed to create all segments: expected ${orderedFiles.length}, created ${segments.length}. ` +
      `Missing filenames: ${missingFilenames}`
    );
  }
  
  console.log(`[VALIDATION] Render coverage passed: ${segments.length} segments created (expected ${orderedFiles.length})`);
  
  // Log segment list for debugging
  console.log(`[SEGMENTS] All ${segments.length} segments created successfully`);
  
  const transitions = [];
  const hingeId = (plan && plan.storyLock && plan.storyLock.hinge_id !== undefined && plan.storyLock.hinge_id !== null) ? Number(plan.storyLock.hinge_id) : null;
  const editStyle = (process.env.TRACE_EDIT_STYLE || '').toLowerCase();
  const deakinsLock = editStyle === 'deakins';
  let dissolveCount = 0;
  const maxDissolves = Math.max(0, Math.floor(Math.max(0, (plan.order.length - 1)) * 0.25));
  let lastWasDissolve = false;
  for (let i = 0; i < plan.transitions.length; i++) {
    const toId = plan.order[i + 1];
    const isHingeNext = (hingeId !== null && toId === hingeId);
    const beatPosition = plan.transitions.length > 1 ? i / (plan.transitions.length - 1) : 0.5;
    const emotionalIntensity = deriveEmotionalIntensity(beatPosition);
    const fromMeta = segmentMotionMeta[i];
    const toMeta = segmentMotionMeta[i + 1];

    if (isHingeNext) {
      const holdSeconds = secondsFromFrames(8, fps);
      segmentDurations[i] += holdSeconds;
      transitions.push({
        fromIndex: i,
        toIndex: i + 1,
        type: 'hold_cut',
        duration: 0,
        holdSeconds,
        preset: 'breath_hold',
        reason: 'hinge_pre_breath'
      });
      lastWasDissolve = false;
      continue;
    }

    if (deakinsLock) {
      transitions.push({
        fromIndex: i,
        toIndex: i + 1,
        type: 'cut',
        duration: 0,
        holdSeconds: 0,
        preset: 'hard_cut',
        reason: 'hard_cut'
      });
      lastWasDissolve = false;
      continue;
    }

    const preset = getTransitionPreset({
      beatPosition,
      fromMotionType: fromMeta?.motionType,
      toMotionType: toMeta?.motionType,
      emotionalIntensity,
      isVertical: !!toMeta?.isVertical,
      fps,
      fromMeta,
      toMeta
    });

    let type = preset?.xfadeType || 'cut';
    let duration = Math.max(0, Number(preset?.duration || 0));
    const holdSeconds = Math.max(0, Number(preset?.holdSeconds || 0));

    const isDissolve = type === 'fade' || type === 'fadeblack';
    if (isDissolve && (lastWasDissolve || dissolveCount >= maxDissolves)) {
      type = 'cut';
      duration = 0;
    }
    if (isDissolve) {
      dissolveCount += 1;
      lastWasDissolve = true;
    } else {
      lastWasDissolve = false;
    }

    if (type === 'hold_cut' && holdSeconds > 0) {
      segmentDurations[i] += holdSeconds;
    }

    transitions.push({
      fromIndex: i,
      toIndex: i + 1,
      type,
      duration,
      holdSeconds,
      preset: preset?.preset || (type === 'cut' ? 'hard_cut' : 'match_dissolve'),
      reason: preset?.reason || 'auto'
    });
  }

  const heroSet = new Set(Array.isArray(plan?.storyLock?.hero_images) ? plan.storyLock.hero_images : []);
  for (let i = 0; i < plan.order.length; i++) {
    const id = plan.order[i];
    const role = heroSet.has(id) ? 'hero' : 'support';
    const motionMeta = segmentMotionMeta[i] || {};
    const template = motionMeta.motionType || 'unknown';
    const motion = (template === 'slow_pull_out') ? 'pull_out' : (template === 'slow_push_in' || template === 'hinge_push') ? 'push_in' : 'none';
    const motionEndPct = (motion === 'none') ? 1.0 : ((typeof motionMeta.settlePct === 'number' && Number.isFinite(motionMeta.settlePct)) ? motionMeta.settlePct : 0.75);
    const nextTrans = (i < transitions.length) ? transitions[i] : null;
    const hasLocalFade = nextTrans && (nextTrans.type === 'fade' || nextTrans.type === 'fadeblack');
    const cutType = (i === plan.order.length - 1) ? 'fade' : (hasLocalFade ? 'fade' : 'hard');
    console.log(`[SHOT] role=${role} motion=${motion} motionEndPct=${motionEndPct.toFixed(2)} cutType=${cutType}`);
  }
  
  console.log(`[VIDEO] Total transitions: ${transitions.length}, types: ${transitions.map(t => `${t.type}(${t.duration.toFixed(2)}s)`).join(', ')}`);
  
  // Render with xfade transitions (pass output dimensions to ensure final video has correct size)
  if (progressReporter) {
    progressReporter.report('encoding', PROGRESS_WEIGHTS.FFMPEG_ENCODE.start, 'Encoding final video...');
  }
  
  await renderWithXfade(ffmpegPath, segments, segmentDurations, transitions, outputPath, fps, outputWidth, outputHeight);
  console.log(`[VIDEO] Final video assembled: ${outputPath}`);
  
  if (progressReporter) {
    progressReporter.report('encoding', PROGRESS_WEIGHTS.FFMPEG_ENCODE.end, 'Encoding complete');
  }
  
  // Cleanup temp files (recursive delete)
  try {
    if (existsSync(sessionTmpDir)) {
      if (fs.rmSync) {
        fs.rmSync(sessionTmpDir, { recursive: true, force: true });
      } else {
        // Fallback for older Node versions
        fs.readdirSync(sessionTmpDir).forEach(file => {
          fs.unlinkSync(path.join(sessionTmpDir, file));
        });
        fs.rmdirSync(sessionTmpDir);
      }
      console.log(`[VIDEO] Cleaned up temp directory: ${sessionTmpDir}`);
    }
  } catch (e) {
    console.warn(`[VIDEO] Failed to cleanup temp directory: ${e.message}`);
  }
  
  console.log(`[VIDEO] Render complete -> ${outputPath}`);
}

/**
 * Build xfade filter chain for true crossfades
 * Returns: { filterComplex, finalLabel }
 */
function buildXfadeFilter(segments, segmentDurations, transitions, fps = 24) {
  console.log(`[XFADE] Building filter for ${segments.length} segments, ${transitions.length} transitions`);
  console.log(`[XFADE] Segment durations: ${segmentDurations.join(', ')}`);
  
  // Calculate cumulative durations for offset calculations
  const cumulativeDurations = [];
  let cumulative = 0;
  for (let i = 0; i < segmentDurations.length; i++) {
    cumulativeDurations.push(cumulative);
    cumulative += segmentDurations[i];
  }
  console.log(`[XFADE] Cumulative durations: ${cumulativeDurations.join(', ')}`);
  
  const filterParts = [];
  
  // CRITICAL: Normalize timebases for ALL input segments using settb filter
  // This fixes "First input link main timebase ... do not match" xfade errors
  // Force a single exact timebase (AVTB = 1/1000000) across all segments
  // and reset PTS to start from 0 with setpts=PTS-STARTPTS
  for (let i = 0; i < segments.length; i++) {
    filterParts.push(`[${i}:v]fps=${fps},settb=AVTB,setpts=PTS-STARTPTS[tb${i}]`);
  }
  console.log(`[XFADE] Added ${segments.length} timebase normalization filters (settb=AVTB)`);
  
  let currentLabel = 'tb0';
  
  // Build xfade chain
  for (let i = 0; i < transitions.length; i++) {
    const trans = transitions[i];
    // Use normalized timebase labels (tb0, tb1, tb2...) instead of raw inputs
    const nextLabel = `tb${trans.toIndex}`;
    const outputLabel = i === transitions.length - 1 ? 'v' : `v${i}`;
    const rawOutLabel = `raw${i}`;
    
    // Calculate offset: start of transition = end of current segment - transition duration
    // Offset is the time in the output timeline where the transition starts
    // For first transition: offset = seg0_duration - transition_duration
    // For second transition: offset = (seg0_duration + seg1_duration) - transition_duration
    const segmentEndTime = cumulativeDurations[trans.fromIndex] + segmentDurations[trans.fromIndex];
    const offset = segmentEndTime - trans.duration;
    
    console.log(`[XFADE] Transition ${i + 1}: ${trans.type} (${trans.duration}s)`);
    console.log(`[XFADE]   From seg ${trans.fromIndex} (ends at ${segmentEndTime.toFixed(2)}s) to seg ${trans.toIndex}`);
    console.log(`[XFADE]   Offset: ${offset.toFixed(2)}s = ${segmentEndTime.toFixed(2)} - ${trans.duration}`);
    
    // Map transition types to xfade transitions (already mapped in renderFromPlan)
    // trans.type is already the xfade transition name (fade, fadeblack, wipeleft, wiperight, slideleft)
    let xfadeTransition = trans.type;
    
    // Handle special cases
    if (trans.type === 'cut') {
      // No transition, use concat
      filterParts.push(`[${currentLabel}][${nextLabel}]concat=n=2:v=1:a=0[${rawOutLabel}]`);
      filterParts.push(`[${rawOutLabel}]settb=AVTB,setpts=PTS-STARTPTS[${outputLabel}]`);
      console.log(`[XFADE]   Using concat (no transition)`);
      currentLabel = outputLabel;
      continue;
    }
    if (trans.type === 'hold_cut') {
      const holdSeconds = Math.max(0, Number(trans.holdSeconds || 0));
      const holdLabel = `hold${i}`;
      filterParts.push(`[${currentLabel}]tpad=stop_mode=clone:stop_duration=${holdSeconds.toFixed(3)}[${holdLabel}]`);
      filterParts.push(`[${holdLabel}][${nextLabel}]concat=n=2:v=1:a=0[${rawOutLabel}]`);
      filterParts.push(`[${rawOutLabel}]settb=AVTB,setpts=PTS-STARTPTS[${outputLabel}]`);
      console.log(`[XFADE]   Using breath-hold (${holdSeconds.toFixed(3)}s) then concat`);
      currentLabel = outputLabel;
      continue;
    }
    
    // Validate xfade transition type
    const validXfadeTypes = ['fade', 'fadeblack'];
    if (!validXfadeTypes.includes(xfadeTransition)) {
      console.warn(`[XFADE]   Unknown type '${trans.type}', defaulting to fade`);
      xfadeTransition = 'fade';
    }
    
    // Normalize BOTH xfade inputs right before xfade.
    // We have observed cases where upstream filters still yield mismatched timebases
    // (e.g. 1/1000000 vs 1/24). This guarantees xfade sees identical timebases.
    const curFixedLabel = `cfix${i}`;
    const nextFixedLabel = `nfix${i}`;
    filterParts.push(`[${currentLabel}]settb=AVTB,setpts=PTS-STARTPTS[${curFixedLabel}]`);
    filterParts.push(`[${nextLabel}]settb=AVTB,setpts=PTS-STARTPTS[${nextFixedLabel}]`);

    // Build xfade filter string
    const filterStr = `[${curFixedLabel}][${nextFixedLabel}]xfade=transition=${xfadeTransition}:duration=${trans.duration}:offset=${offset.toFixed(3)}[${rawOutLabel}]`;
    filterParts.push(filterStr);
    filterParts.push(`[${rawOutLabel}]settb=AVTB,setpts=PTS-STARTPTS[${outputLabel}]`);
    console.log(`[XFADE]   Transition: ${trans.type} -> xfade=${xfadeTransition}, duration=${trans.duration}s, offset=${offset.toFixed(3)}s`);
    console.log(`[XFADE]   Filter: ${filterStr}`);
    currentLabel = outputLabel;
  }
  
  // Build filter complex - xfade outputs directly, we'll add format at the end if needed
  const filterComplex = filterParts.join(';');
  
  console.log(`[XFADE] ========================================`);
  console.log(`[XFADE] Filter parts (${filterParts.length}):`);
  filterParts.forEach((part, i) => {
    console.log(`[XFADE]   ${i + 1}: ${part}`);
  });
  console.log(`[XFADE] Final filter_complex: ${filterComplex}`);
  console.log(`[XFADE] Current label: ${currentLabel}`);
  console.log(`[XFADE] ========================================`);
  
  return { filterComplex, finalLabel: currentLabel };
}

/**
 * Render video with true xfade transitions using filter_complex
 * @param {string} ffmpegPath - Path to FFmpeg executable
 * @param {Array<string>} segments - Array of segment file paths
 * @param {Array<number>} segmentDurations - Array of segment durations
 * @param {Array<Object>} transitions - Array of transition objects
 * @param {string} outputPath - Output video path
 * @param {number} fps - Frame rate (24 or 30)
 */
async function renderWithXfade(ffmpegPath, segments, segmentDurations, transitions, outputPath, fps = 24, outputWidth = 1920, outputHeight = 1080) {
  // Build filter_complex chain
  const inputs = [];
  
  // Add all segment inputs
  for (let i = 0; i < segments.length; i++) {
    inputs.push('-i', segments[i]);
  }
  
  // Validate segments count matches expectations
  console.log(`[XFADE] Segments to concat: ${segments.length}`);
  console.log(`[XFADE] Expected transitions: ${transitions.length} (should be ${segments.length - 1})`);
  if (transitions.length !== segments.length - 1) {
    throw new Error(`Transition count mismatch: ${transitions.length} transitions for ${segments.length} segments (expected ${segments.length - 1})`);
  }
  
  console.log(`[TRANSITIONS] ${transitions.length} transitions, types: ${transitions.map(t => `${t.type}(${t.duration}s)`).join(', ')}`);
  
  if (segments.length === 1) {
    // Single segment, no transitions needed
    console.log(`[VIDEO] Single segment, copying directly...`);
    fs.copyFileSync(segments[0], outputPath);
    return;
  }
  
  // Build xfade filter chain
  const { filterComplex, finalLabel } = buildXfadeFilter(segments, segmentDurations, transitions, fps);
  
  console.log(`[VIDEO] Applying ${transitions.length} transitions with xfade...`);
  console.log(`[VIDEO] ========================================`);
  console.log(`[VIDEO] FILTER_COMPLEX: ${filterComplex}`);
  console.log(`[VIDEO] ========================================`);
  
  // Build FFmpeg command with filter_complex
  // Add format conversion to the final output label if not already applied
  let finalFilter = filterComplex;
  let mapLabel = finalLabel;
  
  // Ensure format conversion is applied to the final output
  // Ensure format conversion and color range are applied to the final output
  if (!finalFilter.includes('format=yuv420p')) {
    finalFilter = filterComplex + ';[' + finalLabel + ']format=yuv420p,scale=in_range=jpeg:out_range=tv[vout]';
    mapLabel = 'vout';
    console.log(`[VIDEO] Added format conversion with color range: final filter = ${finalFilter}`);
  } else if (!finalFilter.includes('scale=in_range')) {
    // Add color range if format exists but range doesn't
    finalFilter = filterComplex + ';[' + finalLabel + ']scale=in_range=jpeg:out_range=tv[vout]';
    mapLabel = 'vout';
    console.log(`[VIDEO] Added color range conversion: final filter = ${finalFilter}`);
  }

  // FINAL NORMALIZATION (cover): enforce single scale+crop after all xfades, before fade/tpad
  const normW = outputWidth;
  const normH = outputHeight;
  const normLabel = 'vnorm';
  finalFilter = `${finalFilter};[${mapLabel}]scale=${normW}:${normH}:force_original_aspect_ratio=increase,crop=${normW}:${normH},setsar=1[${normLabel}]`;
  mapLabel = normLabel;
  console.log(`[VIDEO] Added final cover normalization: scale=${normW}:${normH} (increase) -> crop=${normW}:${normH} -> setsar=1`);

  const calcTimelineSeconds = () => {
    if (!Array.isArray(segmentDurations) || segmentDurations.length === 0) return 0;
    let total = segmentDurations[0];
    for (let i = 0; i < transitions.length; i++) {
      const t = transitions[i];
      const nextDur = segmentDurations[i + 1] ?? 0;
      if (t && t.type !== 'cut' && t.type !== 'hold_cut') total += Math.max(0, nextDur - (Number(t.duration) || 0));
      else total += nextDur;
    }
    return Math.max(0, total);
  };

  const timelineSeconds = calcTimelineSeconds();
  const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
  const scale24 = fps / 24;

  // Global fades are timeline-level editorial grammar, not AI decisions.
  // Fade-in: 18â€“24 frames @24fps (scaled by fps)
  // Fade-out: 24â€“30 frames @24fps (scaled by fps)
  // Hold black: 12 frames @24fps (scaled by fps)
  const fadeInFrames = clampInt(18 * scale24, 18 * scale24, 24 * scale24);
  const fadeOutFrames = clampInt(24 * scale24, 24 * scale24, 30 * scale24);
  const holdBlackFrames = clampInt(12 * scale24, 0, 60 * scale24);

  const fadeInSec = fadeInFrames / fps;
  const fadeOutSec = fadeOutFrames / fps;
  const holdBlackSec = holdBlackFrames / fps;
  const fadeOutStart = Math.max(0, timelineSeconds - fadeOutSec);

  finalFilter = finalFilter + `;[${mapLabel}]fade=t=in:st=0:d=${fadeInSec.toFixed(3)},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutSec.toFixed(3)},tpad=stop_mode=add:stop_duration=${holdBlackSec.toFixed(3)}:color=black[vglobal]`;
  mapLabel = 'vglobal';
  
  // CRITICAL: Ensure final output has exact dimensions
  // Segments are already rendered at outputWidth x outputHeight, so we should NOT scale again
  // However, add a scale filter to force exact dimensions if segments somehow differ
  // Use scale=exact (no aspect ratio change) to ensure exact size
  let scaleFilter = '';
  if (!finalFilter.includes(`scale=${outputWidth}:${outputHeight}`)) {
    // Force exact dimensions: scale to exact size (no aspect ratio preservation)
    // This ensures output is exactly WxH even if segments vary slightly
    scaleFilter = `[${mapLabel}]scale=${outputWidth}:${outputHeight}[vscaled]`;
    finalFilter = finalFilter + ';' + scaleFilter;
    mapLabel = 'vscaled';
    console.log(`[VIDEO] Added scale filter to force exact output dimensions: ${outputWidth}x${outputHeight}`);
  }
  
  const args = [
    ...inputs,
    '-filter_complex', finalFilter,
    '-map', `[${mapLabel}]`,
    '-r', String(fps),
    '-s', `${outputWidth}x${outputHeight}`, // Explicitly set output size (backup enforcement)
    '-pix_fmt', 'yuv420p',
    '-y',
    outputPath
  ];
  
  // #region agent log
  const sIndex = args.indexOf('-s');
  const logDataE = {location:'server/index.js:1081',message:'final video args built',data:{outputWidth:outputWidth,outputHeight:outputHeight,hasSFlag:sIndex>=0,sValue:sIndex>=0?args[sIndex+1]:null},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'};
  console.log('[DEBUG][HYPOTHESIS-E]', JSON.stringify(logDataE, null, 2));
  fetch('http://127.0.0.1:7243/ingest/f4f24cf3-2bc7-4b8e-b302-87560292ba98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(logDataE)}).catch(()=>{});
  // #endregion
  
  console.log(`[VIDEO] Final output will be exactly ${outputWidth}x${outputHeight} (${outputWidth/outputHeight === 16/9 ? '16:9' : outputWidth/outputHeight === 1920/804 ? '2.39:1' : outputWidth === outputHeight ? '1:1' : 'custom'})`);
  
  // Allow concat-only timelines (editorial hard cuts / breath-holds) while still supporting xfade when present.
  const cmdStr = args.join(' ');
  if (!cmdStr.includes('-filter_complex')) {
    const errorMsg = `[VIDEO] ERROR: Final command missing -filter_complex. Command: ${cmdStr}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  console.log(`[VIDEO] Final filter_complex: ${finalFilter}`);
  console.log(`[VIDEO] Mapping to: [${mapLabel}]`);
  console.log(`[FINAL_CMD]`, ffmpegPath, args.join(' '));
  
  // Store for debug endpoint
  global.lastRenderInfo = {
    plan: null, // Will be set by caller
    finalCmd: `${ffmpegPath} ${args.join(' ')}`,
    filterComplex: finalFilter,
    outputPath: outputPath,
    outputUrl: null, // Will be set by caller
    ffmpegStderrLast200Lines: ''
  };
  
  try {
    // Final video assembly gets 5-minute timeout (longer than segments)
    const finalStartTime = Date.now();
    await runFfmpeg(ffmpegPath, args, 'xfade', 300000); // 5 minutes
    const finalDuration = ((Date.now() - finalStartTime) / 1000).toFixed(1);
    console.log(`[VIDEO] Final xfade assembly completed in ${finalDuration}s`);
    
    // Verify output file was created
    if (!existsSync(outputPath)) {
      throw new Error(`Output file was not created: ${outputPath}`);
    }
    
    const stats = fs.statSync(outputPath);
    console.log(`[OUTPUT]`, outputPath, stats.size);
    
    if (stats.size === 0) {
      throw new Error(`Output file is empty: ${outputPath}`);
    }
    
    if (global.lastRenderInfo) {
      global.lastRenderInfo.outputPath = outputPath;
      global.lastRenderInfo.outputSize = stats.size;
    }
    
    console.log(`[VIDEO] Xfade render completed successfully`);
  } catch (error) {
    console.error(`[VIDEO] Xfade render FAILED:`, error.message);
    if (global.lastRenderInfo) {
      global.lastRenderInfo.error = error.message;
    }
    throw error;
  }
}


/**
 * Render a single segment using template
 */
function renderSegment(ffmpegPath, templateConfig, outputPath, segmentIndex = 0, photoMetadata = null) {
  // CRITICAL: Ensure segment is rendered as video with motion, not static image
  // Input: -loop 1 -t duration -i image.jpg (creates video stream from image)
  // Filter: scale+crop+zoompan (creates motion over 'frames' frames)
  // Output: -r fps -pix_fmt yuv420p (ensures video output)
  // NOTE: Filter chain already enforces exact dimensions via:
  //   - scale=increase (fills to cover)
  //   - crop=W:H:(iw-ow)/2:(ih-oh)/2 (center crop to exact size)
  //   - zoompan s=WxH (outputs at exact size)
  const args = [
    ...templateConfig.inputs,
    '-vf', templateConfig.filter,
    '-r', String(templateConfig.metadata?.fps || 24), // Force frame rate
    ...templateConfig.output,
    '-y',
    outputPath
  ];
  
  // CRITICAL: Log exact FFmpeg command for seg_000 with full filter verification
  const fullCmd = `${ffmpegPath} ${args.join(' ')}`;
  const hasZoompan = templateConfig.filter.includes('zoompan');
  const hasScale = templateConfig.filter.includes(`scale=${templateConfig.metadata?.outputWidth || 1920}:${templateConfig.metadata?.outputHeight || 1080}`);
  const hasCrop = templateConfig.filter.includes(`crop=${templateConfig.metadata?.outputWidth || 1920}:${templateConfig.metadata?.outputHeight || 1080}`);
  
  if (segmentIndex === 0) {
    const targetW = templateConfig.metadata?.outputWidth || 1920;
    const targetH = templateConfig.metadata?.outputHeight || 1080;
    console.log(`[SEGMENT][${segmentIndex}] ========================================`);
    console.log(`[SEGMENT][${segmentIndex}] EXACT FFMPEG COMMAND FOR seg_000:`);
    console.log(`[SEGMENT][${segmentIndex}] ${fullCmd}`);
    console.log(`[SEGMENT][${segmentIndex}] Filter verification:`);
    // Check MOTION_MODE - zoompan is only required when motion is enabled
    const MOTION_MODE = process.env.MOTION_MODE || 'OFF';
    const motionEnabled = MOTION_MODE !== 'OFF';
    
    console.log(`[SEGMENT][${segmentIndex}]   MOTION_MODE: ${MOTION_MODE} (motion ${motionEnabled ? 'ENABLED' : 'DISABLED'})`);
    console.log(`[SEGMENT][${segmentIndex}]   Has zoompan (motion): ${hasZoompan ? 'âœ"' : 'âœ— MISSING - NO MOTION!'}`);
    console.log(`[SEGMENT][${segmentIndex}]   Has scale=${targetW}:${targetH}: ${hasScale ? 'âœ"' : 'âœ— MISSING!'}`);
    console.log(`[SEGMENT][${segmentIndex}]   Has crop=${targetW}:${targetH}: ${hasCrop ? 'âœ"' : 'âœ— MISSING!'}`);
    console.log(`[SEGMENT][${segmentIndex}]   Full filter: ${templateConfig.filter}`);
    console.log(`[SEGMENT][${segmentIndex}] ========================================`);
    
    // Only throw error if zoompan is missing AND motion is enabled
    if (motionEnabled && !hasZoompan) {
      throw new Error(`[SEGMENT][${segmentIndex}] FATAL: zoompan filter missing! Motion will not work. Filter: ${templateConfig.filter}`);
    }
    
    // In OFF mode, zoompan should NOT be present (static only)
    if (!motionEnabled && hasZoompan) {
      console.warn(`[SEGMENT][${segmentIndex}] WARNING: zoompan filter found but MOTION_MODE=OFF. This may indicate a configuration issue.`);
    }
  }
  
  // Log segment generation details (especially for first segment)
  if (segmentIndex === 0 || templateConfig.metadata) {
    const meta = templateConfig.metadata || {};
    const zoomDesc = (meta.motionType === 'push-in' || meta.zoomType === 'push-in' || meta.motionType === 'punch-in') ? `push-in (${meta.startZoom?.toFixed(2)}â†’${meta.endZoom?.toFixed(2)})` : 
                     (meta.motionType === 'pull-out' || meta.zoomType === 'pull-out') ? `pull-out (${meta.startZoom?.toFixed(2)}â†’${meta.endZoom?.toFixed(2)})` : 
                     meta.motionType === 'two-stage' ? `two-stage (${meta.startZoom?.toFixed(2)}â†’${meta.endZoom?.toFixed(2)}, hold=${(meta.holdPct * 100).toFixed(0)}%)` :
                     'unknown';
    const panX = meta.panX !== undefined ? meta.panX : (meta.driftX || 0);
    const panY = meta.panY !== undefined ? meta.panY : (meta.driftY || 0);
    const panXSign = panX > 0 ? '+' : '';
    const panYSign = panY > 0 ? '+' : '';
    const rotateAmp = meta.rotateAmp !== undefined ? meta.rotateAmp : 0;
    const jitterAmp = meta.jitterAmp !== undefined ? meta.jitterAmp : 0;
    const holdPct = meta.holdPct !== undefined ? meta.holdPct : 0;
    
    // Log motion preset details in required format
    console.log(`[MOTION] preset=${meta.preset || 'unknown'} startZoom=${meta.startZoom?.toFixed(2) || 'unknown'} endZoom=${meta.endZoom?.toFixed(2) || 'unknown'} panX=${panXSign}${panX} panY=${panYSign}${panY} rotateAmp=${rotateAmp.toFixed(2)} jitterAmp=${jitterAmp} holdPct=${(holdPct * 100).toFixed(0)}`);
    
    const outputSize = `${meta.outputWidth || 'unknown'}x${meta.outputHeight || 'unknown'}`;
    const isVertical = photoMetadata && photoMetadata.height && photoMetadata.width && photoMetadata.height > photoMetadata.width;
    const outputRatio = meta.outputWidth && meta.outputHeight ? (meta.outputWidth / meta.outputHeight).toFixed(2) : 'unknown';
    
    console.log(`[SEGMENT] i=${segmentIndex} preset=${meta.preset || 'unknown'} frames=${meta.totalFrames || 'unknown'} duration=${templateConfig.duration.toFixed(1)} file=${meta.filename || 'unknown'} output=${outputSize} ${isVertical ? '(VERTICAL->CENTER-CROPPED)' : ''}`);
    console.log(`[SEGMENT][${segmentIndex}]   Motion: ${zoomDesc}`);
    console.log(`[SEGMENT][${segmentIndex}]   Path: panX=${panXSign}${panX} panY=${panYSign}${panY}`);
    console.log(`[SEGMENT][${segmentIndex}]   Output: ${outputSize} @ ${meta.fps || 'unknown'}fps (ratio=${outputRatio}:1)`);
    console.log(`[SEGMENT][${segmentIndex}]   Duration: ${templateConfig.duration}s`);
    console.log(`[SEGMENT][${segmentIndex}]   FPS: ${meta.fps || 'unknown'}`);
    if (meta.filename) {
      console.log(`[SEGMENT][${segmentIndex}]   Filename: ${meta.filename}`);
      if (photoMetadata && photoMetadata.width && photoMetadata.height) {
        const inputRatio = (photoMetadata.width / photoMetadata.height).toFixed(2);
        const needsCrop = Math.abs((photoMetadata.width / photoMetadata.height) - (meta.outputWidth / meta.outputHeight)) > 0.01;
        console.log(`[SEGMENT][${segmentIndex}]   Input: ${photoMetadata.width}x${photoMetadata.height} (${inputRatio}:1) -> Output: ${outputSize} (${outputRatio}:1) ${needsCrop ? '[CENTER-CROPPED]' : '[NO CROP NEEDED]'}`);
      }
    }
    console.log(`[SEGMENT][${segmentIndex}]   Filter: ${templateConfig.filter}`);
    console.log(`[SEGMENT][${segmentIndex}]   FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);
  }
  
  // Each segment gets 2-minute timeout (should be enough for single image -> video)
  return runFfmpeg(ffmpegPath, args, `segment-${segmentIndex}`, 120000);
}

/**
 * Run FFmpeg with error handling and stderr logging
 */
function runFfmpeg(ffmpegPath, args, context = 'ffmpeg', timeoutMs = 120000) {
  // timeoutMs: default 2 minutes per segment, 5 minutes for final video
  const useShell = ffmpegPath === 'ffmpeg';
  
  // PHASE D: Log FFmpeg command start
  const cmdString = `${ffmpegPath} ${args.join(' ')}`;
  console.log(`[FFMPEG][${context}] Starting FFmpeg command (timeout: ${timeoutMs/1000}s)`);
  console.log(`[FFMPEG][${context}] Path: ${ffmpegPath}`);
  console.log(`[FFMPEG][${context}] Command: ${cmdString}`);
  
  return new Promise((resolve, reject) => {
    let timeoutId = null;
    let hasResolved = false;
    
    // Set timeout to prevent hanging forever
    timeoutId = setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        console.error(`[FFMPEG][${context}] TIMEOUT after ${timeoutMs/1000}s - killing process`);
        if (ffmpeg && !ffmpeg.killed) {
          ffmpeg.kill('SIGKILL');
        }
        reject(new Error(`FFmpeg ${context} timed out after ${timeoutMs/1000} seconds`));
      }
    }, timeoutMs);
    
    const ffmpeg = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
    });
    
    let stderr = '';
    const errorLines = [];
    const stderrLines = []; // Store all stderr lines for debug endpoint
    
    ffmpeg.stderr.on('data', (data) => {
      const line = data.toString();
      stderr += line;
      stderrLines.push(line); // Store for debug endpoint
      
      // Keep only last 200 lines for debug endpoint
      if (stderrLines.length > 200) {
        stderrLines.shift();
      }
      
      // Filter out informational messages (FFmpeg writes everything to stderr)
      const trimmed = line.trim();
      
      // Skip version info and copyright
      if (trimmed.includes('ffmpeg version') || 
          trimmed.includes('Copyright') || 
          trimmed.includes('built with') ||
          trimmed.includes('configuration:') ||
          trimmed.startsWith('lib') ||
          trimmed.includes('Stream #') ||
          trimmed.includes('Output #') ||
          trimmed.includes('frame=') ||
          trimmed.includes('fps=') ||
          trimmed.includes('bitrate=') ||
          trimmed.includes('time=') ||
          trimmed.includes('speed=')) {
        // Log as info, not error
        console.log(`[VIDEO][FFMPEG][${context}]`, trimmed);
      } else if (trimmed.toLowerCase().includes('error') || 
                 trimmed.toLowerCase().includes('failed') ||
                 trimmed.toLowerCase().includes('invalid') ||
                 trimmed.toLowerCase().includes('cannot')) {
        // Actual error message
        errorLines.push(trimmed);
        console.error(`[VIDEO][FFMPEG][${context}] ERROR:`, trimmed);
      } else if (trimmed.length > 0) {
        // Other output
        console.log(`[VIDEO][FFMPEG][${context}]`, trimmed);
      }
    });
    
    ffmpeg.on('error', (err) => {
      if (hasResolved) return;
      hasResolved = true;
      if (timeoutId) clearTimeout(timeoutId);
      console.error(`[FFMPEG][${context}] Process error:`, err.message);
      reject(err);
    });
    
    ffmpeg.on('close', (code) => {
      if (hasResolved) return; // Already handled by timeout
      hasResolved = true;
      if (timeoutId) clearTimeout(timeoutId);
      
      // Store stderr for error responses (always store, not just for xfade)
      const stderrText = stderrLines.slice(-200).join('');
      if (global.lastRenderInfo) {
        global.lastRenderInfo.ffmpegStderrLast200Lines = stderrText;
        // Also store the command for debugging
        global.lastRenderInfo.lastFfmpegCommand = `${ffmpegPath} ${args.join(' ')}`;
      }
      
      if (code === 0) {
        resolve();
      } else {
        // Extract actual error messages, not version info
        // Filter out version info from stderr
        const filteredStderr = stderr
          .split('\n')
          .filter(line => {
            const trimmed = line.trim();
            return trimmed.length > 0 &&
                   !trimmed.includes('ffmpeg version') &&
                   !trimmed.includes('Copyright') &&
                   !trimmed.includes('built with') &&
                   !trimmed.includes('configuration:') &&
                   !trimmed.startsWith('lib') &&
                   !trimmed.includes('Stream #') &&
                   !trimmed.includes('Output #');
          })
          .join('\n');
        
        const errorMsg = errorLines.length > 0 
          ? errorLines.join('; ')
          : (filteredStderr.length > 0 
              ? (filteredStderr.length > 300 ? filteredStderr.substring(0, 300) + '...' : filteredStderr)
              : `FFmpeg process exited with code ${code}`);
        
        console.error(`[VIDEO][FFMPEG][${context}] FFmpeg failed with exit code ${code}`);
        console.error(`[VIDEO][FFMPEG][${context}] Command: ${ffmpegPath} ${args.join(' ')}`);
        console.error(`[VIDEO][FFMPEG][${context}] Stderr:`, errorMsg);
        
        // Create error with stderr attached for better error handling
        const error = new Error(`FFmpeg failed: ${errorMsg}`);
        error.ffmpegStderr = stderrText;
        error.ffmpegCommand = `${ffmpegPath} ${args.join(' ')}`;
        error.ffmpegExitCode = code;
        reject(error);
      }
    });
  });
}

/**
 * Upload photos endpoint
 */
app.post('/api/upload-photos', upload.array('photos', MAX_PHOTOS), async (req, res) => {
  try {
    if (!req.files || req.files.length < MIN_PHOTOS) {
      return res.status(400).json({
        error: `Please upload at least ${MIN_PHOTOS} photos (maximum ${MAX_PHOTOS})`
      });
    }
    
    const sessionId = req.body.sessionId || Date.now().toString();
    const sessionDir = path.join(uploadsDir, sessionId);
    
    // Create session directory and move files there
    if (!existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    // Save files with unique paths: memoryId/index_uuid.ext
    // CRITICAL: Use index and UUID to prevent filename collisions
    const photos = await Promise.all(req.files.map(async (file, index) => {
      // Generate unique filename: index_uuid.ext
      // Use crypto.randomUUID() if available (Node 16.7+), otherwise fallback
      let uuid;
      if (typeof crypto.randomUUID === 'function') {
        uuid = crypto.randomUUID();
      } else {
        // Fallback for older Node versions
        uuid = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${index}`;
      }
      const ext = path.extname(file.originalname) || '.jpg';
      const storedFilename = `${index}_${uuid}${ext}`;
      const storedPath = path.join(sessionDir, storedFilename);
      
      // Write file from buffer (multer memory storage)
      fs.writeFileSync(storedPath, file.buffer);
      
      // For MVP, use default dimensions (can add image processing later)
      return {
        originalName: file.originalname, // Keep original for display
        filename: storedFilename, // Stored filename
        storedPath: storedPath, // Full path on disk
        width: 1920,
        height: 1080,
        sizeBytes: file.size,
        path: `/uploads/${sessionId}/${storedFilename}`,
        index: index
      };
    }));
    
    console.log(`[UPLOAD] Stored ${photos.length} photos to ${sessionDir}`);
    console.log(`[UPLOAD] uploadedCount=${photos.length}`);
    
    res.json({
      sessionId,
      photos
    });
  } catch (error) {
    console.error('[UPLOAD] Error:', error);
    res.status(500).json({
      error: 'Upload failed',
      details: error.message
    });
  }
});

/**
 * Combined endpoint: plan + render
 * POST only - reject other methods with 405 Method Not Allowed
 */
app.all('/api/create-memory', (req, res, next) => {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: `Method not allowed: ${req.method}. Only POST is allowed for /api/create-memory`
    });
  }
  next();
});

app.post('/api/create-memory', async (req, res) => {
  let currentStep = 'upload';
  
  // Initialize sessionId at the very top (before any usage)
  const sessionId =
    req.body?.sessionId ||
    req.headers['x-session-id'] ||
    crypto.randomUUID();
  
  // Check if client wants SSE (via Accept header or query param)
  const wantsSSE = req.headers.accept?.includes('text/event-stream') || req.query.stream === 'true';
  
  // Initialize progress reporter if SSE requested
  let progressReporter = null;
  if (wantsSSE) {
    progressReporter = new ProgressReporter(res);
    progressReporter.start();
  }
  
  try {
    // PHASE C: Validate upload inputs
    currentStep = 'upload';
    
    if (progressReporter) {
      progressReporter.report('validating', PROGRESS_WEIGHTS.VALIDATE_UPLOAD.start, 'Validating inputs...');
    }
    
    console.log('[CREATE-MEMORY] Starting memory creation');
    console.log(`[CREATE-MEMORY] Request body keys:`, Object.keys(req.body));
    console.log(`[CREATE-MEMORY] SSE requested: ${wantsSSE}`);
    
    const { promptText, photos, fps, outputRatio } = req.body;
    
    // #region agent log
    const logDataA = {location:'server/index.js:1423',message:'outputRatio received from request',data:{outputRatio:outputRatio,type:typeof outputRatio,rawBody:JSON.stringify(req.body).substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'};
    console.log('[DEBUG][HYPOTHESIS-A]', JSON.stringify(logDataA, null, 2));
    fetch('http://127.0.0.1:7243/ingest/f4f24cf3-2bc7-4b8e-b302-87560292ba98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(logDataA)}).catch(()=>{});
    // #endregion
    
    // Parse and validate fps (24 or 30, default 24)
    const targetFps = (fps === 24 || fps === 30) ? parseInt(fps, 10) : 24;
    console.log(`[CREATE-MEMORY] FPS: ${targetFps} (requested: ${fps || 'default'})`);
    
    // Parse and validate outputRatio, map to dimensions
    // CRITICAL: Normalize outputRatio (trim whitespace, handle case)
    const normalizedRatio = outputRatio ? String(outputRatio).trim() : '16:9';
    console.log(`[CREATE-MEMORY] Raw outputRatio from request: "${outputRatio}" (type: ${typeof outputRatio})`);
    console.log(`[CREATE-MEMORY] Normalized outputRatio: "${normalizedRatio}"`);
    
    // #region agent log
    const logDataA2 = {location:'server/index.js:1435',message:'outputRatio normalized',data:{normalizedRatio:normalizedRatio,originalRatio:outputRatio},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'};
    console.log('[DEBUG][HYPOTHESIS-A]', JSON.stringify(logDataA2, null, 2));
    fetch('http://127.0.0.1:7243/ingest/f4f24cf3-2bc7-4b8e-b302-87560292ba98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(logDataA2)}).catch(()=>{});
    // #endregion
    
    let outputWidth = 1920;
    let outputHeight = 1080;
    if (normalizedRatio === '16:9') {
      outputWidth = 1920;
      outputHeight = 1080;
      console.log(`[CREATE-MEMORY] Selected: HD (16:9) -> ${outputWidth}x${outputHeight}`);
    } else if (normalizedRatio === '2.39:1') {
      outputWidth = 1920;
      outputHeight = 804; // Ensure even height
      console.log(`[CREATE-MEMORY] Selected: Film Wide (2.39:1) -> ${outputWidth}x${outputHeight}`);
    } else if (normalizedRatio === '1:1') {
      outputWidth = 1080;
      outputHeight = 1080;
      console.log(`[CREATE-MEMORY] Selected: Square (1:1) -> ${outputWidth}x${outputHeight}`);
    } else {
      // Default to 16:9 if invalid or missing
      console.warn(`[CREATE-MEMORY] Invalid outputRatio: "${normalizedRatio}", defaulting to 16:9`);
      console.warn(`[CREATE-MEMORY] Expected one of: "16:9", "2.39:1", "4:5", "1:1"`);
      outputWidth = 1920;
      outputHeight = 1080;
    }
    
    // #region agent log
    const logDataB = {location:'server/index.js:1455',message:'outputRatio mapped to dimensions',data:{normalizedRatio:normalizedRatio,outputWidth:outputWidth,outputHeight:outputHeight},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'};
    console.log('[DEBUG][HYPOTHESIS-B]', JSON.stringify(logDataB, null, 2));
    fetch('http://127.0.0.1:7243/ingest/f4f24cf3-2bc7-4b8e-b302-87560292ba98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(logDataB)}).catch(()=>{});
    // #endregion
    
    console.log(`[CREATE-MEMORY] Final output dimensions: ${outputWidth}x${outputHeight}`);
    
    // Log number of uploaded images
    console.log(`[CREATE-MEMORY] Received ${photos?.length || 0} photos, sessionId: ${sessionId || 'missing'}`);
    
    if (!sessionId || typeof sessionId !== 'string') {
      console.error('[CREATE-MEMORY] Missing or invalid sessionId');
      const error = { error: 'VIDEO_GENERATION_FAILED', message: 'sessionId is required', step: currentStep };
      if (progressReporter) {
        progressReporter.error(new Error('sessionId is required'), currentStep);
        return;
      }
      return res.status(400).json(error);
    }
    
    if (!photos || !Array.isArray(photos)) {
      console.error('[CREATE-MEMORY] Missing or invalid photos array');
      const error = { error: 'VIDEO_GENERATION_FAILED', message: 'photos array is required', step: currentStep };
      if (progressReporter) {
        progressReporter.error(new Error('photos array is required'), currentStep);
        return;
      }
      return res.status(400).json(error);
    }
    
    if (photos.length < MIN_PHOTOS || photos.length > MAX_PHOTOS) {
      console.error(`[CREATE-MEMORY] Invalid photo count: ${photos.length} (required: ${MIN_PHOTOS}-${MAX_PHOTOS})`);
      const errorMsg = `Please upload between ${MIN_PHOTOS} and ${MAX_PHOTOS} photos (received ${photos.length})`;
      const error = { error: 'VIDEO_GENERATION_FAILED', message: errorMsg, step: currentStep };
      if (progressReporter) {
        progressReporter.error(new Error(errorMsg), currentStep);
        return;
      }
      return res.status(400).json(error);
    }
    
    // Log mime types
    const mimeTypes = photos.map(p => {
      const mimeType = p.mimeType || (p.filename ? `image/${path.extname(p.filename).toLowerCase().slice(1)}` : 'unknown');
      return mimeType;
    });
    console.log(`[CREATE-MEMORY] Photo mime types:`, mimeTypes.slice(0, 5), mimeTypes.length > 5 ? `... (${mimeTypes.length} total)` : '');
    
    // Validate photo mime types (reject HEIC for now)
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const invalidPhotos = photos.filter(p => {
      // Check if photo has mimeType or infer from filename
      const mimeType = p.mimeType || (p.filename ? `image/${path.extname(p.filename).toLowerCase().slice(1)}` : '');
      const ext = p.filename ? path.extname(p.filename).toLowerCase() : '';
      return !allowedMimeTypes.some(allowed => mimeType.includes(allowed) || (ext && ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)));
    });
    
    if (invalidPhotos.length > 0) {
      console.error(`[CREATE-MEMORY] Invalid photo types detected:`, invalidPhotos.map(p => p.filename || p.mimeType || 'unknown'));
      const errorMsg = `Invalid image types detected. Please use JPEG, PNG, or WebP only. HEIC is not supported.`;
      const error = { error: 'VIDEO_GENERATION_FAILED', message: errorMsg, step: currentStep };
      if (progressReporter) {
        progressReporter.error(new Error(errorMsg), currentStep);
        return;
      }
      return res.status(400).json(error);
    }
    
    // PHASE B: Ensure directories exist
    console.log(`[CREATE-MEMORY] Checking directories...`);
    const uploadsSessionDir = path.join(uploadsDir, sessionId);
    if (!existsSync(uploadsSessionDir)) {
      console.log(`[CREATE-MEMORY] Creating uploadsSessionDir: ${uploadsSessionDir}`);
      fs.mkdirSync(uploadsSessionDir, { recursive: true });
    } else {
      console.log(`[CREATE-MEMORY] uploadsSessionDir exists: ${uploadsSessionDir}`);
    }
    
    if (!existsSync(tmpDir)) {
      console.log(`[CREATE-MEMORY] Creating tmpDir: ${tmpDir}`);
      fs.mkdirSync(tmpDir, { recursive: true });
    } else {
      console.log(`[CREATE-MEMORY] tmpDir exists: ${tmpDir}`);
    }
    
    if (!existsSync(outputsDir)) {
      console.log(`[CREATE-MEMORY] Creating outputsDir: ${outputsDir}`);
      fs.mkdirSync(outputsDir, { recursive: true });
    } else {
      console.log(`[CREATE-MEMORY] outputsDir exists: ${outputsDir}`);
    }
    
    // Verify FFmpeg is available
    console.log(`[CREATE-MEMORY] Checking FFmpeg availability...`);
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) {
      console.error('[CREATE-MEMORY] FFmpeg not found');
      throw new Error('FFmpeg is not available. Please ensure FFmpeg is installed.');
    }
    console.log(`[CREATE-MEMORY] FFmpeg found at: ${ffmpegPath}`);
    
    // Test FFmpeg with -version command
    try {
      // spawnSync is already imported at top of file
      const versionResult = spawnSync(ffmpegPath, ['-version'], { 
        encoding: 'utf8', 
        timeout: 5000,
        windowsHide: true 
      });
      if (versionResult.status === 0) {
        const versionLine = versionResult.stdout.split('\n')[0] || 'unknown';
        console.log(`[CREATE-MEMORY] FFmpeg version check: ${versionLine.substring(0, 50)}...`);
      } else {
        console.warn(`[CREATE-MEMORY] FFmpeg version check failed with status ${versionResult.status}`);
      }
    } catch (versionError) {
      console.warn(`[CREATE-MEMORY] FFmpeg version check error:`, versionError.message);
    }
    
    
    // PHASE B.5: Write base64 photos to disk if needed
    console.log(`[CREATE-MEMORY] Checking if photos need to be written to disk...`);
    const processedPhotos = [];
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      let filename = photo.filename || photo.originalName || `${String(i).padStart(2, "0")}.jpg`;
      
      // If photo has base64 data, write it to disk
      if (photo.data && typeof photo.data === 'string') {
        console.log(`[CREATE-MEMORY] Writing base64 photo ${i + 1}/${photos.length} to disk: ${filename}`);
        const ext = path.extname(filename) || (photo.mimeType ? `.${photo.mimeType.split('/')[1]}` : '.jpg');
        if (!path.extname(filename)) {
          filename = `${path.basename(filename, path.extname(filename))}${ext}`;
        }
        const storedPath = path.join(uploadsSessionDir, filename);
        const buffer = Buffer.from(photo.data, 'base64');
        fs.writeFileSync(storedPath, buffer);
        console.log(`[CREATE-MEMORY] Written ${buffer.length} bytes to ${storedPath}`);
        
        processedPhotos.push({
          ...photo,
          filename: filename,
          storedPath: storedPath,
          sizeBytes: buffer.length,
          originalName: photo.originalName || photo.filename || filename,
        });
      } else {
        // Photo already has a path, use it as-is
        processedPhotos.push(photo);
      }
    }
    // Replace photos array with processed photos
    photos.length = 0;
    photos.push(...processedPhotos);
    

    console.log('[RENDER] Using 3-stage pipeline: Vision Analysis â†’ Sequence Planning â†’ Motion Planning');
    
    // ========================================
    // 3-STAGE PIPELINE: Analyze â†’ Plan â†’ Animate
    // ========================================
    
    let analysisResults = [];
    let sequencePlan = null;
    let storyLock = null;
    let motionPlan = [];
    
    // STAGE 1: Vision Analysis (analyze ALL images)
    currentStep = 'vision-analysis';
    
    // CRITICAL: File ingestion validation - log all received photos
    console.log(`[STAGE-1] File ingestion validation: ${photos.length} photos received`);
    console.log(`[STAGE-1] Photo filenames: [${photos.map(p => p.filename || p.originalName || 'unknown').join(', ')}]`);
    
    if (photos.length < 1) {
      throw new Error('No photos provided for analysis');
    }
    
    // CRITICAL: Ensure all photos have unique identifiers (filename-based, not numeric)
    const photoFilenames = new Set();
    const duplicateFilenames = [];
    for (const photo of photos) {
      const filename = photo.filename || photo.originalName || `unknown_${photos.indexOf(photo)}`;
      if (photoFilenames.has(filename)) {
        duplicateFilenames.push(filename);
      }
      photoFilenames.add(filename);
    }
    if (duplicateFilenames.length > 0) {
      console.warn(`[STAGE-1] WARNING: Duplicate filenames detected: ${duplicateFilenames.join(', ')}`);
      console.warn(`[STAGE-1] This could cause images to overwrite each other. Using storedPath as fallback identifier.`);
    }
    
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key required for vision analysis. Please set OPENAI_API_KEY environment variable.');
    }
    
    try {
      // Analyze all images
      analysisResults = await analyzeAllImages(photos, uploadsSessionDir, process.env.OPENAI_API_KEY);
      
      // CRITICAL: Analysis coverage validation with missing filename list
      if (analysisResults.length !== photos.length) {
        const analyzedFilenames = new Set(analysisResults.map(a => a.filename));
        const missingFilenames = photos
          .map(p => p.filename || p.originalName || 'unknown')
          .filter(f => !analyzedFilenames.has(f));
        throw new Error(
          `[VALIDATION] Analysis incomplete: ${analysisResults.length}/${photos.length} images analyzed. ` +
          `Missing filenames: ${missingFilenames.join(', ')}`
        );
      }
      
      console.log(`[STAGE-1] Vision analysis complete: ${analysisResults.length} images analyzed`);
      console.log(`[STAGE-1] Validated: analysisResults.length (${analysisResults.length}) === photos.length (${photos.length})`);
    } catch (analysisError) {
      console.error('[STAGE-1] Vision analysis failed:', analysisError);
      
      // Check for malformed request body errors
      if (analysisError.status === 400 && analysisError.message && (
        analysisError.message.includes('Unrecognized request argument') ||
        analysisError.message.includes('unexpected field') ||
        analysisError.message.includes('Invalid request')
      )) {
        throw new Error('Server bug: invalid OpenAI request payload (unexpected field). Check server logs.');
      }
      
      throw new Error(`Vision analysis failed: ${analysisError.message}`);
    }
    
    // STAGE 2: Sequence Planning (global narrative)
    currentStep = 'sequence-planning';
    console.log(`[STAGE-2] Starting sequence planning with ${analysisResults.length} analyses...`);
    
    try {
      sequencePlan = await createSequencePlan(analysisResults, promptText, process.env.OPENAI_API_KEY, progressReporter);
      
      // CRITICAL: Planning coverage validation with missing ID list
      if (sequencePlan.ordered_ids.length !== photos.length) {
        const expectedIds = Array.from({ length: photos.length }, (_, i) => i);
        const orderedIdSet = new Set(sequencePlan.ordered_ids);
        const missingIds = expectedIds.filter(id => !orderedIdSet.has(id));
        const missingFilenames = missingIds.map(id => photos[id]?.filename || photos[id]?.originalName || `image_${id}`);
        throw new Error(
          `[VALIDATION] Sequence plan incomplete: ${sequencePlan.ordered_ids.length}/${photos.length} images in ordered_ids. ` +
          `Missing IDs: ${missingIds.join(', ')}. Missing filenames: ${missingFilenames.join(', ')}`
        );
      }
      
      console.log(`[STAGE-2] Validated: ordered_ids.length (${sequencePlan.ordered_ids.length}) === photos.length (${photos.length})`);
      
      // Convert sequence plan to legacy plan format for renderer compatibility
      // sequencePlan.ordered_ids contains original photo indices (0..N-1) in story order
      const plan = {
        selected: Array.from({ length: photos.length }, (_, i) => i), // All photos selected
        order: sequencePlan.ordered_ids, // Story order (direct indices, not into selected)
        durations: [], // Will be computed from motion plan
        transitions: Array.from({ length: sequencePlan.ordered_ids.length - 1 }, () => 'crossfade'),
        chapterCuts: {
          arrivalEnd: Math.floor(sequencePlan.ordered_ids.length * 0.2),
          recognitionEnd: Math.floor(sequencePlan.ordered_ids.length * 0.4),
          intimacyEnd: Math.floor(sequencePlan.ordered_ids.length * 0.6),
          pauseEnd: Math.floor(sequencePlan.ordered_ids.length * 0.8)
        },
        memoryNote: sequencePlan.theme || promptText || '',
        usedPlanner: 'ai',
        sequencePlan: sequencePlan // Keep full sequence plan for motion planning
      };
      
      console.log(`[STAGE-2] Sequence planning complete: ${sequencePlan.ordered_ids.length} images ordered, ${sequencePlan.shots?.length || 0} shots`);
      console.log(`[STAGE-2] Theme: ${sequencePlan.theme}`);
      console.log(`[STAGE-2] Emotion arc: ${sequencePlan.emotion_arc?.length || 0} beats`);
      
      // Log counts for validation
      console.log(`[STAGE-2] totalImages=${photos.length}, ordered_ids.length=${sequencePlan.ordered_ids.length}, shots.length=${sequencePlan.shots?.length || 0}`);

      // STAGE 2.5: Story Lock (freeze hierarchy + why each image exists)
      currentStep = 'story-lock';
      try {
        storyLock = createStoryLock(analysisResults, sequencePlan, promptText);
        console.log(`[STORY_LOCK] theme=${storyLock.theme}`);
        console.log(`[STORY_LOCK] hero_images=[${(storyLock.hero_images || []).join(', ')}] supporting_images=[${(storyLock.supporting_images || []).join(', ')}]`);

        if (
          storyLock &&
          Array.isArray(storyLock.final_order) &&
          Array.isArray(storyLock.final_shots) &&
          storyLock.final_order.length > 0 &&
          storyLock.final_shots.length === storyLock.final_order.length
        ) {
          const oldLen = sequencePlan.ordered_ids.length;
          const newLen = storyLock.final_order.length;
          const dropped = Array.isArray(storyLock.drop_ids) ? storyLock.drop_ids.length : Math.max(0, oldLen - newLen);
          sequencePlan.ordered_ids = storyLock.final_order;
          sequencePlan.shots = storyLock.final_shots;
          console.log(`[STORY_LOCK] keep=${newLen} drop=${dropped} desired=${storyLock.desired_count ?? newLen}`);
          console.log(`[STORY_LOCK] final_order=[${storyLock.final_order.join(', ')}]`);
        }
      } catch (storyLockError) {
        console.error('[STORY_LOCK] Story lock failed:', storyLockError);
        storyLock = null;
      }
    } catch (sequenceError) {
      console.error('[STAGE-2] Sequence planning failed:', sequenceError);
      
      // Check for malformed request body errors
      if (sequenceError.status === 400 && sequenceError.message && (
        sequenceError.message.includes('Unrecognized request argument') ||
        sequenceError.message.includes('unexpected field') ||
        sequenceError.message.includes('Invalid request')
      )) {
        throw new Error('Server bug: invalid OpenAI request payload (unexpected field). Check server logs.');
      }
      
      throw new Error(`Sequence planning failed: ${sequenceError.message}`);
    }
    
    // STAGE 3: Motion Planning (movement per image)
    currentStep = 'motion-planning';
    console.log(`[STAGE-3] Starting motion planning for ${sequencePlan.ordered_ids.length} images...`);
    
    if (progressReporter) {
      progressReporter.report('motion-planning', 70, 'Planning motion...');
    }
    
    try {
      // Create photoMetadata with dimensions from analysis results
      const photoMetadataForMotion = [];
      for (const analysis of analysisResults) {
        // Get dimensions from analysis (will be populated if available)
        photoMetadataForMotion.push({
          filename: analysis.filename,
          width: analysis.width || 0,
          height: analysis.height || 0
        });
      }
      
      motionPlan = generateMotionPlan(analysisResults, sequencePlan, photoMetadataForMotion, outputWidth, outputHeight);
      
      if (progressReporter) {
        progressReporter.report('motion-planning', 72, 'Motion planning complete');
      }
      
      // CRITICAL: Motion plan coverage validation
      if (motionPlan.length !== sequencePlan.ordered_ids.length) {
        const expectedCount = sequencePlan.ordered_ids.length;
        const missingIndices = [];
        const motionPlanImageIds = new Set(motionPlan.map(m => m.imageId));
        for (let i = 0; i < expectedCount; i++) {
          const imageId = sequencePlan.ordered_ids[i];
          if (!motionPlanImageIds.has(imageId)) {
            missingIndices.push(i);
          }
        }
        const missingFilenames = missingIndices.map(i => {
          const imageId = sequencePlan.ordered_ids[i];
          return analysisResults[imageId]?.filename || `image_${imageId}`;
        });
        throw new Error(
          `[VALIDATION] Motion plan incomplete: ${motionPlan.length}/${expectedCount} images planned. ` +
          `Missing indices: ${missingIndices.join(', ')}. Missing filenames: ${missingFilenames.join(', ')}`
        );
      }
      
      console.log(`[STAGE-3] Validated: motionPlan.length (${motionPlan.length}) === sequencePlan.ordered_ids.length (${sequencePlan.ordered_ids.length})`);
      
      console.log(`[STAGE-3] Motion planning complete: ${motionPlan.length} images planned`);
      console.log(`[STAGE-3] Movement types: ${[...new Set(motionPlan.map(m => m.movementType))].join(', ')}`);
    } catch (motionError) {
      console.error('[STAGE-3] Motion planning failed:', motionError);
      throw new Error(`Motion planning failed: ${motionError.message}`);
    }
    
    // Final plan (compatible with existing renderer)
    // Compute durations via validatePlan (editorial rhythm), not by hard-clamping to 3s.
    let plan = {
      selected: Array.from({ length: photos.length }, (_, i) => i),
      order: sequencePlan.ordered_ids,
      durations: [],
      transitions: Array.from({ length: sequencePlan.ordered_ids.length - 1 }, () => 'crossfade'),
      chapterCuts: {
        arrivalEnd: Math.floor(sequencePlan.ordered_ids.length * 0.2),
        recognitionEnd: Math.floor(sequencePlan.ordered_ids.length * 0.4),
        intimacyEnd: Math.floor(sequencePlan.ordered_ids.length * 0.6),
        pauseEnd: Math.floor(sequencePlan.ordered_ids.length * 0.8)
      },
      memoryNote: sequencePlan.theme || promptText || '',
      usedPlanner: 'ai',
      motionPlan: motionPlan,
      analysisResults: analysisResults,
      sequencePlan: sequencePlan,
      storyLock: storyLock
    };

    plan = validatePlan(plan, photos.length, promptText);
    
    // Log final plan summary
    console.log('[CREATE-MEMORY] ========================================');
    console.log(`[CREATE-MEMORY] 3-stage pipeline complete:`);
    console.log(`[CREATE-MEMORY]   Stage 1 (Vision Analysis): ${analysisResults.length} images analyzed`);
    console.log(`[CREATE-MEMORY]   Stage 2 (Sequence Planning): ${sequencePlan.ordered_ids.length} images ordered`);
    console.log(`[CREATE-MEMORY]   Stage 3 (Motion Planning): ${motionPlan.length} images with motion`);
    console.log(`[CREATE-MEMORY]   Theme: ${sequencePlan.theme}`);
    console.log(`[CREATE-MEMORY]   Ordered IDs (story order): [${plan.order.join(',')}]`);
    const orderedFilenamesForLogging = plan.order.map(i => photos[i]?.filename || photos[i]?.originalName || `image_${i}`);
    console.log(`[CREATE-MEMORY]   ORDERED filenames (AI storytelling order): [${orderedFilenamesForLogging.join(', ')}]`);
    console.log('[CREATE-MEMORY] ========================================');
    
    // PHASE D: Rendering step
    currentStep = 'rendering';
    
    console.log(`[CREATE-MEMORY] Starting rendering step...`);
    console.log(`[CREATE-MEMORY] Plan summary: ${plan.order.length} photos, ${plan.transitions.length} transitions`);
    
    // Correct mapping: plan.selected = indices into uploadedFiles, plan.order = indices into selectedFiles
    // Step 1: Get selected files from uploadedFiles using plan.selected
    const selectedFiles = plan.selected.map(i => {
      if (i >= 0 && i < photos.length) {
        return photos[i];
      }
      throw new Error(`Invalid photo index ${i} in plan.selected (photos.length=${photos.length})`);
    });
    
    // Step 2: Build ordered files from plan.order
    // NOTE: With 3-stage pipeline, plan.order contains direct photo indices (0..N-1) in story order
    // Since plan.selected = [0,1,2,...,N-1], we need to convert order to selected-space indices
    // For each ordered_id, find its index in selected array: order_in_selected = selected.indexOf(ordered_id)
    // But since selected = [0,1,2,...,N-1], selected[i] = i, so order_in_selected = ordered_id
    // So plan.order is already in the correct format for renderFromPlan!
    
    // However, renderFromPlan expects order to be indices into selected array
    // If selected = [0,1,2,...,N-1], then order = [5,2,0] means selectedFiles[5], selectedFiles[2], selectedFiles[0]
    // which is photos[5], photos[2], photos[0] - correct!
    
    const orderedFiles = plan.order.map(orderedId => {
      // Find index in selected array
      const selectedIndex = plan.selected.indexOf(orderedId);
      if (selectedIndex === -1) {
        throw new Error(`Ordered ID ${orderedId} not found in selected array [${plan.selected.join(',')}]`);
      }
      if (selectedIndex >= 0 && selectedIndex < selectedFiles.length) {
        return selectedFiles[selectedIndex];
      }
      throw new Error(`Invalid selected index ${selectedIndex} (from ordered ID ${orderedId})`);
    });
    
    // Extract filenames for path mapping
    const orderedPhotoFilenames = orderedFiles.map(f => f.filename || f.originalName);
    
    // Log planner details
    console.log("[PLANNER] usedPlanner=", plan.usedPlanner || 'unknown');
    console.log("[PLANNER] selected=", plan.selected);
    console.log("[PLANNER] order (direct photo indices)=", plan.order);
    console.log("[PLANNER] orderedFilenames=", orderedFiles.map(f => f.filename || f.originalName));
    
    console.log(`[CREATE-MEMORY] ========================================`);
    console.log(`[CREATE-MEMORY] Photo mapping:`);
    console.log(`[CREATE-MEMORY]   Uploaded files: ${photos.length} total`);
    console.log(`[CREATE-MEMORY]   Selected indices: [${plan.selected.join(',')}] -> ${selectedFiles.length} files`);
    console.log(`[CREATE-MEMORY]   Order (direct photo indices in story order): [${plan.order.join(',')}]`);
    console.log(`[CREATE-MEMORY]   Upload order filenames: [${photos.map((p, i) => `${i}:${p.filename || p.originalName}`).join(', ')}]`);
    console.log(`[CREATE-MEMORY]   Storytelling order filenames: [${orderedPhotoFilenames.map((f, i) => `${i}:${f}`).join(', ')}]`);
    console.log(`[CREATE-MEMORY] ========================================`);
    
    // Build photoPathsMap: map photo filenames to file paths (use absolute paths)
    const photoPathsMap = {};
    for (const photo of orderedFiles) {
      const filename = photo.filename || photo.originalName;
      // Try storedPath first (from upload), then resolve from session dir
      const photoPath = photo.storedPath || path.resolve(uploadsSessionDir, filename);
      if (!existsSync(photoPath)) {
        console.error(`[CREATE-MEMORY] Photo file not found: ${filename} at ${photoPath}`);
        throw new Error(`Photo file not found: ${filename} at ${photoPath}`);
      }
      photoPathsMap[filename] = photoPath;
    }
    
    // Render video - use unique filename to avoid caching (use absolute path)
    const uniqueId = `${sessionId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const outputPath = path.resolve(outputsDir, `${uniqueId}.mp4`);
    console.log(`[CREATE-MEMORY] Output path: ${outputPath}`);
    
    // Pass both plan and photos array to renderFromPlan with fps and output dimensions
    console.log(`[CREATE-MEMORY] Calling renderFromPlan with fps=${targetFps}, output=${outputWidth}x${outputHeight}...`);
    // #region agent log
    const logDataC2 = {location:'server/index.js:1813',message:'calling renderFromPlan with dimensions',data:{outputWidth:outputWidth,outputHeight:outputHeight,targetFps:targetFps},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'};
    console.log('[DEBUG][HYPOTHESIS-C]', JSON.stringify(logDataC2, null, 2));
    fetch('http://127.0.0.1:7243/ingest/f4f24cf3-2bc7-4b8e-b302-87560292ba98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(logDataC2)}).catch(()=>{});
    // #endregion
    
    await renderFromPlan(plan, photoPathsMap, outputPath, sessionId, photos, targetFps, outputWidth, outputHeight, progressReporter);
    console.log(`[CREATE-MEMORY] renderFromPlan completed`);
    
    // PHASE D: Saving/verification step
    currentStep = 'saving';
    
    // Verify video file was created
    if (!existsSync(outputPath)) {
      throw new Error(`Video file was not created at ${outputPath}`);
    }
    
    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw new Error('Video file is empty');
    }
    
    console.log(`[VIDEO] Video created successfully: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    
    // Get video duration for music selection
    let videoDuration = 0;
    try {
      const videoInfo = await ffprobeInfo(outputPath, { ffprobePath: getFfprobePath() });
      if (videoInfo.video) {
        // Get duration from format using spawn (already imported)
        const duration = await new Promise((resolve, reject) => {
          const proc = spawn(getFfprobePath(), [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            outputPath
          ], { stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          proc.stdout.on('data', (d) => { stdout += d.toString(); });
          proc.on('close', (code) => {
            if (code === 0) resolve(parseFloat(stdout.trim()) || 0);
            else reject(new Error(`ffprobe failed with code ${code}`));
          });
          proc.on('error', reject);
        });
        videoDuration = duration;
        console.log(`[VIDEO] Duration: ${videoDuration.toFixed(2)}s`);
      }
    } catch (durError) {
      console.warn('[VIDEO] Could not determine duration for music selection:', durError.message);
    }
    
    // Select music track based on story signals (story-aware, deterministic)
    let musicTrack = null;
    if (videoDuration > 0 && analysisResults && analysisResults.length > 0) {
      try {
        const { selectMusicTrack } = await import('./utils/musicSelector.js');
        const musicBucket = process.env.MUSIC_BUCKET || S3_BUCKET;
        const musicPrefix = process.env.MUSIC_PREFIX || 'music/';
        
        // Get durations from plan if available
        const durations = plan.durations && plan.durations.length > 0 
          ? plan.durations 
          : [];
        
        musicTrack = await selectMusicTrack({
          totalDurationSec: videoDuration,
          photoCount: photos.length,
          analysisResults: analysisResults,
          durations: durations,
          promptText: promptText || '',
          s3Client: s3,
          bucket: musicBucket,
          musicPrefix: musicPrefix,
          usedTrackId: null // TODO: Track recently used tracks
        });
        
        if (musicTrack) {
          console.log('[MUSIC] Track selected for finalization:', musicTrack.id);
        } else {
          console.warn('[MUSIC] No music track selected');
        }
      } catch (musicError) {
        console.error('[MUSIC] Music selection failed:', musicError.message);
        // Continue without music
      }
    }
    
    const videoFilename = path.basename(outputPath);
    
    // Upload final video to S3 (uploader will finalize to _web.mp4 for videos/published/*.mp4)
    console.log('[RENDER] Uploading to S3...');
    const { key: s3Key, s3Url: videoUrl, s3UrlUnsigned, resourcePath, cdnUrl } = await uploadFinalVideoToS3(outputPath, videoFilename, musicTrack);
    console.log('[RENDER] S3 upload complete:', { s3Key, resourcePath });
    
    // Clean up local files after successful upload
    try {
      // Delete the rendered video file
      if (existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log('[CLEANUP] Deleted local video file:', outputPath);
      }
      
      // Delete the session upload directory if it exists
      if (existsSync(uploadsSessionDir)) {
        fs.rmSync(uploadsSessionDir, { recursive: true, force: true });
        console.log('[CLEANUP] Deleted session upload directory:', uploadsSessionDir);
      }
    } catch (cleanupError) {
      // Log but don't fail the request if cleanup fails
      console.warn('[CLEANUP] Failed to delete local files:', cleanupError.message);
    }
    
    // videoUrl is the signed S3 URL (primary - always works)
    // cdnUrl is optional CloudFront URL (frontend will test it)
    
    // Store render info for debug endpoint
    // CRITICAL: Create a safe copy of plan without any legacy fields
    if (global.lastRenderInfo) {
      // Create safe plan copy - only include expected fields
      const safePlan = {
        selected: plan.selected,
        order: plan.order,
        durations: plan.durations,
        transitions: plan.transitions,
        chapterCuts: plan.chapterCuts,
        memoryNote: plan.memoryNote,
        usedPlanner: plan.usedPlanner
      };
      global.lastRenderInfo.plan = safePlan;
      global.lastRenderInfo.outputUrl = videoUrl;
    }
    
    // Report completion progress
    if (progressReporter) {
      progressReporter.report('finalizing', PROGRESS_WEIGHTS.FINALIZE.end, 'Finalizing...');
    }
    
    // Return safe plan copy (never include beats)
    // CRITICAL: Ensure plan is not null before accessing properties
    if (!plan || typeof plan !== 'object') {
      throw new Error('Plan is null or invalid after rendering');
    }
    
    const safePlanForResponse = {
      selected: Array.isArray(plan.selected) ? plan.selected : [],
      order: Array.isArray(plan.order) ? plan.order : [],
      durations: Array.isArray(plan.durations) ? plan.durations : [],
      transitions: Array.isArray(plan.transitions) ? plan.transitions : [],
      chapterCuts: plan.chapterCuts || {},
      memoryNote: typeof plan.memoryNote === 'string' ? plan.memoryNote : '',
      usedPlanner: plan.usedPlanner || 'fallback'
    };
    
    // Generate beats array from durations
    const beats = Array.isArray(plan.durations) 
      ? plan.durations.map((d, i) => ({ index: i, duration: d }))
      : [];
    
    // Response includes both videoUrl (signed S3 - primary) and cdnUrl (optional CloudFront)
    const responseData = {
      success: true,
      memoryId: sessionId,
      videoUrl: videoUrl,  // Signed S3 URL (primary - always works)
      cdnUrl: cdnUrl || null,  // Optional CloudFront URL (frontend tests it)
      s3Key: s3Key || null,  // S3 key for debugging/retry
      s3Url: s3UrlUnsigned || null,  // Unsigned S3 URL for reference
      resourcePath: resourcePath || null,  // Path for CloudFront (/videos/published/filename.mp4)
      memoryNote: safePlanForResponse.memoryNote,
      usedPlanner: safePlanForResponse.usedPlanner,
      beats: beats,
      plan: safePlanForResponse
    };
    
    // Validate required fields
    if (!responseData.videoUrl) {
      console.warn('[CREATE-MEMORY] WARNING: videoUrl (signed S3 URL) is missing in response');
    }
    if (!responseData.s3Key) {
      console.warn('[CREATE-MEMORY] WARNING: s3Key is missing in response');
    }
    
    console.log(`[CREATE-MEMORY] Success response:`);
    console.log(`[CREATE-MEMORY]   usedPlanner: ${responseData.usedPlanner}`);
    console.log(`[CREATE-MEMORY]   videoUrl: ${responseData.videoUrl ? responseData.videoUrl.split('?')[0] + '...' : 'N/A'}`); // Log domain only, not query string
    console.log(`[CREATE-MEMORY]   cdnUrl: ${responseData.cdnUrl || 'N/A'}`);
    console.log(`[CREATE-MEMORY]   s3Key: ${responseData.s3Key}`);
    console.log(`[CREATE-MEMORY]   resourcePath: ${responseData.resourcePath}`);
    console.log(`[CREATE-MEMORY]   memoryNote: ${responseData.memoryNote}`);
    
    // If SSE, send completion event; otherwise send JSON response
    if (progressReporter) {
      progressReporter.complete(responseData);
    } else {
      res.json(responseData);
    }
  } catch (error) {
    // PHASE A: Comprehensive error logging and response
    console.error(`[CREATE-MEMORY] ========================================`);
    console.error(`[CREATE-MEMORY] ERROR at step "${currentStep}":`, error);
    console.error(`[CREATE-MEMORY] Error type:`, error?.constructor?.name || typeof error);
    
    // Log full error details (including stack trace) but NOT API keys
    if (error instanceof Error) {
      console.error(`[CREATE-MEMORY] Error message:`, error.message);
      if (error.stack) {
        // Sanitize stack trace (remove API keys)
        const sanitizedStack = error.stack.replace(/sk-[a-zA-Z0-9]{32,}/g, '[API_KEY_REDACTED]');
        console.error(`[CREATE-MEMORY] Error stack trace:`, sanitizedStack);
      }
    }
    
    // Extract error message safely
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message || 'Unknown error';
    } else if (typeof error === 'string') {
      errorMessage = error;
    }
    
    // Sanitize error message (remove API keys if any)
    errorMessage = errorMessage.replace(/sk-[a-zA-Z0-9]{32,}/g, '[API_KEY_REDACTED]');
    
    // If error mentions beats, it's likely from plan serialization - provide clearer message
    if (errorMessage.toLowerCase().includes('beats')) {
      console.error('[CREATE-MEMORY] ERROR: Detected "beats" in error message - this should not happen!');
      console.error('[CREATE-MEMORY] This suggests plan object has beats property or plan is null');
      errorMessage = `Plan validation failed at step "${currentStep}". Please check server logs.`;
    }
    
    // Get FFmpeg stderr if available (from error object or last render info)
    let ffmpegStderr = null;
    if (error.ffmpegStderr) {
      // Error object has stderr attached
      ffmpegStderr = error.ffmpegStderr;
    } else if (global.lastRenderInfo?.ffmpegStderrLast200Lines) {
      // Get from last render info
      ffmpegStderr = global.lastRenderInfo.ffmpegStderrLast200Lines;
    }
    
    // Log FFmpeg command if available
    let ffmpegCommand = null;
    if (error.ffmpegCommand) {
      ffmpegCommand = error.ffmpegCommand;
    } else if (global.lastRenderInfo?.lastFfmpegCommand) {
      ffmpegCommand = global.lastRenderInfo.lastFfmpegCommand;
    } else if (global.lastRenderInfo?.finalCmd) {
      ffmpegCommand = global.lastRenderInfo.finalCmd;
    }
    
    if (ffmpegCommand) {
      // Sanitize command (remove API keys if any)
      const sanitizedCmd = ffmpegCommand.replace(/sk-[a-zA-Z0-9]{32,}/g, '[API_KEY_REDACTED]');
      console.error(`[CREATE-MEMORY] FFmpeg command:`, sanitizedCmd);
    }
    
    if (ffmpegStderr) {
      console.error(`[CREATE-MEMORY] FFmpeg stderr (last 200 lines):`);
      console.error(ffmpegStderr);
    }
    
    // Truncate error message if too long
    if (errorMessage.length > 500) {
      errorMessage = errorMessage.substring(0, 500) + '...';
    }
    
    // Truncate stderr if too long (keep last 2000 chars)
    if (ffmpegStderr && ffmpegStderr.length > 2000) {
      ffmpegStderr = '...' + ffmpegStderr.slice(-2000);
    }
    
    console.error(`[CREATE-MEMORY] Returning error response:`, { 
      error: 'Video generation failed', 
      details: errorMessage, 
      step: currentStep,
      hasFfmpegStderr: !!ffmpegStderr
    });
    console.error(`[CREATE-MEMORY] ========================================`);
    
    // If SSE was enabled, send error via progress reporter
    if (progressReporter) {
      progressReporter.error(new Error(errorMessage), currentStep, ffmpegStderr ? { ffmpegStderr } : null);
      return;
    }
    
    // Otherwise return JSON error
    const errorResponse = {
      error: 'Video generation failed',
      details: errorMessage,
      step: currentStep
    };
    
    // Include FFmpeg stderr if available
    if (ffmpegStderr) {
      errorResponse.ffmpegStderr = ffmpegStderr;
    }
    
    res.status(500).json(errorResponse);
  }
});

// REMOVED: Duplicate /api/media/signed-url endpoint - using updated version below (line ~3147)

// Health check endpoint
app.get('/api/health', async (req, res) => {
  let ffmpegAvailable = false;
  let ffmpegVersion = null;
  let ffmpegPath = null;
  
  // Test FFmpeg by running -version command
  try {
    ffmpegPath = getFfmpegPath();
    if (ffmpegPath) {
      const versionResult = spawnSync(ffmpegPath, ['-version'], {
        stdio: 'pipe',
        windowsHide: true,
        timeout: 5000,
        encoding: 'utf8'
      });
      
      if (versionResult.status === 0) {
        ffmpegAvailable = true;
        if (versionResult.stdout) {
          const versionOutput = versionResult.stdout.toString();
          // Extract version number (e.g., "ffmpeg version 6.0")
          const versionMatch = versionOutput.match(/ffmpeg version (\S+)/);
          if (versionMatch) {
            ffmpegVersion = versionMatch[1];
          }
        }
      }
    }
  } catch (error) {
    // FFmpeg not available - continue with false
  }
  
  // Check OpenAI API key (never log the key itself)
  const openaiKeyLoaded = !!process.env.OPENAI_API_KEY;
  const openaiKeyLast4 = process.env.OPENAI_API_KEY 
    ? process.env.OPENAI_API_KEY.slice(-4) 
    : null;
  
  // Check directories exist (use same dirs as defined at top of file)
  const tmpDir = path.join(__dirname, 'tmp');
  const outputsDir = path.join(process.cwd(), 'outputs');
  const uploadsDir = path.join(__dirname, 'uploads');
  const tmpExists = existsSync(tmpDir);
  const outputsExists = existsSync(outputsDir);
  const uploadsExists = existsSync(uploadsDir);
  
  res.json({
    ok: true,
    build: BUILD_STAMP,
    port: PORT,
    openaiKeyLoaded,
    ffmpegAvailable,
    ffmpegPath,
    ffmpegVersion,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    directories: {
      tmp: tmpDir,
      outputs: outputsDir,
      uploads: uploadsDir,
      tmpExists,
      outputsExists,
      uploadsExists
    }
  });
  
  // Log status (never log full API key)
  if (req.query.verbose) {
    console.log(`[HEALTH] FFmpeg: ${ffmpegAvailable ? 'available' : 'not found'}`);
    console.log(`[HEALTH] OpenAI API key: ${openaiKeyLoaded ? `loaded (last4: ${openaiKeyLast4})` : 'not set'}`);
    console.log(`[HEALTH] Port: ${PORT}`);
  }
});

// Debug endpoint: get last render info
app.get('/api/debug/last-render', (req, res) => {
  if (!global.lastRenderInfo) {
    return res.status(404).json({
      error: 'No render info available. Generate a video first.'
    });
  }
  
  // Get last 200 lines of stderr if available
  const stderrLines = global.lastRenderInfo.ffmpegStderrLast200Lines || '';
  
  res.json({
    plan: global.lastRenderInfo.plan,
    finalCmd: global.lastRenderInfo.finalCmd,
    filterComplex: global.lastRenderInfo.filterComplex,
    outputPath: global.lastRenderInfo.outputPath,
    outputUrl: global.lastRenderInfo.outputUrl,
    outputSize: global.lastRenderInfo.outputSize || null,
    error: global.lastRenderInfo.error || null,
    ffmpegStderrLast200Lines: stderrLines
  });
});

// Debug endpoint: test xfade with two images (hardcoded simple pipeline)
app.post('/api/debug/xfade-two', async (req, res) => {
  try {
    const { a, b } = req.body;
    
    if (!a || !b) {
      return res.status(400).json({
        error: 'Both "a" and "b" image filenames are required'
      });
    }
    
    const ffmpegPath = getFfmpegPath();
    
    // Find the image files in uploads directory
    const uploadsDir = path.join(__dirname, 'uploads');
    let imageAPath = null;
    let imageBPath = null;
    
    // Search for files recursively
    function findFile(dir, filename) {
      if (!existsSync(dir)) return null;
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
          const found = findFile(fullPath, filename);
          if (found) return found;
        } else if (file.name === filename || file.name.includes(filename)) {
          return fullPath;
        }
      }
      return null;
    }
    
    imageAPath = findFile(uploadsDir, a);
    imageBPath = findFile(uploadsDir, b);
    
    if (!imageAPath || !existsSync(imageAPath)) {
      return res.status(404).json({
        error: `Image A not found: ${a}. Searched in ${uploadsDir}`
      });
    }
    
    if (!imageBPath || !existsSync(imageBPath)) {
      return res.status(404).json({
        error: `Image B not found: ${b}. Searched in ${uploadsDir}`
      });
    }
    
    console.log(`[DEBUG_XFADE] Using images: ${imageAPath}, ${imageBPath}`);
    
    // Create output file
    const outputPath = path.join(outputsDir, `test_xfade_${Date.now()}.mp4`);
    
    // Hardcoded FFmpeg command - exactly as specified in user's Step 1
    const args = [
      '-y',
      '-loop', '1', '-t', '4', '-i', imageAPath,
      '-loop', '1', '-t', '4', '-i', imageBPath,
      '-filter_complex',
      '[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v0];[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v1];[v0][v1]xfade=transition=fade:duration=0.8:offset=3.2,format=yuv420p[v]',
      '-map', '[v]',
      '-r', '30',
      '-c:v', 'libx264',
      outputPath
    ];
    
    console.log(`[DEBUG_XFADE] Running FFmpeg: ${ffmpegPath} ${args.join(' ')}`);
    
    await runFfmpeg(ffmpegPath, args, 'debug-xfade');
    
    if (!existsSync(outputPath)) {
      throw new Error('Output file was not created');
    }
    
    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw new Error('Output file is empty');
    }
    
    console.log(`[DEBUG_XFADE] Success: ${outputPath} (${stats.size} bytes)`);
    
    const videoFilename = path.basename(outputPath);
    const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
    res.json({
      success: true,
      videoUrl: `${baseUrl}/outputs/${videoFilename}`,
      outputPath: outputPath,
      size: stats.size
    });
  } catch (error) {
    console.error('[DEBUG_XFADE] Error:', error);
    res.status(500).json({
      error: 'XFade test failed',
      details: error.message
    });
  }
});

// Legacy endpoint (for compatibility)
app.post('/api/generate-video', async (req, res) => {
  try {
    const { images, sessionId } = req.body;
    
    if (!images || !Array.isArray(images) || images.length < MIN_PHOTOS || images.length > MAX_PHOTOS) {
      return res.status(400).json({
        error: `Please provide between ${MIN_PHOTOS} and ${MAX_PHOTOS} images.`
      });
    }
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    
    // Create simple plan (for legacy endpoint, assume images are paths)
    const photos = images.map((img, i) => ({ 
      filename: path.basename(img), 
      width: 1920, 
      height: 1080,
      sizeBytes: 0
    }));
    const plan = createDeterministicPlan(photos, '');
    
    // Create photo paths map
    const photoPathsMap = {};
    for (let i = 0; i < images.length; i++) {
      const imgPath = images[i];
      // Use storedPath if available (from new upload system), otherwise fallback to filename
      const fileKey = photos[i].storedPath || photos[i].filename || photos[i].originalName;
      photoPathsMap[photos[i].filename] = imgPath;
      // Also map by storedPath if it exists
      if (photos[i].storedPath) {
        photoPathsMap[photos[i].storedPath] = imgPath;
      }
    }
    
    const outputPath = path.join(outputsDir, `${sessionId}.mp4`);
    await renderFromPlan(plan, photoPathsMap, outputPath, sessionId, photos);
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
    res.json({
      success: true,
      videoPath: `${baseUrl}/outputs/${sessionId}.mp4`
    });
  } catch (error) {
    console.error('[VIDEO] Generation error:', error);
    const errorDetails = error.message.length > 300 ? error.message.substring(0, 300) + '...' : error.message;
    res.status(500).json({
      error: 'Video generation failed',
      details: errorDetails
    });
  }
});

// CloudFront signed URL endpoint (register before 404 handler)
// CloudFront signed URL endpoint (register before 404 handler)
app.get('/api/media/signed-url', async (req, res) => {
  try {
    const resourcePath = req.query.path;
    const prefer = (req.query.prefer || '').toString();
    const isDev = process.env.NODE_ENV !== 'production';

    if (!resourcePath || typeof resourcePath !== 'string') {
      return res.status(400).json({ error: 'Query parameter "path" is required' });
    }
    if (!resourcePath.startsWith('/videos/')) {
      return res.status(400).json({ error: 'Path must start with /videos/' });
    }
    if (resourcePath.includes('..') || resourcePath.includes('\\') || resourcePath.includes('://')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const s3Key = resourcePath.startsWith('/') ? resourcePath.slice(1) : resourcePath;

    // CloudFront only in production
    let cdnUrl = null;
    if (!isDev && process.env.CLOUDFRONT_DOMAIN) {
      try {
        const cloudFrontResult = signVideoPath(resourcePath);
        cdnUrl = cloudFrontResult.signedUrl;
      } catch (cloudFrontError) {
        console.warn('[SIGNED_URL] CloudFront signing failed:', cloudFrontError.message);
      }
    }

    let s3SignedUrl = null;
    try {
      s3SignedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          ResponseContentType: 'video/mp4',
          ResponseContentDisposition: 'inline',
        }),
        { expiresIn: 3600 }
      );
    } catch (s3Error) {
      console.error('[SIGNED_URL] S3 presigned URL generation failed:', s3Error.message);
      return res.status(500).json({
        error: 'Failed to generate S3 presigned URL',
        details: s3Error.message,
      });
    }

    const preferredUrl = prefer === 's3' ? s3SignedUrl : (cdnUrl || s3SignedUrl);
    const payload = {
      signedUrl: preferredUrl,
      preferred: prefer === 's3' ? 's3' : (cdnUrl ? 'cdn' : 's3'),
      cdnUrl: cdnUrl || null,
      s3SignedUrl: s3SignedUrl || null,
      resourcePath: resourcePath || null,
    };

    console.log('[SIGNED_URL_PAYLOAD]', JSON.stringify(payload, null, 2));
    return res.json(payload);
  } catch (err) {
    console.error('[SIGNED_URL] Error:', err);
    const status =
      err?.message?.includes('path') || err?.message?.includes('CLOUDFRONT')
        ? 400
        : 500;
    return res.status(status).json({
      error: 'Failed to sign URL',
      details: err?.message || 'Unknown error',
    });
  }
});
console.log('Registered: GET /api/media/signed-url');

// CloudFront signed playback URL (production)
app.get('/api/media/playback-url', (req, res) => {
  try {
    const { path } = req.query;

    if (typeof path !== 'string' || !path) {
      return res.status(400).json({ error: 'Missing required query param: path' });
    }

    if (!path.startsWith('/videos/')) {
      return res.status(400).json({ error: 'Invalid path: must start with /videos/' });
    }

    if (path.includes('..') || path.includes('\\') || path.includes('://')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const lower = path.toLowerCase();
    const allowedExt = ['.mp4', '.mov', '.m4v', '.webm'];
    if (!allowedExt.some(ext => lower.endsWith(ext))) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    const s3Key = path.replace(/^\//, '');
    const playbackUrl = signCloudFrontUrl(s3Key);

    return res.json({ playbackUrl });
  } catch (err) {
    console.error('[playback-url] error', err);
    return res.status(500).json({ error: 'Failed to create playback URL' });
  }
});

// REMOVED: Duplicate /api/media/signed-url endpoint - using updated version above (line ~3147)

// Playback URL endpoint is now registered in server/index.js
// (removed from here to avoid duplication)

// Catch-all error handler - ensure JSON is always returned
app.use((err, req, res, next) => {
  console.error('[SERVER] Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// 404 handler - ensure JSON is returned (must be last, after all routes)
app.use((req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.path}`
  });
});

// Start server with conflict-safe error handling
const server = app.listen(PORT, () => {
  console.log(`[SERVER] listening http://localhost:${PORT}`);
  console.log(`[SERVER] Health check: http://localhost:${PORT}/api/health`);
  console.log('[ROUTES] media playback-url enabled');
  
  if (isFfmpegAvailable()) {
    console.log(`[VIDEO] FFmpeg is available at: ${FFMPEG_PATH}`);
  } else {
    console.warn('[VIDEO] WARNING: FFmpeg not found. Video generation will fail.');
    console.warn('[VIDEO] Please install FFmpeg: winget install Gyan.FFmpeg');
  }
});

// Port conflict detection and cleanup (Windows) - ESM-safe, non-crashing
async function checkPortAndKill(port) {
  try {
    // Windows: find process using port (only LISTENING connections)
    const { stdout } = await exec(`netstat -ano | findstr :${port} | findstr LISTENING`);
    
    if (stdout && stdout.trim()) {
      const lines = stdout.trim().split('\n');
      const pids = new Set();
      lines.forEach(line => {
        // Extract PID from end of line (last column)
        const match = line.match(/\s+(\d+)\s*$/);
        if (match) {
          pids.add(match[1]);
        }
      });
      
      if (pids.size > 0) {
        console.log(`[SERVER] Port ${port} is in use by ${pids.size} process(es):`);
        pids.forEach(pid => {
          console.log(`[SERVER]   PID ${pid}`);
        });
        console.log(`[SERVER] To kill manually, run: taskkill /PID <PID> /F`);
        console.log(`[SERVER] Attempting to auto-kill...`);
        
        // Kill each PID sequentially
        for (const pid of pids) {
          try {
            await exec(`taskkill /PID ${pid} /F /T`);
            console.log(`[SERVER] âœ“ Killed PID ${pid}`);
          } catch (killError) {
            console.warn(`[SERVER] âœ— Failed to kill PID ${pid} (may require admin or already dead)`);
          }
        }
        
        // Give OS time to free port
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log(`[SERVER] Port cleanup complete, continuing startup...`);
      }
    } else {
      console.log(`[SERVER] Port ${port} appears available`);
    }
  } catch (error) {
    // No process found or command failed - that's okay, port is likely available
    if (error.code !== 1) { // code 1 means no match found (expected when port is free)
      console.warn(`[SERVER] Port check failed (non-fatal): ${error.message}`);
    }
    console.log(`[SERVER] Continuing startup...`);
  }
}

// Handle port conflicts and other server errors
server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[SERVER] Port ${PORT} already in use. Attempting to free it...`);
    await checkPortAndKill(PORT);
    // Try again after cleanup
    setTimeout(() => {
      console.log(`[SERVER] Retrying to start server on port ${PORT}...`);
      app.listen(PORT, () => {
        console.log(`[SERVER] listening http://localhost:${PORT}`);
        console.log(`[SERVER] Health check: http://localhost:${PORT}/api/health`);
      });
    }, 2000);
  } else {
    throw err;
  }
});

// Graceful shutdown handlers
process.on('SIGINT', () => {
  console.log('[SERVER] Shutting down...');
  server.close(() => {
    console.log('[SERVER] Server closed.');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('[SERVER] Shutting down...');
  server.close(() => {
    console.log('[SERVER] Server closed.');
    process.exit(0);
  });
});
