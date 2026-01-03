/**
 * Auto-Reframe System (Backend JavaScript implementation)
 * Automatically fixes image orientation and computes smart crop rectangles
 * for consistent documentary-style framing.
 */

import sharp from 'sharp';
import { promises as fsp } from 'fs';
import path from 'path';

/**
 * @typedef {Object} FramePlan
 * @property {0|90|180|270} rotationDeg - Rotation in degrees
 * @property {{x:number, y:number, w:number, h:number}} crop - Crop rectangle (in rotated coordinates)
 * @property {number} confidence - Confidence score (0-1)
 * @property {string} reason - Human-readable reason for the plan
 * @property {{x:number, y:number}} [anchor] - Anchor point used (normalized 0-1, in rotated coordinates)
 * @property {boolean} [needsReview] - Whether manual review is recommended
 */

// In-memory cache for frame plans: Map<(imageKey, targetAspect), FramePlan>
// Limited to 2000 entries (LRU-style eviction)
const framePlanCache = new Map();
const MAX_CACHE_SIZE = 2000;

/**
 * Generate cache key from image key and target aspect ratio
 */
function getCacheKey(imageKey, targetAspect) {
  return `${imageKey}:${targetAspect.toFixed(4)}`;
}

/**
 * Evict oldest cache entries if cache exceeds MAX_CACHE_SIZE
 * Uses simple FIFO eviction (Map iteration order is insertion order)
 */
function evictCacheIfNeeded() {
  if (framePlanCache.size > MAX_CACHE_SIZE) {
    const entriesToRemove = framePlanCache.size - MAX_CACHE_SIZE;
    const keysToRemove = [];
    let count = 0;
    for (const key of framePlanCache.keys()) {
      if (count >= entriesToRemove) break;
      keysToRemove.push(key);
      count++;
    }
    for (const key of keysToRemove) {
      framePlanCache.delete(key);
    }
  }
}

/**
 * Compute gradient magnitude (Sobel) as energy map from grayscale image
 * @param {Buffer} imageBuffer - Image buffer (RGB)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Float32Array} Energy map (width * height)
 */
function computeGradientEnergy(imageBuffer, width, height) {
  const energy = new Float32Array(width * height);
  const stride = width * 3; // RGB

  // Convert to grayscale and compute gradients
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * stride + x * 3;
      
      // Grayscale: 0.299*R + 0.587*G + 0.114*B
      const gray = 0.299 * imageBuffer[idx] + 0.587 * imageBuffer[idx + 1] + 0.114 * imageBuffer[idx + 2];
      const grayLeft = 0.299 * imageBuffer[idx - 3] + 0.587 * imageBuffer[idx - 2] + 0.114 * imageBuffer[idx - 1];
      const grayRight = 0.299 * imageBuffer[idx + 3] + 0.587 * imageBuffer[idx + 2] + 0.114 * imageBuffer[idx + 3];
      const upIdx = (y - 1) * stride + x * 3;
      const downIdx = (y + 1) * stride + x * 3;
      const grayUp = 0.299 * imageBuffer[upIdx] + 0.587 * imageBuffer[upIdx + 1] + 0.114 * imageBuffer[upIdx + 2];
      const grayDown = 0.299 * imageBuffer[downIdx] + 0.587 * imageBuffer[downIdx + 1] + 0.114 * imageBuffer[downIdx + 2];
      
      // Sobel gradients
      const gx = grayRight - grayLeft;
      const gy = grayDown - grayUp;
      
      // Gradient magnitude
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      energy[y * width + x] = magnitude;
    }
  }

  return energy;
}

/**
 * Find peak in energy map and compute confidence
 * @param {Float32Array} energy - Energy map
 * @param {number} width - Map width
 * @param {number} height - Map height
 * @param {number} peakMeanRatioThreshold - Threshold for peak/mean ratio (default: 2.0)
 * @returns {{x:number, y:number, score:number, confidence:number, peakMeanRatio:number}} Peak location (normalized 0-1), score, and confidence
 */
function findEnergyPeak(energy, width, height, peakMeanRatioThreshold = 2.0) {
  // Find peak
  let maxIdx = 0;
  let maxVal = energy[0];
  let sum = energy[0];

  for (let i = 1; i < energy.length; i++) {
    if (energy[i] > maxVal) {
      maxVal = energy[i];
      maxIdx = i;
    }
    sum += energy[i];
  }

  const mean = sum / energy.length;
  const peakMeanRatio = mean > 0 ? maxVal / mean : 0;
  
  const x = (maxIdx % width) / width;
  const y = Math.floor(maxIdx / width) / height;

  // Confidence based on peak/mean ratio
  const confidence = peakMeanRatio >= peakMeanRatioThreshold ? 0.7 : Math.max(0.3, 0.5 * (peakMeanRatio / peakMeanRatioThreshold));
  const score = maxVal; // Raw score

  return { x, y, score, confidence, peakMeanRatio };
}

