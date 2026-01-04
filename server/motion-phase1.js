/**
 * Phase 1 Motion Generator
 * Lightweight per-image motion specs for Ken Burns effect
 * No dependency on analysis results or sequence planning
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
 * Generate Phase 1 motion specs for image segments
 * @param {Object} options
 * @param {number} options.count - Number of images
 * @param {string} options.pack - Motion pack ('documentary' or 'default')
 * @param {string} options.aspectRatio - Aspect ratio (for future use)
 * @param {number} options.fps - Frame rate (for future use)
 * @param {string} options.seed - Optional seed string for determinism (default: deterministic based on count)
 * @returns {Array} Array of motion specs
 */
export function generatePhase1Motions({ count, pack = 'default', aspectRatio = '16:9', fps = 24, seed = null }) {
  // Generate deterministic seed if not provided
  let seedValue = seed;
  if (!seedValue) {
    // Use a simple hash of count + pack for determinism
    seedValue = (count * 7919 + (pack === 'documentary' ? 12345 : 67890)) % 2147483647;
  } else if (typeof seedValue === 'string') {
    // Hash string seed
    let hash = 0;
    for (let i = 0; i < seedValue.length; i++) {
      const char = seedValue.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    seedValue = Math.abs(hash);
  }

  const rng = new SeededRNG(seedValue);

  // Pack-specific defaults
  const config = pack === 'documentary' ? {
    staticWeight: 0.10,
    pushInWeight: 0.40,
    driftWeight: 0.40,
    pullBackWeight: 0.10,
    maxScale: 1.06,
    driftMax: 0.0075, // Reduced to 0.75% of frame (was 1.5%) for subtle, smooth drift
  } : {
    staticWeight: 0.50,
    pushInWeight: 0.40,
    driftWeight: 0.08,
    pullBackWeight: 0.02,
    maxScale: 1.035,
    driftMax: 0.005, // Reduced to 0.5% of frame for subtle motion
  };

  const motions = [];
  let previousType = null;
  let previousPreviousType = null;

  for (let i = 0; i < count; i++) {
    const position = i / Math.max(1, count - 1); // 0.0 to 1.0

    // Pick motion type (avoid same type twice in a row for drift/pull_back)
    let type;
    const roll = rng.next();

    // Build cumulative weights
    let cumulative = 0;
    const weights = [
      { type: 'static', weight: config.staticWeight },
      { type: 'push_in', weight: config.pushInWeight },
      { type: 'drift', weight: config.driftWeight },
      { type: 'pull_back', weight: config.pullBackWeight },
    ];

    // Adjust weights based on previous types (prevent direction flips)
    let adjustedWeights = [...weights];
    if (previousType === 'drift') {
      // Reduce drift weight if previous was drift (prevent consecutive drifts)
      adjustedWeights = adjustedWeights.map(w => 
        w.type === 'drift' ? { ...w, weight: w.weight * 0.3 } : w
      );
    }
    if (previousType === 'pull_back') {
      // Reduce pull_back weight if previous was pull_back
      adjustedWeights = adjustedWeights.map(w => 
        w.type === 'pull_back' ? { ...w, weight: w.weight * 0.3 } : w
      );
    }
    if (previousPreviousType === 'drift' && previousType === 'drift') {
      // Prefer static after two drifts
      adjustedWeights = adjustedWeights.map(w => 
        w.type === 'static' ? { ...w, weight: w.weight * 1.5 } : w
      );
    }
    
    // Prevent drift direction flips: if previous was drift, prefer static or opposite-direction drift
    // (This is handled by reducing consecutive drift weight above)

    // Normalize weights
    const totalWeight = adjustedWeights.reduce((sum, w) => sum + w.weight, 0);
    adjustedWeights = adjustedWeights.map(w => ({ ...w, weight: w.weight / totalWeight }));

    // Select type
    for (const { type: t, weight } of adjustedWeights) {
      cumulative += weight;
      if (roll <= cumulative) {
        type = t;
        break;
      }
    }
    if (!type) type = 'static'; // Fallback

    // Generate motion params based on type
    let startScale, endScale, driftX, driftY;

    switch (type) {
      case 'static':
        startScale = 1.0;
        endScale = 1.0;
        driftX = 0;
        driftY = 0;
        break;

      case 'push_in':
        startScale = 1.0;
        endScale = 1.0 + rng.nextFloat(0.01, config.maxScale - 1.0);
        driftX = 0;
        driftY = 0;
        break;

      case 'drift':
        // Fixed scale (slightly zoomed to avoid edge reveal)
        const driftScale = 1.0 + rng.nextFloat(0.02, config.maxScale - 1.0);
        startScale = driftScale;
        endScale = driftScale;
        // Random drift direction
        const angle = rng.nextFloat(0, Math.PI * 2);
        const driftAmount = rng.nextFloat(0.005, config.driftMax);
        driftX = Math.cos(angle) * driftAmount;
        driftY = Math.sin(angle) * driftAmount;
        break;

      case 'pull_back':
        startScale = 1.0 + rng.nextFloat(0.01, config.maxScale - 1.0);
        endScale = 1.0;
        driftX = 0;
        driftY = 0;
        break;

      default:
        startScale = 1.0;
        endScale = 1.0;
        driftX = 0;
        driftY = 0;
    }

    motions.push({
      type,
      startScale,
      endScale,
      driftX, // normalized -1..1 (percentage direction)
      driftY,
    });

    // Update previous types
    previousPreviousType = previousType;
    previousType = type;
  }

  return motions;
}

