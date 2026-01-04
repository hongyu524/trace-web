/**
 * Documentary Motion Pack
 * Produces subtle, high-end documentary camera movement with strict rules:
 * - No rotation by default
 * - No diagonal wandering
 * - Slow movement only
 * - 40-50% shots should be static (for premium feel)
 * - Transitions are cross-dissolve 300-500ms
 * - Drift is physically consistent with overscan (coupled zoom-pan)
 * - Movement starts with hold phase, then smoothly accelerates and decelerates
 */

export type MotionPresetName = 
  | 'STATIC' 
  | 'SLOW_PUSH_IN' 
  | 'SLOW_PULL_BACK' 
  | 'LATERAL_DRIFT_L' 
  | 'LATERAL_DRIFT_R' 
  | 'PARALLAX_PUSH_IN';

export interface DocumentaryMotionConfig {
  /** Static shot weight (0-1) */
  staticWeight: number;
  /** Push-in weight (0-1) */
  pushInWeight: number;
  /** Lateral drift weight (0-1), split between L and R */
  driftWeight: number;
  /** Pull-back weight (0-1) */
  pullBackWeight: number;
  /** Parallax push-in weight (0-1) */
  parallaxWeight: number;
  /** Transition duration in seconds (300-500ms default) */
  transitionDuration: number;
  /** Minimum scale for zoomed presets */
  minScale: number;
  /** Maximum scale for zoomed presets (push-in/pull-back) */
  maxScale: number;
  /** Minimum drift scale (coupled zoom-pan start) */
  driftMinScale: number;
  /** Maximum drift scale (coupled zoom-pan end) */
  driftMaxScale: number;
  /** Minimum drift percentage of frame width (before coupling) */
  minDriftPercent: number;
  /** Maximum drift percentage of frame width (before coupling) */
  maxDriftPercent: number;
  /** Hold fraction for motion (0.25 = first 25% static) */
  holdFraction: number;
  /** Safety margin in pixels to avoid edge reveal (default: 4px or 0.1% frame width) */
  driftSafetyPx: number;
}

export interface ShotMetadata {
  /** Position in sequence (0.0 to 1.0) */
  position: number;
  /** Shot index (0-based) */
  index: number;
  /** Total number of shots */
  totalShots: number;
  /** Frame width in pixels */
  frameWidth: number;
  /** Frame height in pixels */
  frameHeight: number;
  /** Previous preset name (for avoiding repeats) */
  previousPreset?: MotionPresetName;
  /** Previous-to-previous preset name */
  previousPreviousPreset?: MotionPresetName;
  /** Anchor point X (0-1 normalized) - focal point from auto-reframe */
  anchorX?: number;
  /** Anchor point Y (0-1 normalized) - focal point from auto-reframe */
  anchorY?: number;
}

export interface TransformParams {
  scale: number;
  translateX: number;
  translateY: number;
  rotateDeg: number;
}

export interface DocumentaryTransformAt {
  scale: number;
  translateX: number;
  translateY: number;
  rotateDeg: number;
}

/**
 * Simple seeded RNG for deterministic randomness
 */
