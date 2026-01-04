/**
 * FOCUS_THEN_MOVE Motion Generator
 * 2-phase camera plan: Focus hold (20-30%) then smooth move (70-80%)
 * No rotation, no jitter, premium cinematic feel
 */

/**
 * Seeded RNG for deterministic motion selection
 */
class SeededRNG {
  constructor(seed) {
    this.state = seed % 2147483647;
    if (this.state <= 0) this.state += 2147483646;
  }

  next() {
    this.state = (this.state * 16807) % 2147483647;
    return (this.state - 1) / 2147483646;
  }

  nextFloat(min, max) {
    return min + this.next() * (max - min);
  }

  nextInt(min, max) {
    return Math.floor(this.nextFloat(min, max + 1));
  }
}

/**
 * Easing function: easeInOutCubic (smooth, cinematic)
 */
function easeInOutCubic(t) {
  if (t < 0.5) {
    return 4 * t * t * t;
  }
  return 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Clamp helper
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Generate FOCUS_THEN_MOVE motion specs for image segments
 * @param {Object} options
 * @param {number} options.count - Number of images
 * @param {string} options.pack - Motion pack ('documentary' or 'default')
 * @param {string} options.aspectRatio - Aspect ratio
 * @param {number} options.fps - Frame rate
 * @param {string} options.seed - Optional seed string for determinism
 * @returns {Array} Array of motion specs with FOCUS_THEN_MOVE plan
 */
export function generatePhase1Motions({ count, pack = 'default', aspectRatio = '16:9', fps = 24, seed = null }) {
  // Generate deterministic seed if not provided
  let seedValue = seed;
  if (!seedValue) {
    seedValue = (count * 7919 + (pack === 'documentary' ? 12345 : 67890)) % 2147483647;
  } else if (typeof seedValue === 'string') {
    let hash = 0;
    for (let i = 0; i < seedValue.length; i++) {
      const char = seedValue.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    seedValue = Math.abs(hash);
  }

  // Static mode: no motion, just still images with focal crop
  if (pack === 'none' || pack === 'static') {
    const motions = [];
    for (let i = 0; i < count; i++) {
      motions.push({
        type: 'STATIC',
        startZoom: 1.0,
        endZoom: 1.0,
        focalX: 0.5,
        focalY: 0.5,
        panOffsetX: 0,
        panOffsetY: 0,
        holdSeconds: 0,
      });
    }
    return motions;
  }

  const rng = new SeededRNG(seedValue);

  // Documentary Gimbal Move defaults (no rotation, no jitter)
  const Z_START = 1.035;           // start zoom (cap range: 1.035-1.055)
  const Z_END_PUSH = 1.055;        // max push-in (cap at 1.055)
  const Z_END_PULL = 1.00;         // pull-out to full
  const holdSeconds = 0.7;         // 0.7s hard hold locked to focal point

  // Move type distribution: 70% PUSH_IN, 20% PULL_OUT, 10% PAN
  const motions = [];

  for (let i = 0; i < count; i++) {
    const roll = rng.next();
    
    // Determine move type
    let moveType;
    if (roll < 0.70) {
      moveType = 'PUSH_IN';
    } else if (roll < 0.90) {
      moveType = 'PULL_OUT';
    } else {
      moveType = 'PAN';
    }

    // Focal point: rule-of-thirds center bias (deterministic, no randomization)
    // fx = 0.5w, fy = 0.45h (slightly above center feels like "face/subject first")
    const focalX = 0.5;
    const focalY = 0.45;

    // Pan direction for PAN type (deterministic based on index, no random flips)
    // Use index to create subtle variation without randomness
    const panAngle = (i * 137.5) % 360; // Golden angle for even distribution
    const panDirX = Math.cos((panAngle * Math.PI) / 180);
    const panDirY = Math.sin((panAngle * Math.PI) / 180);

    // Compute zoom range based on move type
    let startZoom, endZoom;
    if (moveType === 'PUSH_IN') {
      startZoom = Z_START;
      endZoom = Z_END_PUSH;
    } else if (moveType === 'PULL_OUT') {
      startZoom = Z_END_PUSH; // Start zoomed in
      endZoom = Z_END_PULL;
    } else { // PAN
      startZoom = Z_START;
      endZoom = Z_START; // Keep zoom fixed during pan
    }

    // Pan offset (only for PAN type, will be clamped to 1-3% in buildZoompanExpr)
    const panOffsetX = moveType === 'PAN' ? panDirX : 0;
    const panOffsetY = moveType === 'PAN' ? panDirY * 0.5 : 0;

    motions.push({
      type: moveType,
      startZoom,
      endZoom,
      focalX,
      focalY,
      panOffsetX, // Normalized pan offset (-1..1), will be scaled to 1-3% in buildZoompanExpr
      panOffsetY,
      holdSeconds, // Absolute time in seconds (0.7s)
    });
  }

  return motions;
}
