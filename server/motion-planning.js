/**
 * Stage 3: Motion Planning
 * Generates per-image motion with cinematic timing + motivated presets
 */

/**
 * Calculate safe margin for pan movement after applying zoom/scale
 * @param {number} srcW - Source image width
 * @param {number} srcH - Source image height
 * @param {number} outW - Output video width
 * @param {number} outH - Output video height
 * @param {number} zoom - Current zoom level (1.0-1.035)
 * @returns {Object} {marginX, marginY, canPanX, canPanY}
 */
function calculateSafeMargin(srcW, srcH, outW, outH, zoom = 1.0) {
  const srcAspect = srcW / srcH;
  const outAspect = outW / outH;
  
  // Calculate cover scale (image scaled to cover output)
  const coverScale = Math.max(outW / srcW, outH / srcH) * zoom;
  const scaledW = srcW * coverScale;
  const scaledH = srcH * coverScale;
  
  // Available margin after scaling and zooming
  const marginX = (scaledW - outW) / 2;
  const marginY = (scaledH - outH) / 2;
  
  // Minimum margin requirements: 24px or 1.5% of frame (whichever is larger)
  const minMarginX = Math.max(24, outW * 0.015);
  const minMarginY = Math.max(24, outH * 0.015);
  
  // Check if aspect ratio differs greatly (portrait to landscape or vice versa)
  const aspectRatioDiff = Math.abs(srcAspect - outAspect) / outAspect;
  const aspectRatioSafe = aspectRatioDiff < 0.5; // Allow up to 50% difference
  
  const canPanX = marginX >= minMarginX && aspectRatioSafe;
  const canPanY = marginY >= minMarginY && aspectRatioSafe;
  
  return { marginX, marginY, canPanX, canPanY };
}

/**
 * Select motion preset deterministically based on story signals
 * @param {Object} options
 * @param {string} options.storyTone - Visual tone: 'reflective', 'contemplative', 'emotional', 'uplifting', 'neutral'
 * @param {string} options.pacing - Pacing: 'slow', 'medium', 'fast'
 * @param {number} options.position - Position in sequence (0.0 to 1.0)
 * @param {boolean} options.isHero - True if this is a hero shot
 * @param {Object} options.safeMargin - Safe margin info from calculateSafeMargin
 * @returns {string} Preset name: 'HOLD', 'SLOW_PUSH_IN', 'SLOW_PULL_OUT', 'SLOW_PAN'
 */
function selectMotionPreset({ storyTone, pacing, position, isHero, safeMargin }) {
  // Hero shots: prefer PUSH_IN with stronger zoom
  if (isHero) {
    return 'SLOW_PUSH_IN';
  }
  
  // Last 20% of clips or "ending" purpose: use PULL_OUT occasionally
  if (position >= 0.8) {
    // Use PULL_OUT for last 20% occasionally (every 4th clip in that range)
    if (Math.floor(position * 20) % 4 === 0) {
      return 'SLOW_PULL_OUT';
    }
  }
  
  // Reflective/contemplative tone: prefer HOLD + PUSH_IN (less motion)
  if (storyTone === 'reflective' || storyTone === 'contemplative') {
    // 70% HOLD, 30% PUSH_IN
    const useHold = (Math.floor(position * 10) % 10) < 7;
    return useHold ? 'HOLD' : 'SLOW_PUSH_IN';
  }
  
  // Fast pacing: more HOLD, less pan
  if (pacing === 'fast') {
    // 80% HOLD, 20% PUSH_IN (no pan for fast pacing)
    const useHold = (Math.floor(position * 10) % 10) < 8;
    return useHold ? 'HOLD' : 'SLOW_PUSH_IN';
  }
  
  // Default (medium pacing, neutral/emotional/uplifting tone):
  // 50% HOLD, 30% PUSH_IN, 20% PAN (if safe)
  const rand = Math.floor(position * 10) % 10;
  if (rand < 5) {
    return 'HOLD';
  } else if (rand < 8) {
    return 'SLOW_PUSH_IN';
  } else {
    // Consider pan only if safe margin is available
    if (safeMargin.canPanX || safeMargin.canPanY) {
      return 'SLOW_PAN';
    }
    return 'SLOW_PUSH_IN'; // Fallback to PUSH_IN if pan not safe
  }
}

/**
 * Generate motion parameters for a preset
 * @param {string} preset - Preset name: 'HOLD', 'SLOW_PUSH_IN', 'SLOW_PULL_OUT', 'SLOW_PAN'
 * @param {boolean} isHero - True if this is a hero shot
 * @param {Object} safeMargin - Safe margin info {canPanX, canPanY, marginX, marginY}
 * @param {number} outW - Output width
 * @param {number} outH - Output height
 * @returns {Object} Motion parameters {zoomStart, zoomEnd, panXPercent, panYPercent, panAxis}
 */