class SeededRNG {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed % 2147483647;
    if (this.seed <= 0) this.seed += 2147483646;
  }

  next(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  nextInt(max: number): number {
    return Math.floor(this.next() * max);
  }

  nextFloat(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

/**
 * Get default documentary motion configuration
 */
export function getDocumentaryDefaults(): DocumentaryMotionConfig {
  return {
    staticWeight: 0.45,        // 45% static
    pushInWeight: 0.35,        // 35% push-in
    driftWeight: 0.15,         // 15% drift (7.5% L, 7.5% R)
    pullBackWeight: 0.05,      // 5% pull-back
    parallaxWeight: 0.0,       // 0% parallax (not supported by default)
    transitionDuration: 0.4,   // 400ms
    minScale: 1.01,            // Push-in/pull-back scale range
    maxScale: 1.035,           // Push-in/pull-back max scale (subtle)
    driftMinScale: 1.03,       // Drift start scale (coupled zoom-pan)
    driftMaxScale: 1.06,       // Drift end scale (coupled zoom-pan)
    minDriftPercent: 1.0,      // 1% of frame width (will be constrained by overscan)
    maxDriftPercent: 3.0,      // 3% of frame width (will be constrained by overscan)
    holdFraction: 0.25,        // 25% hold phase (premium doc feel)
    driftSafetyPx: 4,          // 4px safety margin (or 0.1% frame width, whichever is larger)
  };
}

/**
 * Generate a deterministic seed from shot metadata
 */
function generateSeed(shotMeta: ShotMetadata, globalSeed?: number): number {
  // Use position and index for deterministic seed
  const base = globalSeed ?? 12345;
  const positionHash = Math.floor(shotMeta.position * 10000);
  const indexHash = shotMeta.index * 7919; // Prime multiplier
  return base + positionHash + indexHash;
}

/**
 * Easing function: easeInOutSine (smooth, cinematic)
 */
function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/**
 * Clamp helper
 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Calculate maximum pan distance at a given scale (overscan rule)
 * Formula: maxPanPxAtScale = ((scale - 1) * frameWidth) / 2
 */
function calculateMaxPanAtScale(scale: number, frameWidth: number, safetyPx: number): number {
  const overscanPerSide = ((scale - 1) * frameWidth) / 2;
  return Math.max(0, overscanPerSide - safetyPx);
}

/**
 * Pick a documentary motion preset based on shot metadata and weights
 * Implements selection logic to avoid repeats and ensure distribution
 */
export function pickDocumentaryPreset(
  shotMeta: ShotMetadata,
  rng?: SeededRNG,
  config?: DocumentaryMotionConfig
): MotionPresetName {
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
 * Returns scale, translateX, translateY, rotateDeg
 * 
 * Key improvements:
 * - Drift uses coupled zoom-pan (physically consistent with overscan)
 * - All motion uses easeInOutSine with hold phase for premium feel
 * - No hard-coded clamps (uses config-based limits)
 * - Deterministic per shot (no per-frame RNG changes)
 */
export function getDocumentaryTransformAt(
  t: number,
  preset: MotionPresetName,
  params: {
    frameWidth: number;
    frameHeight: number;
    seed?: number;
    config?: DocumentaryMotionConfig;
    anchorX?: number;  // Focal point X (0-1 normalized)
    anchorY?: number;  // Focal point Y (0-1 normalized)
  }
): DocumentaryTransformAt {
  const cfg = params.config ?? getDocumentaryDefaults();
  const rng = params.seed !== undefined ? new SeededRNG(params.seed) : new SeededRNG(12345);
  
  // Clamp t to [0, 1]
  t = Math.max(0, Math.min(1, t));

  // All presets have rotateDeg = 0
  const rotateDeg = 0;
  let scale = 1.0;
  let translateX = 0;
  let translateY = 0;

  // Calculate safety margin (use larger of absolute px or 0.1% frame width)
  const safetyMarginPx = Math.max(cfg.driftSafetyPx, params.frameWidth * 0.001);

  switch (preset) {
    case 'STATIC':
      scale = 1.0;
      translateX = 0;
      translateY = 0;
      break;

    case 'SLOW_PUSH_IN': {
      // Scale: 1.0 -> random(minScale, maxScale)
      const endScale = rng.nextFloat(cfg.minScale, cfg.maxScale);
      
      // Apply hold phase + easeInOutSine
      const holdFrac = cfg.holdFraction;
      let tMove = 0;
      if (t >= holdFrac) {
        const moveProgress = (t - holdFrac) / (1 - holdFrac);
        tMove = clamp(moveProgress, 0, 1);
      }
      const eased = easeInOutSine(tMove);
      
      scale = 1.0 + (endScale - 1.0) * eased;
      translateX = 0;
      translateY = 0;
      break;
    }

    case 'SLOW_PULL_BACK': {
      // Scale: random(minScale, maxScale) -> 1.0
      const startScale = rng.nextFloat(cfg.minScale, cfg.maxScale);
      
      // Apply hold phase + easeInOutSine
      const holdFrac = cfg.holdFraction;
      let tMove = 0;
      if (t >= holdFrac) {
        const moveProgress = (t - holdFrac) / (1 - holdFrac);
        tMove = clamp(moveProgress, 0, 1);
      }
      const eased = easeInOutSine(tMove);
      
      scale = startScale - (startScale - 1.0) * eased;
      translateX = 0;
      translateY = 0;
      break;
    }

    case 'LATERAL_DRIFT_L': {
      // Coupled zoom-pan: start at driftMinScale, ramp to driftMaxScale
      // Pan distance is constrained by overscan rule
      const startScale = cfg.driftMinScale;
      const endScale = rng.nextFloat(cfg.driftMinScale, cfg.driftMaxScale);
      
      // Apply hold phase + easeInOutSine
      const holdFrac = cfg.holdFraction;
      let tMove = 0;
      if (t >= holdFrac) {
        const moveProgress = (t - holdFrac) / (1 - holdFrac);
        tMove = clamp(moveProgress, 0, 1);
      }
      const eased = easeInOutSine(tMove);
      
      // Interpolate scale
      scale = startScale + (endScale - startScale) * eased;
      
      // Calculate desired drift percentage (before coupling constraint)
      const desiredDriftPercent = rng.nextFloat(cfg.minDriftPercent, cfg.maxDriftPercent);
      const desiredDriftPx = (params.frameWidth * desiredDriftPercent) / 100;
      
      // Calculate maximum pan at current scale (overscan rule)
      const maxPanAtCurrentScale = calculateMaxPanAtScale(scale, params.frameWidth, safetyMarginPx);
      
      // Constrain pan to overscan limit
      const actualDriftPx = Math.min(desiredDriftPx, maxPanAtCurrentScale);
      
      // Apply eased pan (negative for left drift)
      translateX = -actualDriftPx * eased;
      translateY = 0;
      break;
    }

    case 'LATERAL_DRIFT_R': {
      // Coupled zoom-pan: start at driftMinScale, ramp to driftMaxScale
      // Pan distance is constrained by overscan rule
      const startScale = cfg.driftMinScale;
      const endScale = rng.nextFloat(cfg.driftMinScale, cfg.driftMaxScale);
      
      // Apply hold phase + easeInOutSine
      const holdFrac = cfg.holdFraction;
      let tMove = 0;
      if (t >= holdFrac) {
        const moveProgress = (t - holdFrac) / (1 - holdFrac);
        tMove = clamp(moveProgress, 0, 1);
      }
      const eased = easeInOutSine(tMove);
      
      // Interpolate scale
      scale = startScale + (endScale - startScale) * eased;
      
      // Calculate desired drift percentage (before coupling constraint)
      const desiredDriftPercent = rng.nextFloat(cfg.minDriftPercent, cfg.maxDriftPercent);
      const desiredDriftPx = (params.frameWidth * desiredDriftPercent) / 100;
      
      // Calculate maximum pan at current scale (overscan rule)
      const maxPanAtCurrentScale = calculateMaxPanAtScale(scale, params.frameWidth, safetyMarginPx);
      
      // Constrain pan to overscan limit
      const actualDriftPx = Math.min(desiredDriftPx, maxPanAtCurrentScale);
      
      // Apply eased pan (positive for right drift)
      translateX = actualDriftPx * eased;
      translateY = 0;
      break;
    }

    case 'PARALLAX_PUSH_IN': {
      // Parallax: background and foreground scale differently
      // For single-layer implementation, use subtle push-in
      const endScale = rng.nextFloat(1.015, 1.025); // Middle ground
      
      // Apply hold phase + easeInOutSine
      const holdFrac = cfg.holdFraction;
      let tMove = 0;
      if (t >= holdFrac) {
        const moveProgress = (t - holdFrac) / (1 - holdFrac);
        tMove = clamp(moveProgress, 0, 1);
      }
      const eased = easeInOutSine(tMove);
      
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

  // Final safety clamps based on config (not hard-coded)
  // Scale: clamp to maxScale (or driftMaxScale for drift presets)
  const maxScaleForPreset = 
    preset === 'LATERAL_DRIFT_L' || preset === 'LATERAL_DRIFT_R' 
      ? cfg.driftMaxScale 
      : cfg.maxScale;
  scale = Math.max(1.0, Math.min(maxScaleForPreset, scale));
  
  // Translate: ensure it doesn't exceed overscan limits
  const maxPanAtScale = calculateMaxPanAtScale(scale, params.frameWidth, safetyMarginPx);
  translateX = clamp(translateX, -maxPanAtScale, maxPanAtScale);
  translateY = clamp(translateY, -maxPanAtScale, maxPanAtScale);

  return {
    scale,
    translateX,
    translateY,
    rotateDeg,
  };
}

/**
 * Generate a deterministic seed from shot metadata (exported for testing)
 */
export function generateSeedFromMetadata(shotMeta: ShotMetadata, globalSeed?: number): number {
  return generateSeed(shotMeta, globalSeed);
}

/**
 * Export SeededRNG for testing
 */
export { SeededRNG };