/**
 * Compute crop rectangle for target aspect ratio (in rotated coordinates)
 */
function computeCropRect(srcWidth, srcHeight, targetAspect, anchorX = 0.5, anchorY = 0.5, headroomBias = 0) {
  const srcAspect = srcWidth / srcHeight;

  // If aspect ratios are very close (within ±2%), no crop needed
  if (Math.abs(srcAspect - targetAspect) <= 0.02) {
    return {
      x: 0,
      y: 0,
      w: srcWidth,
      h: srcHeight,
    };
  }

  let cropW, cropH;

  if (srcAspect > targetAspect) {
    // Source is wider - crop width
    cropH = srcHeight;
    cropW = cropH * targetAspect;
  } else {
    // Source is taller - crop height
    cropW = srcWidth;
    cropH = cropW / targetAspect;
  }

  // Clamp crop dimensions
  cropW = Math.min(cropW, srcWidth);
  cropH = Math.min(cropH, srcHeight);

  // Calculate anchor point in pixels
  let anchorPixelX = anchorX * srcWidth;
  let anchorPixelY = anchorY * srcHeight;

  // Apply headroom bias (shift anchor up)
  if (headroomBias > 0) {
    anchorPixelY = Math.max(0, anchorPixelY - cropH * headroomBias);
  }

  // Center crop window on anchor, clamped to bounds
  let cropX = anchorPixelX - cropW / 2;
  let cropY = anchorPixelY - cropH / 2;

  // Clamp to bounds
  cropX = Math.max(0, Math.min(cropX, srcWidth - cropW));
  cropY = Math.max(0, Math.min(cropY, srcHeight - cropH));

  return {
    x: Math.round(cropX),
    y: Math.round(cropY),
    w: Math.round(cropW),
    h: Math.round(cropH),
  };
}

/**
 * Validate crop rectangle coordinates (for testing/debugging)
 * @param {Object} crop - Crop rectangle {x, y, w, h}
 * @param {number} srcWidth - Source width (in rotated coordinates)
 * @param {number} srcHeight - Source height (in rotated coordinates)
 * @param {number} targetAspect - Target aspect ratio
 * @returns {{valid:boolean, errors:Array<string>}}
 */
