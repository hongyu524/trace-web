/**
 * Template pack for memory video generation
 * Motion system with global MOTION_MODE flag
 */

/**
 * Global motion mode
 * - OFF: No motion, completely static frames
 * - CINEMATIC_SAFE: Subtle push-in only (1.00 -> 1.03) using static crossfade
 */
const MOTION_MODE = process.env.MOTION_MODE || 'OFF';

/**
 * Generate static template (no motion)
 * @param {string} imagePath - Path to input image
 * @param {number} duration - Duration in seconds
 * @param {number} fps - Frame rate (24)
 * @param {number} outputWidth - Output video width
 * @param {number} outputHeight - Output video height
 * @returns {Object} Template configuration
 */
function createStaticTemplate(imagePath, duration, fps, outputWidth, outputHeight) {
  const actualFps = 24;
  
  // Static frame: scale to cover, crop to output size, no motion
  const filter = `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight}:(iw-ow)/2:(ih-oh)/2,setsar=1,format=yuv420p`;
  
  return {
    duration,
    inputs: [`-loop`, `1`, `-i`, imagePath],
    filter,
    output: ['-t', String(duration), '-r', String(actualFps), '-pix_fmt', 'yuv420p']
  };
}

/**
 * Generate cinematic safe template (subtle push-in using static crossfade)
 * @param {string} imagePath - Path to input image
 * @param {number} duration - Duration in seconds
 * @param {number} fps - Frame rate (24)
 * @param {number} outputWidth - Output video width
 * @param {number} outputHeight - Output video height
 * @param {boolean} isHero - True if hero shot (slightly stronger push-in)
 * @returns {Object} Template configuration
 */
function createCinematicSafeTemplate(imagePath, duration, fps, outputWidth, outputHeight, isHero = false) {
  const actualFps = 24;
  
  // Max zoom: 1.03 (3%)
  const endZoom = 1.03;
  
  // Create two static versions and crossfade for push-in effect
  // Version 1 (zoom 1.00): scale to output size, crop center (wider view)
  // Version 2 (zoom 1.03): scale larger (1.03x), crop center (tighter view)
  // Crossfade from version 1 to version 2 creates smooth push-in
  
  // For zoom 1.03: scale image to 1.03x output size, then crop center
  const scale2 = endZoom; // 1.03
  const scaledW2 = Math.round(outputWidth * scale2);
  const scaledH2 = Math.round(outputHeight * scale2);
  
  // Crossfade over full duration for smooth push-in
  const xfadeDuration = duration;
  const xfadeOffset = 0;
  
  // Filter: create two static versions and crossfade
  // [0:v] version 1: scale to output, crop center (zoom 1.00 - wider)
  // [1:v] version 2: scale larger, crop center (zoom 1.03 - tighter)
  // xfade from version 1 to version 2
  const filter = `[0:v]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight}:(iw-ow)/2:(ih-oh)/2,setsar=1[v0];[1:v]scale=${scaledW2}:${scaledH2}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight}:(iw-ow)/2:(ih-oh)/2,setsar=1[v1];[v0][v1]xfade=transition=fade:duration=${xfadeDuration}:offset=${xfadeOffset},format=yuv420p[v]`;
  
  return {
    duration,
    inputs: [`-loop`, `1`, `-t`, String(duration), `-i`, imagePath, `-loop`, `1`, `-t`, String(duration), `-i`, imagePath],
    filter,
    output: ['-r', String(actualFps), '-pix_fmt', 'yuv420p', '-map', '[v]']
  };
}

/**
 * Generate Ken Burns motion filter (wrapper that respects MOTION_MODE)
 * @param {string} imagePath - Path to input image
 * @param {number} duration - Duration in seconds
 * @param {number} fps - Frame rate (24 or 30)
 * @param {number} index - Image index in ordered sequence
 * @param {number} outputWidth - Output video width
 * @param {number} outputHeight - Output video height
 * @param {Object} photoMetadata - Photo metadata (width, height, filename)
 * @param {number} totalSegments - Total number of segments (for beat position)
 * @param {Object} motionPlanData - Motion plan data from Stage 3
 * @returns {Object} Template configuration
 */