function generatePresetParameters(preset, isHero, safeMargin, outW, outH) {
  const params = {
    zoomStart: 1.00,
    zoomEnd: 1.00,
    panXPercent: 0,
    panYPercent: 0,
    panAxis: null // 'x', 'y', or null
  };
  
  if (preset === 'HOLD') {
    params.zoomStart = 1.00;
    params.zoomEnd = 1.00;
  } else if (preset === 'SLOW_PUSH_IN') {
    params.zoomStart = 1.00;
    params.zoomEnd = isHero ? 1.035 : 1.03; // Hero shots: stronger zoom
  } else if (preset === 'SLOW_PULL_OUT') {
    params.zoomStart = 1.03;
    params.zoomEnd = 1.00;
  } else if (preset === 'SLOW_PAN') {
    params.zoomStart = 1.00;
    params.zoomEnd = 1.00;
    
    // Pan on ONE axis only, amplitude <= 1.5% of frame
    const panAmplitude = 0.015; // 1.5% of frame
    const panPixels = Math.min(outW * panAmplitude, outH * panAmplitude);
    
    // Prefer horizontal pan if both are safe, otherwise use available axis
    if (safeMargin.canPanX && safeMargin.marginX >= panPixels) {
      params.panAxis = 'x';
      // Pan left or right (deterministic based on position)
      const direction = (Math.floor(outW) % 2 === 0) ? 1 : -1;
      params.panXPercent = direction * panAmplitude * 100;
    } else if (safeMargin.canPanY && safeMargin.marginY >= panPixels) {
      params.panAxis = 'y';
      // Pan up or down (deterministic based on position)
      const direction = (Math.floor(outH) % 2 === 0) ? 1 : -1;
      params.panYPercent = direction * panAmplitude * 100;
    } else {
      // Pan not safe, fallback to HOLD
      return generatePresetParameters('HOLD', isHero, safeMargin, outW, outH);
    }
  }
  
  return params;
}

/**
 * Generate motion plan for all images (Stage 3)
 * @param {Array<Object>} analysisResults - Vision analysis results (Stage 1)
 * @param {Object} sequencePlan - Sequence plan with ordered_ids and shots (Stage 2)
 * @param {Object} storyLock - Story lock object with hero_images and theme
 * @param {number} outputWidth - Output video width
 * @param {number} outputHeight - Output video height
 * @returns {Array<Object>} Motion plan array, one per image in order
 */
export function generateMotionPlan(analysisResults, sequencePlan, storyLock = null, outputWidth = 1920, outputHeight = 1080) {
  console.log(`[MOTION-PLANNING] Generating motion plan for ${sequencePlan.ordered_ids.length} images (output: ${outputWidth}x${outputHeight})...`);
  
  const motionPlan = [];
  const totalImages = sequencePlan.ordered_ids.length;
  
  // Extract story signals
  const storyTone = storyLock?.theme ? 'neutral' : 'neutral'; // Could extract from theme/analysis
  const pacing = 'medium'; // Could calculate from durations
  
  // Identify hero images (first image + highest resolution, or from storyLock)
  const heroImageIds = new Set();
  if (storyLock?.hero_images && Array.isArray(storyLock.hero_images)) {
    storyLock.hero_images.forEach(id => heroImageIds.add(id));
  }
  // Always make first image a hero
  if (totalImages > 0) {
    heroImageIds.add(sequencePlan.ordered_ids[0]);
  }
  // Find highest resolution image (if not already hero)
  let maxResolution = 0;
  let highestResId = null;
  for (let i = 0; i < totalImages; i++) {
    const imageId = sequencePlan.ordered_ids[i];
    const analysis = analysisResults[imageId];
    if (analysis) {
      const width = analysis.width || 0;
      const height = analysis.height || 0;
      const resolution = width * height;
      if (resolution > maxResolution && !heroImageIds.has(imageId)) {
        maxResolution = resolution;
        highestResId = imageId;
      }
    }
  }
  if (highestResId && heroImageIds.size < 2) {
    heroImageIds.add(highestResId);
  }
  
  // Generate motion for each image in sequence order
  for (let i = 0; i < totalImages; i++) {
    const imageId = sequencePlan.ordered_ids[i];
    const analysis = analysisResults[imageId];
    const shotInfo = sequencePlan.shots && sequencePlan.shots[i] ? sequencePlan.shots[i] : {
      purpose: 'build',
      target_emotion: { primary: 'calm', secondary: '' }
    };
    
    if (!analysis) {
      throw new Error(`Missing analysis for image ID ${imageId}`);
    }
    
    // Get image dimensions
    const srcW = analysis.width || 1920;
    const srcH = analysis.height || 1080;
    
    // Check if this is a hero shot
    const isHero = heroImageIds.has(imageId);
    
    // Calculate safe margin (for pan gating)
    const safeMargin = calculateSafeMargin(srcW, srcH, outputWidth, outputHeight, 1.035);
    
    // Calculate position in sequence (0.0 to 1.0)
    const position = totalImages > 1 ? i / (totalImages - 1) : 0.5;
    
    // Select motion preset deterministically
    const preset = selectMotionPreset({
      storyTone,
      pacing,
      position,
      isHero,
      safeMargin
    });
    
    // Generate preset parameters
    const presetParams = generatePresetParameters(preset, isHero, safeMargin, outputWidth, outputHeight);
    
    motionPlan.push({
      imageId,
      filename: analysis.filename,
      movementType: preset.toLowerCase(), // Convert to lowercase (SLOW_PUSH_IN -> slow_push_in, etc.)
      zoomStart: presetParams.zoomStart,
      zoomEnd: presetParams.zoomEnd,
      panXPercent: presetParams.panXPercent,
      panYPercent: presetParams.panYPercent,
      panAxis: presetParams.panAxis,
      isHero: isHero
    });
  }
  
  // Validate motion plan coverage
  if (motionPlan.length !== totalImages) {
    throw new Error(
      `Motion plan incomplete: ${motionPlan.length}/${totalImages} images planned`
    );
  }
  
  console.log(`[MOTION-PLANNING] Generated motion plan for ${motionPlan.length} images (${heroImageIds.size} hero shots)`);
  
  return motionPlan;
}
