/**
 * Stage 3: Motion Planning
 * Generates per-image motion from emotion + composition using cinematic movement library
 */

/**
 * Cinematic movement library with constraints
 */
const MOVEMENT_LIBRARY = {
  hold: {
    name: 'hold',
    description: 'No movement - gallery static',
    constraints: {
      requires_depth: false,
      requires_symmetry: false,
      max_zoom: 1.0,
      pan_allowed: false
    }
  },
  slow_push_in: {
    name: 'slow_push_in',
    description: 'Gentle push-in for gallery feel (max 1.8%)',
    constraints: {
      requires_depth: false,
      requires_symmetry: false,
      max_zoom: 1.018,
      min_zoom: 1.00,
      pan_allowed: false
    },
    emotion_mapping: ['calm', 'intimacy', 'curiosity']
  }
};

/**
 * Map emotion to movement type based on analysis and constraints
 * @param {Object} analysis - Vision analysis result for this image
 * @param {Object} shotInfo - Shot information from sequence plan {purpose, target_emotion, motion_hint}
 * @returns {string} Movement type name
 */
function mapEmotionToMovement(analysis, shotInfo) {
  // Deterministic gallery-grade motion: no randomness, no jitter.
  // 50% hold, 50% slow push-in; ignore per-emotion micro variants for stability.
  const seed = (analysis?.filename || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const useHold = seed % 2 === 0;
  const selected = useHold ? 'hold' : 'slow_push_in';
  console.log(`[MOTION-PLANNING] Selected movement: ${selected} (seed=${seed})`);
  return selected;
}

/**
 * Generate motion parameters for a movement type
 * @param {string} movementType - Movement type name
 * @param {Object} analysis - Vision analysis result
 * @param {Object} shotInfo - Shot information {purpose, target_emotion}
 * @returns {Object} Motion parameters {zoomStart, zoomEnd, panXPercent, panYPercent, duration_multiplier}
 */
function generateMotionParameters(movementType, analysis, shotInfo) {
  const moveDef = MOVEMENT_LIBRARY[movementType];
  if (!moveDef) {
    // Default to hold
    return { zoomStart: 1.0, zoomEnd: 1.0, panXPercent: 0, panYPercent: 0, duration_multiplier: 1.0 };
  }
  
  const params = {
    zoomStart: 1.0,
    zoomEnd: 1.0,
    panXPercent: 0,
    panYPercent: 0,
    duration_multiplier: 1.0
  };
  
  // Set zoom based on movement type (clamped)
  if (movementType === 'slow_push_in') {
    params.zoomStart = 1.00;
    params.zoomEnd = 1.018;
  }
  
  // Duration multiplier based on purpose
  if (shotInfo.purpose === 'climax') {
    params.duration_multiplier = 1.15; // Slightly longer
  } else if (shotInfo.purpose === 'resolve') {
    params.duration_multiplier = 0.85; // Slightly shorter
  }
  
  return params;
}

/**
 * Generate motion plan for all images (Stage 3)
 * @param {Array<Object>} analysisResults - Vision analysis results (Stage 1)
 * @param {Object} sequencePlan - Sequence plan with ordered_ids and shots (Stage 2)
 * @returns {Array<Object>} Motion plan array, one per image in order
 */
export function generateMotionPlan(analysisResults, sequencePlan) {
  console.log(`[MOTION-PLANNING] Generating motion plan for ${sequencePlan.ordered_ids.length} images...`);
  
  const motionPlan = [];
  
  // Generate motion for each image in sequence order
  for (let i = 0; i < sequencePlan.ordered_ids.length; i++) {
    const imageId = sequencePlan.ordered_ids[i];
    const analysis = analysisResults[imageId];
    // Use shots array instead of beat_map - shots[i] corresponds to ordered_ids[i]
    const shotInfo = sequencePlan.shots && sequencePlan.shots[i] ? sequencePlan.shots[i] : {
      purpose: 'build',
      target_emotion: { primary: 'calm', secondary: '' },
      motion_hint: 'slow_push_in'
    };
    
    // Validate shot.id matches ordered_ids[i]
    if (shotInfo.id !== undefined && shotInfo.id !== imageId) {
      console.warn(`[MOTION-PLANNING] Shot ${i} ID mismatch: shot.id=${shotInfo.id}, ordered_ids[${i}]=${imageId}`);
    }
    
    if (!analysis) {
      throw new Error(`Missing analysis for image ID ${imageId}`);
    }
    
    // Deterministic gallery-style motion: alternate hold / slow_push_in
    const movementType = (i % 2 === 0) ? 'hold' : mapEmotionToMovement(analysis, shotInfo);
    
    // If shot has motion_hint, prefer it over emotion-based mapping
    let finalMovementType = movementType;
    if (shotInfo.motion_hint) {
      // Map motion_hint to movement library types
      const hintMap = {
        'slow_push_in': 'slow_push_in',
        'slow_pull_out': 'slow_pull_out',
        'gentle_pan': 'lateral_drift_left', // Default to left, will be adjusted
        'hold': 'hold',
        'reveal': 'reveal_pan',
        'subtle_parallax': 'subtle_parallax'
      };
      if (hintMap[shotInfo.motion_hint]) {
        finalMovementType = hintMap[shotInfo.motion_hint];
        console.log(`[MOTION-PLANNING] Using motion_hint: ${shotInfo.motion_hint} -> ${finalMovementType}`);
      }
    }
    
    // Generate motion parameters (use shotInfo instead of beatInfo)
    const motionParams = generateMotionParameters(finalMovementType, analysis, shotInfo);
    
    motionPlan.push({
      imageId,
      filename: analysis.filename,
      movementType,
      ...motionParams
    });
  }
  
  // Validate motion plan coverage
  if (motionPlan.length !== sequencePlan.ordered_ids.length) {
    throw new Error(
      `Motion plan incomplete: ${motionPlan.length}/${sequencePlan.ordered_ids.length} images planned`
    );
  }
  
  console.log(`[MOTION-PLANNING] Generated motion plan for ${motionPlan.length} images`);
  
  return motionPlan;
}