function createKenBurnsTemplate(imagePath, duration, fps, index, outputWidth = 1920, outputHeight = 1080, photoMetadata = null, totalSegments = 1, motionPlanData = null) {
  const actualFps = 24;
  
  // Extract filename for metadata
  const filename = imagePath.split(/[/\\]/).pop() || `image_${index}`;
  
  // Check if this is a hero shot
  const isHero = motionPlanData?.isHero || false;
  
  // Use MOTION_MODE to determine template type
  if (MOTION_MODE === 'OFF') {
    // Completely static, no motion
    console.log(`[MOTION] mode=OFF zoom=1.00->1.00 pan=disabled`);
    return createStaticTemplate(imagePath, duration, actualFps, outputWidth, outputHeight);
  } else if (MOTION_MODE === 'CINEMATIC_SAFE') {
    // Subtle push-in only (1.00 -> 1.03) using static crossfade
    const zoomStart = 1.00;
    const zoomEnd = 1.03;
    console.log(`[MOTION] mode=CINEMATIC_SAFE zoom=${zoomStart.toFixed(2)}->${zoomEnd.toFixed(2)} pan=disabled`);
    return createCinematicSafeTemplate(imagePath, duration, actualFps, outputWidth, outputHeight, isHero);
  } else {
    // Unknown mode, default to OFF for safety
    console.warn(`[MOTION] Unknown MOTION_MODE="${MOTION_MODE}", defaulting to OFF`);
    console.log(`[MOTION] mode=OFF zoom=1.00->1.00 pan=disabled`);
    return createStaticTemplate(imagePath, duration, actualFps, outputWidth, outputHeight);
  }
}

export const TEMPLATES = {
  /**
   * ken_burns: Ken Burns motion (respects MOTION_MODE)
   */
  ken_burns: (imagePath, duration = 3.5, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080, photoMetadata = null, totalSegments = 1, motionPlanData = null) => {
    return createKenBurnsTemplate(imagePath, duration, fps, index, outputWidth, outputHeight, photoMetadata, totalSegments, motionPlanData);
  },

  /**
   * slow_push_in: Ken Burns zoom in effect (legacy, uses ken_burns)
   */
  slow_push_in: (imagePath, duration = 3.5, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080, photoMetadata = null, totalSegments = 1, motionPlanData = null) => {
    return createKenBurnsTemplate(imagePath, duration, fps, index, outputWidth, outputHeight, photoMetadata, totalSegments, motionPlanData);
  },

  /**
   * slow_pull_out: Ken Burns zoom out effect (legacy, uses ken_burns)
   */
  slow_pull_out: (imagePath, duration = 3.5, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080, photoMetadata = null, totalSegments = 1, motionPlanData = null) => {
    return createKenBurnsTemplate(imagePath, duration, fps, index, outputWidth, outputHeight, photoMetadata, totalSegments, motionPlanData);
  },

  /**
   * film_dissolve: Crossfade transition (used between segments)
   */
  film_dissolve: (imagePath, duration = 0.6, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080) => ({
    duration,
    inputs: [`-loop`, `1`, `-i`, imagePath],
    filter: `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight}:(iw-ow)/2:(ih-oh)/2,setsar=1,format=yuv420p`,
    output: ['-t', String(duration), '-r', String(24), '-pix_fmt', 'yuv420p']
  }),

  /**
   * dip_to_black: Fade out then fade in
   */
  dip_to_black: (imagePath, duration = 2.0, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080) => ({
    duration,
    inputs: [`-loop`, `1`, `-i`, imagePath],
    filter: `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight}:(iw-ow)/2:(ih-oh)/2,setsar=1,format=yuv420p`,
    output: ['-t', String(duration), '-r', String(24), '-pix_fmt', 'yuv420p']
  }),

  /**
   * soft_wipe: Simple wipe using xfade (fallback to crossfade if needed)
   */
  soft_wipe: (imagePath, duration = 3.0, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080) => ({
    duration,
    inputs: [`-loop`, `1`, `-i`, imagePath],
    filter: `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight}:(iw-ow)/2:(ih-oh)/2,setsar=1,format=yuv420p`,
    output: ['-t', String(duration), '-r', String(24), '-pix_fmt', 'yuv420p']
  }),

  /**
   * hold_fade: Hold image then fade out (legacy, now uses ken_burns)
   */
  hold_fade: (imagePath, duration = 4.0, fps = 30, index = 0, outputWidth = 1920, outputHeight = 1080, photoMetadata = null, totalSegments = 1, motionPlanData = null) => {
    return createKenBurnsTemplate(imagePath, duration, fps, index, outputWidth, outputHeight, photoMetadata, totalSegments, motionPlanData);
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
