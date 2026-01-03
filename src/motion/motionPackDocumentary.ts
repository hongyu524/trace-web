/**
 * Documentary Motion Pack
 * Produces subtle, high-end documentary camera movement with strict rules:
 * - No rotation by default
 * - No diagonal wandering
 * - Slow movement only
 * - 40-50% shots should be static (for premium feel)
 * - Transitions are cross-dissolve 300-500ms
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
  /** Maximum scale for zoomed presets */
  maxScale: number;
  /** Minimum drift percentage of frame width */
  minDriftPercent: number;
  /** Maximum drift percentage of frame width */
  maxDriftPercent: number;
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
    minScale: 1.01,
    maxScale: 1.035,
    minDriftPercent: 0.8,      // 0.8% of frame width
    maxDriftPercent: 2.0,      // 2.0% of frame width
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
 * Easing function: easeInOutSine
 */
function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/**
 * Easing function: linear
 */
function linear(t: number): number {
  return t;
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
 */
export function getDocumentaryTransformAt(
  t: number,
  preset: MotionPresetName,
  params: {
    frameWidth: number;
    frameHeight: number;
    seed?: number;
    config?: DocumentaryMotionConfig;
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
      // Fixed scale: slightly zoomed to avoid edge reveal
      scale = rng.nextFloat(1.01, 1.03);
      // translateX: negative drift (left), 0.8% to 2.0% of frame width
      const driftPercent = rng.nextFloat(cfg.minDriftPercent, cfg.maxDriftPercent);
      const driftPx = (params.frameWidth * driftPercent) / 100;
      // Linear movement from 0 to -driftPx
      translateX = -driftPx * t;
      translateY = 0;
      break;
    }

    case 'LATERAL_DRIFT_R': {
      // Fixed scale: slightly zoomed to avoid edge reveal
      scale = rng.nextFloat(1.01, 1.03);
      // translateX: positive drift (right), 0.8% to 2.0% of frame width
      const driftPercent = rng.nextFloat(cfg.minDriftPercent, cfg.maxDriftPercent);
      const driftPx = (params.frameWidth * driftPercent) / 100;
      // Linear movement from 0 to +driftPx
      translateX = driftPx * t;
      translateY = 0;
      break;
    }

    case 'PARALLAX_PUSH_IN': {
      // Parallax: background and foreground scale differently
      // For single-layer implementation, use subtle push-in
      // Background-like: scale 1.0 -> up to 1.02
      // Foreground-like: scale 1.0 -> up to 1.035
      // Since we can't do multi-layer easily, use average
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
 * Generate a deterministic seed from shot metadata (exported for testing)
 */
export function generateSeedFromMetadata(shotMeta: ShotMetadata, globalSeed?: number): number {
  return generateSeed(shotMeta, globalSeed);
}

/**
 * Export SeededRNG for testing
 */
export { SeededRNG };

