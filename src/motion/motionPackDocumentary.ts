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
 * "Gallery Documentary" preset: premium, consistent, directed motion
 */
export function getDocumentaryDefaults(): DocumentaryMotionConfig {
  return {
    staticWeight: 0.0,         // 0% static (gallery mode: all shots have motion)
    pushInWeight: 0.70,        // 70% push-in (default motion type)
    driftWeight: 0.25,         // 25% driftX (horizontal only, split 50/50 L/R)
    pullBackWeight: 0.0,       // 0% pull-back (gallery mode: no pull-back)
    parallaxWeight: 0.0,       // 0% parallax (not supported)
    transitionDuration: 0.4,   // 400ms cross-dissolve
    minScale: 1.01,            // Push-in start scale (neutral start)
    maxScale: 1.035,           // Push-in max scale (subtle, premium)
    driftMinScale: 1.03,       // Drift start scale (coupled zoom-pan, auto-calculated)
    driftMaxScale: 1.06,       // Drift max scale (coupled zoom-pan hard cap)
    minDriftPercent: 0.4,      // 0.4% of frame width (premium range)
    maxDriftPercent: 1.2,      // 1.2% of frame width (premium range, hard cap)
    holdFraction: 0.25,        // 25% hold phase (then move)
    driftSafetyPx: 4,          // 4px safety margin (or 0.15% frame width, whichever is larger)
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
 * Documentary progress function: starts mid-curve for continuous motion from frame 1
 * Eliminates "pause then move" feel by cutting into the ease curve at startOffset
 * @param t - Normalized time (0..1)
 * @param startOffset - Starting point in ease curve (default 0.12 = 12% into curve)
 * @returns Eased progress value
 */
function docProgress(t: number, startOffset: number = 0.12): number {
  t = Math.max(0, Math.min(1, t));
  // Cut into mid-curve: startOffset + (1 - startOffset) * t
  // This means at t=0, we're at startOffset in the ease curve (already moving)
  // At t=1, we're at 1.0 in the ease curve (full motion)
  const tt = startOffset + (1 - startOffset) * t;
  return easeInOutSine(tt);
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

  // Calculate safety margin (use larger of absolute px or 0.15% frame width)
  const safetyMarginPx = Math.max(cfg.driftSafetyPx, params.frameWidth * 0.0015);

  switch (preset) {
    case 'STATIC':
      scale = 1.0;
      translateX = 0;
      translateY = 0;
      break;

    case 'SLOW_PUSH_IN': {
      // Scale: minScale -> maxScale (use default 1.025 for consistency)
      const defaultEndScale = 1.025;
      const endScale = defaultEndScale;
      
      // Use docProgress for continuous motion from frame 1 (no hold/pause)
      const eased = docProgress(t);
      
      scale = cfg.minScale + (endScale - cfg.minScale) * eased;
      translateX = 0;
      translateY = 0;
      break;
    }

    case 'SLOW_PULL_BACK': {
      // Scale: maxScale -> minScale (pull back)
      const startScale = cfg.maxScale;
      const endScale = cfg.minScale;
      
      // Use docProgress for continuous motion from frame 1 (no hold/pause)
      const eased = docProgress(t);
      
      scale = startScale - (startScale - endScale) * eased;
      translateX = 0;
      translateY = 0;
      break;
    }

    case 'LATERAL_DRIFT_L':
    case 'LATERAL_DRIFT_R': {
      // Coupled zoom-pan: compute required endScale from requested drift distance
      const isLeft = preset === 'LATERAL_DRIFT_L';
      
      // Select drift percentage (premium range: 0.4%-1.2%)
      let desiredDriftPercent = rng.nextFloat(cfg.minDriftPercent, cfg.maxDriftPercent);
      let desiredDriftPx = (params.frameWidth * desiredDriftPercent) / 100;
      
      // Calculate required end scale from pan distance (overscan rule):
      // requiredEndScale = 1 + 2*(absDriftPx + safetyPx)/frameWidth
      let requiredEndScale = 1 + (2 * (desiredDriftPx + safetyMarginPx)) / params.frameWidth;
      
      // If requiredEndScale exceeds 1.06, reduce driftPercent until it fits
      let endScale: number;
      let actualDriftPx: number;
      
      if (requiredEndScale > cfg.driftMaxScale) {
        // Back-calculate maximum drift from max scale
        const maxDriftPx = ((cfg.driftMaxScale - 1) * params.frameWidth) / 2 - safetyMarginPx;
        actualDriftPx = Math.min(desiredDriftPx, maxDriftPx);
        endScale = cfg.driftMaxScale;
      } else {
        // Clamp endScale to [1.03, 1.06] premium safe range
        endScale = clamp(requiredEndScale, cfg.driftMinScale, cfg.driftMaxScale);
        actualDriftPx = desiredDriftPx;
      }
      
      // Use docProgress for continuous motion from frame 1 (no hold/pause)
      const eased = docProgress(t);
      
      // Scale ramps with same eased progress: scale(t) = 1 + (endScale - 1)*docProgress(t)
      // Start at scale 1.0, ramp to endScale
      scale = 1.0 + (endScale - 1.0) * eased;
      
      // Translate uses same eased progress, constrained by overscan rule
      // overscanPerSidePx = ((scale - 1) * frameWidth) / 2
      // abs(translateX) <= overscanPerSidePx - safetyPx
      const currentOverscanPerSide = ((scale - 1) * params.frameWidth) / 2;
      const maxTranslateAtCurrentScale = Math.max(0, currentOverscanPerSide - safetyMarginPx);
      
      // Apply drift with eased progress, clamped to current scale's overscan limit
      const rawTranslateX = isLeft ? -actualDriftPx * eased : actualDriftPx * eased;
      translateX = clamp(rawTranslateX, -maxTranslateAtCurrentScale, maxTranslateAtCurrentScale);
      translateY = 0;
      break;
    }

    case 'PARALLAX_PUSH_IN': {
      // Parallax: background and foreground scale differently
      // For single-layer implementation, use subtle push-in
      const endScale = 1.02; // Middle ground (consistent)
      
      // Use docProgress for continuous motion from frame 1 (no hold/pause)
      const eased = docProgress(t);
      
      scale = cfg.minScale + (endScale - cfg.minScale) * eased;
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
  // Scale: clamp to config limits
  const maxScaleForPreset = 
    preset === 'LATERAL_DRIFT_L' || preset === 'LATERAL_DRIFT_R' 
      ? cfg.driftMaxScale 
      : cfg.maxScale;
  scale = Math.max(1.0, Math.min(maxScaleForPreset, scale));
  
  // Translate: ensure it doesn't exceed overscan limits (derived from current scale, not hard-coded)
  // overscanPerSidePx = ((scale - 1) * frameWidth) / 2
  // abs(translateX) <= overscanPerSidePx - safetyPx
  const currentOverscanPerSide = ((scale - 1) * params.frameWidth) / 2;
  const maxTranslateAtScale = Math.max(0, currentOverscanPerSide - safetyMarginPx);
  translateX = clamp(translateX, -maxTranslateAtScale, maxTranslateAtScale);
  translateY = clamp(translateY, -maxTranslateAtScale, maxTranslateAtScale);

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
