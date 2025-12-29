/**
 * Template pack for memory video generation
 * Cinematic motion using crop-box animation with eased interpolation
 * 
 * Core principles:
 * - No randomness per frame (one seed per image, then deterministic)
 * - Eased interpolation: easeInOutSine(t) = 0.5 - 0.5 * Math.cos(PI * t)
 * - Crop-box animation (not position jitter)
 * - Shot logic by beat position (intro/development/climax/resolve)
 */

import { createHash } from 'crypto';

// Global gallery mode toggle to enforce premium, no-jitter motion
const galleryMode = true;

/**
 * Eased interpolation function (ease in-out sine)
 * @param {number} t - Progress from 0 to 1
 * @returns {number} Eased value from 0 to 1
 */
function easeInOutSine(t) {
  // Premium ease (cubic): smooth acceleration/deceleration, no bounce
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Generate deterministic seed from filename for preset selection
 * @param {string} filename - Image filename
 * @returns {number} Seed value (0-65535)
 */
function getFilenameSeed(filename) {
  const hash = createHash('md5').update(filename || '').digest('hex');
  return parseInt(hash.substring(0, 4), 16);
}

/**
 * Normalized crop box (0..1 relative to source image)
 * @typedef {Object} CropBox
 * @property {number} cx - Center X (0..1)
 * @property {number} cy - Center Y (0..1)
 * @property {number} w - Width (0..1)
 * @property {number} h - Height (0..1)
 */

/**
 * Motion preset definition
 * @typedef {Object} MotionPreset
 * @property {string} name - Preset name
 * @property {number} startZoom - Starting zoom (1.02-1.12)
 * @property {number} endZoom - Ending zoom (1.02-1.12)
 * @property {number} panXPercent - Pan X as percentage of frame (-6 to +6)
 * @property {number} panYPercent - Pan Y as percentage of frame (-6 to +6)
 */

/**
 * Get motion preset based on beat position and image characteristics
 * @param {number} beatPosition - Position in story arc (0.0 to 1.0)
 * @param {boolean} isVertical - True if image is vertical (height > width)
 * @param {number} seed - Deterministic seed for direction selection
 * @returns {MotionPreset}
 */
function getMotionPreset(beatPosition, isVertical, seed) {
  // Deterministic, gallery-safe presets:
  // - 50% HOLD (no motion)
  // - 50% SLOW_PUSH_IN (gentle zoom to 1.018 max)
  const useHold = (seed % 2 === 0);
  if (useHold) {
    return {
      name: 'hold',
      startZoom: 1.00,
      endZoom: 1.00,
      panXPercent: 0,
      panYPercent: 0
    };
  }
  return {
    name: 'slow_push_in',
    startZoom: 1.00,
    endZoom: 1.018,
    panXPercent: 0,
    panYPercent: 0
  };
}

/**
 * Generate Ken Burns motion filter using crop-box animation
 * @param {string} imagePath - Path to input image
 * @param {number} duration - Duration in seconds
 * @param {number} fps - Frame rate (24 or 30)
 * @param {number} index - Image index in ordered sequence
 * @param {number} outputWidth - Output video width
 * @param {number} outputHeight - Output video height
 * @param {Object} photoMetadata - Photo metadata (width, height, filename)
 * @param {number} totalSegments - Total number of segments (for beat position)
 * @returns {Object} Template configuration
 */
function createKenBurnsTemplate(imagePath, duration, fps, index, outputWidth = 1920, outputHeight = 1080, photoMetadata = null, totalSegments = 1, motionPlanData = null) {
  // Calculate frames explicitly
  const frames = Math.round(duration * fps);
  if (frames < 2) {
    throw new Error(`Duration too short: ${duration}s at ${fps}fps = ${frames} frames (minimum 2)`);
  }
  
  // Extract filename from path for deterministic seed
  const filename = imagePath.split(/[/\\]/).pop() || `image_${index}`;
  const seed = getFilenameSeed(filename);
  
  // Detect if photo is vertical (height > width)
  const isVertical = photoMetadata && photoMetadata.height && photoMetadata.width && photoMetadata.height > photoMetadata.width;
  
  // Calculate beat position (0.0 to 1.0) based on index in sequence
  const beatPosition = totalSegments > 1 ? index / (totalSegments - 1) : 0.5;
  
  let startZoom, endZoom, panXPercent, panYPercent, motionType;
  const jitterSafe = !!(motionPlanData && (motionPlanData.jitterSafe || motionPlanData.safeMode));
  
  // Use motion plan data if available (from 3-stage pipeline), otherwise fall back to preset
  if (motionPlanData && motionPlanData.movementType && !jitterSafe) {
    // Use motion plan parameters directly
    startZoom = motionPlanData.zoomStart || 1.02;
    endZoom = motionPlanData.zoomEnd || 1.08;
    panXPercent = motionPlanData.panXPercent || 0;
    panYPercent = motionPlanData.panYPercent || 0;
    motionType = motionPlanData.movementType;
    console.log(`[TEMPLATE] Using motion plan: ${motionType}, zoom ${startZoom}→${endZoom}, pan ${panXPercent}%,${panYPercent}%`);
  } else {
    // Fall back to preset selection (legacy behavior)
    const preset = getMotionPreset(beatPosition, isVertical, seed);
    startZoom = preset.startZoom;
    endZoom = preset.endZoom;
    panXPercent = preset.panXPercent;
    panYPercent = preset.panYPercent;
    motionType = preset.name;
    console.log(`[TEMPLATE] Using preset: ${motionType}, zoom ${startZoom}→${endZoom}, pan ${panXPercent}%,${panYPercent}%`);
  }
  
  // Gallery mode enforcement
  if (galleryMode) {
    startZoom = 1.00;
    endZoom = (motionType === 'slow_push_in' && !jitterSafe) ? 1.018 : 1.00;
    panXPercent = 0;
    panYPercent = 0;
  }

  // Safe mode: lock off if jitter risk flagged
  if (jitterSafe) {
    motionType = 'hold';
    startZoom = 1.00;
    endZoom = 1.00;
    panXPercent = 0;
    panYPercent = 0;
  }
  
  // Clamp zoom values (gallery-safe: max 1.018)
  startZoom = Math.max(1.00, Math.min(1.018, startZoom));
  endZoom = Math.max(1.00, Math.min(1.018, endZoom));
  
  // Clamp pan percentages (max 3% to avoid visible drift)
  panXPercent = Math.max(-3, Math.min(3, panXPercent));
  panYPercent = Math.max(-3, Math.min(3, panYPercent));
  
  // Convert pan percentages to pixel offsets
  const panXPixels = Math.round(outputWidth * panXPercent / 100);
  const panYPixels = Math.round(outputHeight * panYPercent / 100);
  
  // Build crop-box animation filter
  // Strategy: scale to cover, then use zoompan for smooth crop-box animation
  // zoompan 'z' parameter sets zoom directly (not accumulates) when using expressions
  // We calculate zoom(t) directly from eased progress
  
  // Calculate zoom and pan expressions using eased interpolation, frozen near transitions
  // Motion only runs in the middle window; start/end windows are HOLD.
  const transitionFrames = Math.max(0, Math.min(Math.round(fps * 0.35), Math.floor(frames / 3)));
  const motionStart = transitionFrames;
  const motionEnd = Math.max(transitionFrames, frames - transitionFrames - 1);
  const motionLen = Math.max(1, motionEnd - motionStart);
  const tExpr = frames > 1 ? `on/(${frames}-1)` : '0';
  const tMotion = `(max(0\\,min(1\\,(on-${motionStart})/${motionLen})))`;
  // easeInOutCubic in ffmpeg expression form, applied to motion window only
  const easedExpr = `if(lt(${tMotion}\\,0.5)\\,4*${tMotion}*${tMotion}*${tMotion}\\,1 - pow(-2*${tMotion}+2\\,3)/2)`;
  const zoomRange = endZoom - startZoom;
  
  // Zoom expression: hold near transitions, push only in motion window
  const zoomExpr = `if(lt(on\\,${motionStart})\\,1\\, if(gt(on\\,${motionEnd})\\,1\\, ${startZoom} + ${zoomRange} * ${easedExpr}))`;
  
  // Pan expressions: locked center (no drift)
  const centerX = `round(iw/2-(iw/zoom)/2)`;
  const centerY = `round(ih/2-(ih/zoom)/2)`;
  const xExpr = `${centerX}`;
  const yExpr = `${centerY}`;
  
  // Build filter chain: scale to cover, then zoompan for crop-box animation
  // zoompan with d=frames outputs exactly 'frames' frames at outputWidth x outputHeight
  let filterChain = `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight}:(iw-ow)/2:(ih-oh)/2,setsar=1`;
  filterChain += `,zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${frames}:s=${outputWidth}x${outputHeight}:fps=${fps}`;
  filterChain += `,setsar=1,format=yuv420p`;
  
  // Log motion preset details
  console.log(`[SEGMENT] presetName=${motionType}`);
  console.log(`[SEGMENT] zoomStart=${startZoom.toFixed(3)} zoomEnd=${endZoom.toFixed(3)}`);
  console.log(`[SEGMENT] panX%=${panXPercent.toFixed(1)} panY%=${panYPercent.toFixed(1)}`);
  console.log(`[SEGMENT] computed segmentFrames=${frames}`);
  if (photoMetadata && photoMetadata.width && photoMetadata.height) {
    console.log(`[SEGMENT] sourceSize=${photoMetadata.width}x${photoMetadata.height}`);
  }
  console.log(`[SEGMENT] cover preprocess: scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase -> crop=${outputWidth}:${outputHeight} setsar=1`);
  console.log(`[SEGMENT] zoompan center rounding: x='${xExpr}' y='${yExpr}'`);
  console.log(`[SEGMENT] beatPosition=${beatPosition.toFixed(2)} (${(beatPosition*100).toFixed(0)}%)`);
  console.log(`[SEGMENT] final FFmpeg filtergraph: ${filterChain}`);
  
  return {
    duration,
    inputs: [`-loop`, `1`, `-i`, imagePath],
    filter: filterChain,
    output: ['-t', String(duration), '-r', String(fps), '-pix_fmt', 'yuv420p'],
    // Metadata for logging
    metadata: {
      index,
      preset: motionType,
      motionType: motionType,
      startZoom,
      endZoom,
      panXPercent,
      panYPercent,
      panXPixels,
      panYPixels,
      outputWidth,
      outputHeight,
      fps,
      totalFrames: frames,
      beatPosition,
      filename: filename
    }
  };
}

export const TEMPLATES = {
  /**
   * ken_burns: Ken Burns motion with crop-box animation
   */
  ken_burns: (imagePath, duration = 3.5, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080, photoMetadata = null, totalSegments = 1, motionPlanData = null) => {
    return createKenBurnsTemplate(imagePath, duration, fps, index, outputWidth, outputHeight, photoMetadata, totalSegments, motionPlanData);
  },

  /**
   * slow_push_in: Ken Burns zoom in effect (legacy, uses ken_burns)
   */
  slow_push_in: (imagePath, duration = 3.5, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080) => {
    return createKenBurnsTemplate(imagePath, duration, fps, index, outputWidth, outputHeight, null, 1);
  },

  /**
   * slow_pull_out: Ken Burns zoom out effect (legacy, uses ken_burns)
   */
  slow_pull_out: (imagePath, duration = 3.5, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080) => {
    return createKenBurnsTemplate(imagePath, duration, fps, index, outputWidth, outputHeight, null, 1);
  },

  /**
   * film_dissolve: Crossfade transition (used between segments)
   */
  film_dissolve: (imagePath, duration = 0.6, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080) => ({
    duration,
    inputs: [`-loop`, `1`, `-i`, imagePath],
    // CRITICAL: Use fill+crop, NOT pad/letterbox
    filter: `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight}:(iw-ow)/2:(ih-oh)/2,format=yuv420p`,
    output: ['-t', String(duration), '-r', String(fps), '-pix_fmt', 'yuv420p']
  }),

  /**
   * dip_to_black: Fade out then fade in
   */
  dip_to_black: (imagePath, duration = 2.0, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080) => ({
    duration,
    inputs: [`-loop`, `1`, `-i`, imagePath],
    // CRITICAL: Use fill+crop, NOT pad/letterbox
    filter: `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight}:(iw-ow)/2:(ih-oh)/2,format=yuv420p`,
    output: ['-t', String(duration), '-r', String(fps), '-pix_fmt', 'yuv420p']
  }),

  /**
   * soft_wipe: Simple wipe using xfade (fallback to crossfade if needed)
   */
  soft_wipe: (imagePath, duration = 3.0, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080) => ({
    duration,
    inputs: [`-loop`, `1`, `-i`, imagePath],
    // CRITICAL: Use fill+crop, NOT pad/letterbox
    filter: `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight}:(iw-ow)/2:(ih-oh)/2,format=yuv420p`,
    output: ['-t', String(duration), '-r', String(fps), '-pix_fmt', 'yuv420p']
  }),

  /**
   * hold_fade: Hold image then fade out (legacy, now uses ken_burns)
   */
  hold_fade: (imagePath, duration = 4.0, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080) => {
    return createKenBurnsTemplate(imagePath, duration, fps, index, outputWidth, outputHeight, null, 1);
  }
};

/**
 * Get template configuration
 */
export function getTemplate(templateName, imagePath, duration, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080, photoMetadata = null, totalSegments = 1, motionPlanData = null) {
  const template = TEMPLATES[templateName];
  if (!template) {
    throw new Error(`Unknown template: ${templateName}`);
  }
  // Pass output dimensions, photo metadata, total segments, and motion plan data to templates that support them
  if (templateName === 'ken_burns' || templateName === 'slow_push_in' || templateName === 'slow_pull_out' || templateName === 'hold_fade') {
    return template(imagePath, duration, fps, index, outputWidth, outputHeight, photoMetadata, totalSegments, motionPlanData);
  }
  // Transition templates also support output dimensions
  if (templateName === 'film_dissolve' || templateName === 'dip_to_black' || templateName === 'soft_wipe') {
    return template(imagePath, duration, fps, index, outputWidth, outputHeight);
  }
  return template(imagePath, duration, fps, index);
}