export function validateCropRect(crop, srcWidth, srcHeight, targetAspect) {
  const errors = [];
  const tolerance = 0.02;

  // Check bounds
  if (crop.x < 0) errors.push(`crop.x (${crop.x}) < 0`);
  if (crop.y < 0) errors.push(`crop.y (${crop.y}) < 0`);
  if (crop.x + crop.w > srcWidth) errors.push(`crop.x + crop.w (${crop.x + crop.w}) > srcWidth (${srcWidth})`);
  if (crop.y + crop.h > srcHeight) errors.push(`crop.y + crop.h (${crop.y + crop.h}) > srcHeight (${srcHeight})`);

  // Check aspect ratio
  const cropAspect = crop.w / crop.h;
  const aspectDiff = Math.abs(cropAspect - targetAspect);
  if (aspectDiff > tolerance) {
    errors.push(`crop aspect (${cropAspect.toFixed(4)}) differs from target (${targetAspect.toFixed(4)}) by ${aspectDiff.toFixed(4)}`);
  }

  // Check dimensions
  if (crop.w <= 0) errors.push(`crop.w (${crop.w}) <= 0`);
  if (crop.h <= 0) errors.push(`crop.h (${crop.h}) <= 0`);
  if (crop.w > srcWidth) errors.push(`crop.w (${crop.w}) > srcWidth (${srcWidth})`);
  if (crop.h > srcHeight) errors.push(`crop.h (${crop.h}) > srcHeight (${srcHeight})`);

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Create frame plan for an image (buffer-only API)
 * NOTE: This function does NOT rotate pixels - it only reads EXIF and computes crop in rotated coordinates.
 * Rotation is performed by applyFramePlan.
 * 
 * @param {Buffer} inputBuffer - Image buffer
 * @param {number} targetAspect - Target aspect ratio (width/height)
 * @param {Object} opts - Options
 * @param {string} [opts.imageKey] - Optional image key for caching
 * @returns {Promise<FramePlan>}
 */
export async function createFramePlan(
  inputBuffer,
  targetAspect = 16 / 9,
  opts = {}
) {
  const imageKey = opts.imageKey;
  const confidenceThreshold = opts.confidenceThreshold ?? 0.55;
  const headroomBias = opts.headroomBias ?? 0.075;
  const maxScoreDimension = opts.maxScoreDimension ?? 256;
  const peakMeanRatioThreshold = opts.peakMeanRatioThreshold ?? 2.0;
  const highConfidenceThreshold = opts.highConfidenceThreshold ?? 0.75;

  // Check cache if imageKey provided
  if (imageKey) {
    const cacheKey = getCacheKey(imageKey, targetAspect);
    const cached = framePlanCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  // Load image with sharp (do NOT rotate yet - we only read metadata)
  const image = sharp(inputBuffer);

  // Get metadata (includes EXIF orientation)
  const metadata = await image.metadata();
  const { width, height, orientation, format } = metadata;

  // Step 1: Determine rotation from EXIF (but do NOT apply rotation yet)
  let rotationDeg = 0;
  if (orientation) {
    switch (orientation) {
      case 1:
        rotationDeg = 0;
        break;
      case 3:
        rotationDeg = 180;
        break;
      case 6:
        rotationDeg = 90;
        break;
      case 8:
        rotationDeg = 270;
        break;
      default:
        rotationDeg = 0;
    }
  }

  // Step 2: Determine dimensions AFTER rotation (but before actually rotating)
  // When we rotate 90/270, dimensions swap
  let rotatedWidth = width;
  let rotatedHeight = height;
  if (orientation && (orientation === 6 || orientation === 8)) {
    // 90° or 270° rotation swaps width/height
    rotatedWidth = height;
    rotatedHeight = width;
  }

  // Step 3: Find anchor point using gradient energy (saliency)
  // We compute on the rotated dimensions since crop will be in rotated coordinates
  let anchorX = 0.5;
  let anchorY = 0.5;
  let confidence = 0.5;
  let reason = 'center fallback';

  try {
    // Resize for energy computation (downsample to maxScoreDimension on long edge)
    const scale = Math.min(maxScoreDimension / rotatedWidth, maxScoreDimension / rotatedHeight);
    const scoreWidth = Math.round(rotatedWidth * scale);
    const scoreHeight = Math.round(rotatedHeight * scale);

    // Get image in final orientation for energy computation (rotate here for analysis only)
    let normalized = image.clone();
    if (orientation && orientation !== 1) {
      normalized = normalized.rotate(); // Auto-rotates based on EXIF for analysis
    }
    normalized = normalized.resize(scoreWidth, scoreHeight, { fit: 'fill' });

    // Get raw RGB data
    const { data, info } = await normalized.raw().toBuffer({ resolveWithObject: true });

    // Compute gradient energy map
    const energy = computeGradientEnergy(data, info.width, info.height);
    const peak = findEnergyPeak(energy, info.width, info.height, peakMeanRatioThreshold);

    if (peak.peakMeanRatio >= peakMeanRatioThreshold) {
      anchorX = peak.x;
      anchorY = peak.y;
      confidence = peak.confidence;
      reason = `gradient energy peak (ratio=${peak.peakMeanRatio.toFixed(2)})`;
    } else {
      // Peak/mean ratio too low, use center with reduced confidence
      anchorX = 0.5;
      anchorY = 0.5;
      confidence = peak.confidence;
      reason = `low energy contrast (ratio=${peak.peakMeanRatio.toFixed(2)}, using center)`;
    }
  } catch (err) {
    console.warn('[AUTO-REFRAme] Error computing energy map:', err.message);
    // Fallback to center
    anchorX = 0.5;
    anchorY = 0.5;
    confidence = 0.3;
    reason = 'energy computation error';
  }

  // Step 4: Improve anchor stability - clamp anchorY to [20%, 80%] unless confidence is very high
  if (confidence < highConfidenceThreshold) {
    const originalAnchorY = anchorY;
    anchorY = Math.max(0.2, Math.min(0.8, anchorY));
    if (originalAnchorY !== anchorY) {
      reason += ` (anchorY clamped ${originalAnchorY.toFixed(2)}->${anchorY.toFixed(2)})`;
    }
  }

  // Step 5: Compute crop rectangle (in rotated coordinates)
  let crop = computeCropRect(
    rotatedWidth,
    rotatedHeight,
    targetAspect,
    anchorX,
    anchorY,
    headroomBias
  );
  
  // Safe mode: very low confidence (< 0.35) falls back to center crop
  // This prevents drawing attention to questionable crops
  let safeModeUsed = false;
  if (confidence < 0.35) {
    // Force center crop for extremely low confidence
    crop = computeCropRect(
      rotatedWidth,
      rotatedHeight,
      targetAspect,
      0.5, // Center anchor
      0.5, // Center anchor
      0 // No headroom bias
    );
    reason = `low confidence (${confidence.toFixed(2)}), forced center crop`;
    safeModeUsed = true;
    console.warn(`[AUTO-REFRAme] Safe mode: confidence ${confidence.toFixed(2)} < 0.35, using center crop`);
  }

  // Validate crop coordinates (development/debugging)
  if (process.env.NODE_ENV === 'development') {
    const validation = validateCropRect(crop, rotatedWidth, rotatedHeight, targetAspect);
    if (!validation.valid) {
      console.warn('[AUTO-REFRAme] Crop validation failed:', validation.errors);
    }
  }

  const plan = {
    rotationDeg,
    crop,
    confidence,
    reason,
    anchor: { x: anchorX, y: anchorY },
    needsReview: confidence < confidenceThreshold,
    format, // Store original format for applyFramePlan
    safeModeUsed, // Flag for logging
  };

  // Cache if imageKey provided
  if (imageKey) {
    const cacheKey = getCacheKey(imageKey, targetAspect);
    framePlanCache.set(cacheKey, plan);
    evictCacheIfNeeded(); // Evict if cache is too large
  }

  return plan;
}

/**
 * Apply frame plan to an image (buffer-only API)
 * Performs rotation (based on EXIF) and then applies crop in rotated coordinates.
 * 
 * @param {Buffer} inputBuffer - Source image buffer
 * @param {FramePlan} plan - Frame plan to apply
 * @returns {Promise<Buffer>} Processed image buffer
 */
export async function applyFramePlan(inputBuffer, plan) {
  const image = sharp(inputBuffer);
  let pipeline = image.clone();

  // Step 1: Rotate based on EXIF orientation (happens exactly once here)
  // sharp.rotate() without arguments auto-rotates based on EXIF and strips EXIF orientation tag
  pipeline = pipeline.rotate(); // Auto-rotates based on EXIF, strips orientation tag

  // Step 2: Crop (in rotated coordinates)
  const { crop, format } = plan;
  pipeline = pipeline.extract({
    left: crop.x,
    top: crop.y,
    width: crop.w,
    height: crop.h,
  });

  // Step 3: Output - preserve format where possible, use high-quality JPEG if needed
  if (format === 'jpeg' || format === 'jpg') {
    // Preserve JPEG format with high quality (92-95)
    return await pipeline.jpeg({ quality: 94, mozjpeg: true }).toBuffer();
  } else if (format === 'png') {
    // Preserve PNG format
    return await pipeline.png().toBuffer();
  } else if (format === 'webp') {
    // Preserve WebP format
    return await pipeline.webp({ quality: 94 }).toBuffer();
  } else {
    // Fallback to high-quality JPEG
    return await pipeline.jpeg({ quality: 94, mozjpeg: true }).toBuffer();
  }
}

/**
 * Clear frame plan cache (useful for testing or memory management)
 */
export function clearFramePlanCache() {
  framePlanCache.clear();
}

/**
 * Get cache statistics (useful for debugging)
 */
export function getCacheStats() {
  return {
    size: framePlanCache.size,
    maxSize: MAX_CACHE_SIZE,
  };
}

/**
 * Create frame plans for multiple images in batch
 * @param {Array<{buffer: Buffer, imageKey?: string, targetAspect?: number, opts?: Object}>} inputs - Array of inputs
 * @param {number} defaultTargetAspect - Default target aspect ratio if not specified per input
 * @returns {Promise<Array<FramePlan>>} Array of frame plans
 */
export async function createFramePlansBatch(inputs, defaultTargetAspect = 16 / 9) {
  const plans = await Promise.all(
    inputs.map(async (input) => {
      const buffer = input.buffer;
      const targetAspect = input.targetAspect ?? defaultTargetAspect;
      const opts = input.opts || {};
      if (input.imageKey) {
        opts.imageKey = input.imageKey;
      }
      return createFramePlan(buffer, targetAspect, opts);
    })
  );
  return plans;
}
