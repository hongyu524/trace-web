/**
 * Documentary Motion Pack (JavaScript backend version)
 * Produces subtle, high-end documentary camera movement with strict rules:
 * - No rotation by default
 * - No diagonal wandering
 * - Slow movement only
 * - 40-50% shots should be static (for premium feel)
 * - Transitions are cross-dissolve 300-500ms
 */

/**
 * Simple seeded RNG for deterministic randomness
 */
class SeededRNG {
  constructor(seed) {
    this.seed = seed % 2147483647;
    if (this.seed <= 0) this.seed += 2147483646;
  }

  next() {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  nextInt(max) {
    return Math.floor(this.next() * max);
  }

  nextFloat(min, max) {
    return min + this.next() * (max - min);
  }
}

/**
 * Get default documentary motion configuration
 */
function getDocumentaryDefaults() {
  return {
    staticWeight: 0.45,        // 45% static
    pushInWeight: 0.35,        // 35% push-in
    driftWeight: 0.15,         // 15% drift (7.5% L, 7.5% R)
    pullBackWeight: 0.05,      // 5% pull-back
    parallaxWeight: 0.0,       // 0% parallax (not supported by default)
    transitionDuration: 0.4,   // 400ms
    minScale: 1.01,
    maxScale: 1.035,
    minDriftPercent: 0.8,      // 0.8% of frame width
    maxDriftPercent: 2.0,      // 2.0% of frame width
  };
}

/**
 * Generate a deterministic seed from shot metadata
 */
function generateSeed(shotMeta, globalSeed) {
  const base = globalSeed ?? 12345;
  const positionHash = Math.floor(shotMeta.position * 10000);
  const indexHash = shotMeta.index * 7919; // Prime multiplier
  return base + positionHash + indexHash;
}

/**
 * Easing function: easeInOutSine
 */
function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/**
 * Easing function: linear
 */
function linear(t) {
  return t;
}

/**
 * Clamp lateral drift to prevent black edge reveal
 * @param {number} driftPx - Requested drift in pixels
 * @param {number} frameWidth - Output frame width
 * @param {number} scale - Current scale factor
 * @returns {number} Clamped drift in pixels
 */
function clampDriftForScale(driftPx, frameWidth, scale) {
  // Maximum safe translation: (scaledWidth - frameWidth) / 2
  // scaledWidth = frameWidth * scale
  // maxTx = (frameWidth * scale - frameWidth) / 2 = frameWidth * (scale - 1) / 2
  const maxTx = (frameWidth * (scale - 1)) / 2;
  
  // Add 2px safety margin
  const safeMaxTx = Math.max(0, maxTx - 2);
  
  // Clamp drift to safe range
  const clampedDrift = Math.min(Math.abs(driftPx), safeMaxTx);
  
  // Preserve sign
  return driftPx >= 0 ? clampedDrift : -clampedDrift;
}

/**
 * Pick a documentary motion preset based on shot metadata and weights
 * Implements selection logic to avoid repeats and ensure distribution
 */
function pickDocumentaryPreset(shotMeta, rng, config) {
  const cfg = config ?? getDocumentaryDefaults();
  const seedRNG = rng ?? new SeededRNG(generateSeed(shotMeta));

  // Avoid drift twice in a row
  if (shotMeta.previousPreset === 'LATERAL_DRIFT_L' || shotMeta.previousPreset === 'LATERAL_DRIFT_R') {
    if (shotMeta.previousPreviousPreset === 'LATERAL_DRIFT_L' || shotMeta.previousPreviousPreset === 'LATERAL_DRIFT_R') {
      // Two drifts in a row, prefer static
      if (seedRNG.next() < 0.7) {
        return 'STATIC';
      }
    }
  }

  // Avoid pull-back twice in a row
  if (shotMeta.previousPreset === 'SLOW_PULL_BACK') {
    if (seedRNG.next() < 0.8) {
      return 'STATIC';
    }
  }

  // Prefer STATIC after two moving shots
  if (
    shotMeta.previousPreset &&
    shotMeta.previousPreset !== 'STATIC' &&
    shotMeta.previousPreviousPreset &&
    shotMeta.previousPreviousPreset !== 'STATIC'
  ) {
    if (seedRNG.next() < 0.6) {
      return 'STATIC';
    }
  }

  // Weighted selection based on config
  const rand = seedRNG.next();
  let cumulative = 0;

  cumulative += cfg.staticWeight;
  if (rand < cumulative) return 'STATIC';

  cumulative += cfg.pushInWeight;
  if (rand < cumulative) return 'SLOW_PUSH_IN';

  cumulative += cfg.driftWeight / 2;
  if (rand < cumulative) return 'LATERAL_DRIFT_L';

  cumulative += cfg.driftWeight / 2;
  if (rand < cumulative) return 'LATERAL_DRIFT_R';

  cumulative += cfg.pullBackWeight;
  if (rand < cumulative) return 'SLOW_PULL_BACK';

  // Parallax only if supported (default 0% weight)
  if (cfg.parallaxWeight > 0 && rand < cumulative + cfg.parallaxWeight) {
    return 'PARALLAX_PUSH_IN';
  }

  // Fallback to static
  return 'STATIC';
}

/**
 * Get transform parameters for a preset at normalized time t (0.0 to 1.0)
 * Returns {scale, translateX, translateY, rotateDeg}
 */
function getDocumentaryTransformAt(t, preset, params) {
  const cfg = params.config ?? getDocumentaryDefaults();
  const rng = params.seed !== undefined ? new SeededRNG(params.seed) : new SeededRNG(12345);
  
  // Clamp t to [0, 1]
  t = Math.max(0, Math.min(1, t));

  // All presets have rotateDeg = 0
  const rotateDeg = 0;
  let scale = 1.0;
  let translateX = 0;
  let translateY = 0;

  switch (preset) {
    case 'STATIC':
      scale = 1.0;
      translateX = 0;
      translateY = 0;
      break;

    case 'SLOW_PUSH_IN': {
      // Scale: 1.0 -> random(1.01, 1.035)
      const endScale = rng.nextFloat(cfg.minScale, cfg.maxScale);
      // Use easeInOutSine for very mild easing
      const eased = easeInOutSine(t);
      scale = 1.0 + (endScale - 1.0) * eased;
      translateX = 0;
      translateY = 0;
      break;
    }

    case 'SLOW_PULL_BACK': {
      // Scale: random(1.01, 1.035) -> 1.0
      const startScale = rng.nextFloat(cfg.minScale, cfg.maxScale);
      const eased = easeInOutSine(t);
      scale = startScale - (startScale - 1.0) * eased;
      translateX = 0;
      translateY = 0;
      break;
    }

    case 'LATERAL_DRIFT_L': {
      // Fixed scale: slightly zoomed to avoid edge reveal (min 1.02 for drift safety)
      scale = rng.nextFloat(Math.max(1.02, cfg.minScale), cfg.maxScale);
      // translateX: negative drift (left), 0.8% to 2.0% of frame width
      const driftPercent = rng.nextFloat(cfg.minDriftPercent, cfg.maxDriftPercent);
      let driftPx = (params.frameWidth * driftPercent) / 100;
      // Linear movement from 0 to -driftPx
      driftPx = -driftPx * t;
      // Clamp drift to prevent black edge reveal
      translateX = clampDriftForScale(driftPx, params.frameWidth, scale);
      translateY = 0;
      break;
    }

    case 'LATERAL_DRIFT_R': {
      // Fixed scale: slightly zoomed to avoid edge reveal (min 1.02 for drift safety)
      scale = rng.nextFloat(Math.max(1.02, cfg.minScale), cfg.maxScale);
      // translateX: positive drift (right), 0.8% to 2.0% of frame width
      const driftPercent = rng.nextFloat(cfg.minDriftPercent, cfg.maxDriftPercent);
      let driftPx = (params.frameWidth * driftPercent) / 100;
      // Linear movement from 0 to +driftPx
      driftPx = driftPx * t;
      // Clamp drift to prevent black edge reveal
      translateX = clampDriftForScale(driftPx, params.frameWidth, scale);
      translateY = 0;
      break;
    }

    case 'PARALLAX_PUSH_IN': {
      // Parallax: background and foreground scale differently
      // For single-layer implementation, use subtle push-in
      const endScale = rng.nextFloat(1.015, 1.025); // Middle ground
      const eased = easeInOutSine(t);
      scale = 1.0 + (endScale - 1.0) * eased;
      translateX = 0;
      translateY = 0;
      break;
    }

    default:
      scale = 1.0;
      translateX = 0;
      translateY = 0;
  }

  // Hard clamp all values for safety
  scale = Math.max(1.0, Math.min(1.035, scale));
  translateX = Math.max(-params.frameWidth * 0.02, Math.min(params.frameWidth * 0.02, translateX));
  translateY = Math.max(-params.frameHeight * 0.02, Math.min(params.frameHeight * 0.02, translateY));

  return {
    scale,
    translateX,
    translateY,
    rotateDeg,
  };
}

/**
 * Convert documentary preset to motion-planning.js format
 * Maps documentary presets to existing motion system parameters
 */
function convertDocumentaryPresetToMotionParams(preset, frameWidth, frameHeight, seed, config) {
  // Get transform at start (t=0) and end (t=1)
  const startTransform = getDocumentaryTransformAt(0, preset, { frameWidth, frameHeight, seed, config });
  const endTransform = getDocumentaryTransformAt(1, preset, { frameWidth, frameHeight, seed: seed + 1, config });

  // Convert to motion-planning.js format
  const params = {
    zoomStart: startTransform.scale,
    zoomEnd: endTransform.scale,
    panXPercent: 0,
    panYPercent: 0,
    panAxis: null,
  };

  // For lateral drift, calculate pan percentage (use end transform for max drift)
  if (preset === 'LATERAL_DRIFT_L' || preset === 'LATERAL_DRIFT_R') {
    const driftPx = Math.abs(endTransform.translateX);
    params.panXPercent = (driftPx / frameWidth) * 100;
    if (preset === 'LATERAL_DRIFT_L') {
      params.panXPercent = -params.panXPercent;
    }
    params.panAxis = 'x';
  }

  return params;
}

export {
  pickDocumentaryPreset,
  getDocumentaryTransformAt,
  getDocumentaryDefaults,
  convertDocumentaryPresetToMotionParams,
  SeededRNG,
  clampDriftForScale,
};
