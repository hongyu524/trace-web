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
 * Clamp value to [0, 1] range
 */
function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

/**
 * Linear interpolation helper
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Easing function: easeOutCubic (non-zero initial velocity, smooth deceleration)
 * Starts moving immediately
 */
function easeOutCubic(t: number): number {
  t = clamp01(t);
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Easing function: easeOutSine (optional: still smooth but less "stopped" than in-out)
 */
function easeOutSine(t: number): number {
  t = clamp01(t);
  return Math.sin((t * Math.PI) / 2);
}

/**
 * Cut-in progress: key function that cuts in mid-move so frame 1 is already moving
 * This removes the "pause first" because you never start at progress = 0
 * @param u - Normalized time (0..1)
 * @param pStart - Starting point in progress (default 0.14 = 14% into curve)
 * @param pEnd - Ending point in progress (default 0.96 = 96% into curve)
 * @returns Progress value that starts at pStart (not 0) and ends at pEnd
 */
function cutInProgress(u: number, pStart: number = 0.14, pEnd: number = 0.96): number {
  u = clamp01(u);
  const e = easeOutCubic(u); // or easeOutSine(u) for alternative feel
  return pStart + (pEnd - pStart) * e;
}

/**
 * Calculate starting progress from previous progress end for continuity
 * Maintains motion continuity across clips by starting from where previous clip ended
 * @param prevProgressEnd - Previous clip's ending progress (0..1)
 * @returns Starting progress for current clip, clamped to reasonable range
 */
function calculateContinuityStart(prevProgressEnd: number): number {
  // Start slightly behind previous end (0.08 offset) to maintain forward motion
  // Clamp to [0.08, 0.22] to ensure we're always mid-motion
  return clamp(prevProgressEnd - 0.08, 0.08, 0.22);
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
 * Choose motion preset based on story position and continuity rules
 * Lightweight story planner that creates narrative arc
 * 
 * Rules:
 * - First 1-2 shots: SLOW_PUSH_IN only (endScale ~1.02-1.03 handled in transform)
 * - Middle shots: DRIFT (mostly X), driftPercent 0.4-1.2, endScale derived
 * - Detail shots (high-saliency or faces): PUSH_IN slightly stronger (1.03-1.045)
 * - Last 1 shot: SLOW_PULL_BACK or very light PUSH_IN (resolution)
 * - Avoid repeating same preset more than 2x in a row
 * - Maintain drift direction continuity for 2-3 shots then change
 */
function choosePreset(
  shotIndex: number,
  totalShots: number,
  shotMeta: ShotMetadata,
  rng: SeededRNG,
  config: DocumentaryMotionConfig
): MotionPresetName {
  const position = shotIndex / Math.max(1, totalShots - 1); // 0.0 to 1.0
  
  // Track drift direction continuity
  const isDriftL = shotMeta.previousPreset === 'LATERAL_DRIFT_L';
  const isDriftR = shotMeta.previousPreset === 'LATERAL_DRIFT_R';
  const isDrift = isDriftL || isDriftR;
  const wasDriftL = shotMeta.previousPreviousPreset === 'LATERAL_DRIFT_L';
  const wasDriftR = shotMeta.previousPreviousPreset === 'LATERAL_DRIFT_R';
  
  // Count consecutive drifts in same direction
  let consecutiveDrifts = 0;
  if (isDriftL && wasDriftL) consecutiveDrifts = 2;
  else if (isDriftR && wasDriftR) consecutiveDrifts = 2;
  else if (isDrift) consecutiveDrifts = 1;
  
  // First 1-2 shots: SLOW_PUSH_IN only
  if (shotIndex < 2) {
    return 'SLOW_PUSH_IN';
  }
  
  // Last shot: SLOW_PULL_BACK or very light PUSH_IN (resolution)
  if (shotIndex === totalShots - 1) {
    if (rng.next() < 0.6) {
      return 'SLOW_PULL_BACK';
    } else {
      return 'SLOW_PUSH_IN'; // Very light push-in for resolution
    }
  }
  
  // Avoid repeating same preset more than 2x in a row
  if (shotMeta.previousPreset === shotMeta.previousPreviousPreset && shotMeta.previousPreset) {
    const lastPreset = shotMeta.previousPreset;
    
    if (lastPreset === 'SLOW_PUSH_IN') {
      // After 2 push-ins, prefer drift (maintain direction continuity)
      if (consecutiveDrifts >= 2) {
        // Switch direction after 2-3 shots
        return isDriftL ? 'LATERAL_DRIFT_R' : 'LATERAL_DRIFT_L';
      } else if (wasDriftL) {
        return 'LATERAL_DRIFT_L';
      } else if (wasDriftR) {
        return 'LATERAL_DRIFT_R';
      } else {
        return rng.next() < 0.5 ? 'LATERAL_DRIFT_L' : 'LATERAL_DRIFT_R';
      }
    }
    
    if (lastPreset === 'LATERAL_DRIFT_L' || lastPreset === 'LATERAL_DRIFT_R') {
      // After 2 drifts, prefer push-in
      return 'SLOW_PUSH_IN';
    }
    
    if (lastPreset === 'SLOW_PULL_BACK') {
      // After 2 pull-backs, prefer push-in
      return 'SLOW_PUSH_IN';
    }
  }
  
  // Maintain drift direction continuity for 2-3 shots then change
  if (isDrift && consecutiveDrifts < 2) {
    // Continue same direction for 2-3 shots
    return isDriftL ? 'LATERAL_DRIFT_L' : 'LATERAL_DRIFT_R';
  }
  
  if (isDrift && consecutiveDrifts >= 2) {
    // After 2-3 shots in same direction, change direction or switch to push-in
    if (rng.next() < 0.7) {
      // 70% chance to switch direction (no ping-pong per shot)
      return isDriftL ? 'LATERAL_DRIFT_R' : 'LATERAL_DRIFT_L';
    } else {
      // 30% chance to switch to push-in
      return 'SLOW_PUSH_IN';
    }
  }
  
  // Middle shots: DRIFT (mostly X) or PUSH_IN
  // More drift in middle section (position 0.2-0.8), less near edges
  const isMiddle = position > 0.2 && position < 0.8;
  const driftProbability = isMiddle ? 0.4 : 0.2; // 40% drift in middle, 20% near edges
  
  const rand = rng.next();
  
  if (rand < driftProbability) {
    // Choose drift direction (maintain continuity if possible)
    if (wasDriftL && !isDrift) {
      return 'LATERAL_DRIFT_L'; // Continue L direction
    } else if (wasDriftR && !isDrift) {
      return 'LATERAL_DRIFT_R'; // Continue R direction
    } else {
      // Random direction (50/50)
      return rng.next() < 0.5 ? 'LATERAL_DRIFT_L' : 'LATERAL_DRIFT_R';
    }
  } else {
    // Default to push-in
    return 'SLOW_PUSH_IN';
  }
}

/**
 * Pick a documentary motion preset based on shot metadata and story planning
 * Uses lightweight story planner for narrative arc
 */
export function pickDocumentaryPreset(
  shotMeta: ShotMetadata,
  rng?: SeededRNG,
  config?: DocumentaryMotionConfig
): MotionPresetName {
  const cfg = config ?? getDocumentaryDefaults();
  const seedRNG = rng ?? new SeededRNG(generateSeed(shotMeta));
  
  // Use story planner instead of random selection
  return choosePreset(shotMeta.index, shotMeta.totalShots, shotMeta, seedRNG, cfg);
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
    frame?: number;    // Current frame index (0-based)
    frames?: number;   // Total frame count
    prevProgressEnd?: number;  // Previous clip's ending progress for continuity (0..1)
  }
): DocumentaryTransformAt {
  const cfg = params.config ?? getDocumentaryDefaults();
  const rng = params.seed !== undefined ? new SeededRNG(params.seed) : new SeededRNG(12345);
  
  // Use frame-based calculation if available, otherwise fall back to normalized time t
  const u = params.frame !== undefined && params.frames !== undefined
    ? params.frame / Math.max(1, params.frames - 1)
    : clamp01(t);
  
  // Calculate starting progress: use continuity from previous clip if available, otherwise default
  const pStart = params.prevProgressEnd !== undefined
    ? calculateContinuityStart(params.prevProgressEnd)
    : 0.14; // Default start
  
  // Cut-in progress: starts at pStart (continuity-aware), ends at 0.96 (never starts at 0)
  const p = cutInProgress(u, pStart, 0.96);

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
      const scaleStart = cfg.minScale;
      const scaleEnd = 1.025; // Default end scale
      
      // Push: scale lerps from scaleStart to scaleEnd using cut-in progress
      scale = lerp(scaleStart, scaleEnd, p);
      translateX = 0;
      translateY = 0;
      break;
    }

    case 'SLOW_PULL_BACK': {
      // Scale: maxScale -> minScale (pull back)
      const scaleStart = cfg.maxScale;
      const scaleEnd = cfg.minScale;
      
      // Pull back: scale lerps from scaleStart to scaleEnd using cut-in progress
      scale = lerp(scaleStart, scaleEnd, p);
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
      
      // Drift (coupled zoom-pan): use same progress for BOTH scale and translation
      // Scale: lerp from 1.0 to driftEndScale
      const scaleStart = 1.0;
      scale = lerp(scaleStart, endScale, p);
      
      // Translate: lerp from 0 to actualDriftPx using same progress
      const xStart = 0;
      const xEnd = actualDriftPx;
      const yStart = 0;
      const yEnd = 0;
      
      translateX = isLeft ? -lerp(xStart, xEnd, p) : lerp(xStart, xEnd, p);
      translateY = lerp(yStart, yEnd, p);
      
      // Constrain translate to overscan rule at current scale
      // overscanPerSidePx = ((scale - 1) * frameWidth) / 2
      // abs(translateX) <= overscanPerSidePx - safetyPx
      const currentOverscanPerSide = ((scale - 1) * params.frameWidth) / 2;
      const maxTranslateAtCurrentScale = Math.max(0, currentOverscanPerSide - safetyMarginPx);
      translateX = clamp(translateX, -maxTranslateAtCurrentScale, maxTranslateAtCurrentScale);
      break;
    }

    case 'PARALLAX_PUSH_IN': {
      // Parallax: background and foreground scale differently
      // For single-layer implementation, use subtle push-in
      const scaleStart = cfg.minScale;
      const scaleEnd = 1.02; // Middle ground (consistent)
      
      // Push: scale lerps from scaleStart to scaleEnd using cut-in progress
      scale = lerp(scaleStart, scaleEnd, p);
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
