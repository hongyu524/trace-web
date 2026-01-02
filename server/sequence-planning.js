/**
 * Stage 2: Sequence Planning
 * Creates global narrative sequence using vision analysis results
 * Outputs ordered_ids with ALL images, emotion_arc, and shots array
 */

import OpenAI from 'openai';

/**
 * Create sequence plan from vision analysis results (Stage 2)
 * @param {Array<Object>} analysisResults - Array of vision analysis results from Stage 1
 * @param {string} promptText - User's prompt/context
 * @param {string} openaiApiKey - OpenAI API key
 * @param {Object} progressReporter - Optional progress reporter for SSE updates
 * @returns {Promise<Object>} Sequence plan with ordered_ids, emotion_arc, shots
 */
export async function createSequencePlan(analysisResults, promptText, openaiApiKey, progressReporter = null) {
  console.log(`[SEQUENCE-PLANNING] Creating sequence plan from ${analysisResults.length} image analyses...`);
  
  if (progressReporter) {
    progressReporter.report('sequence-planning', 55, 'Planning sequence...');
  }
  
  if (!openaiApiKey) {
    throw new Error('OpenAI API key required for sequence planning');
  }
  
  const apiKeySuffix = openaiApiKey.slice(-6);
  console.log(`[SEQUENCE-PLANNING] OpenAI client initialized with key (last6): ...${apiKeySuffix}`);
  
  const openai = new OpenAI({ apiKey: openaiApiKey });
  
  // Normalize ids and prep summary for the model
  const images = analysisResults.map((a, idx) => ({
    id: String(a.id ?? idx),
    filename: a.filename || a.originalname || `image_${idx}`,
    caption: a.caption || a.subject || '',
    tags: Array.isArray(a.tags) ? a.tags : [],
    mood: Array.isArray(a.mood) ? a.mood : [],
    shotType: a.shotType || a.composition?.framing || 'medium',
    visualWeight: Number(a.visualWeight ?? a.visual_energy ?? 5) || 5,
    composition: a.composition?.description || a.composition?.framing || 'medium'
  }));
  const targetCount = images.length; // always use all images (no capping)
  console.log(`[SEQUENCE-PLANNING] targetCount=${targetCount} (n=${images.length})`);
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
    
    const modelName = 'gpt-4o-mini';
    const endpoint = 'chat.completions.create';
    const apiKeySuffix = openai.apiKey ? openai.apiKey.slice(-6) : 'N/A';
    
    console.log(`[OPENAI] Sequence Planning - Endpoint: ${endpoint}, Model: ${modelName}, Key (last6): ...${apiKeySuffix}`);
    
    const response = await openai.chat.completions.create({
      model: modelName,
      messages: [{
        role: 'system',
        content: `You are a professional video editor creating a cinematic memory video sequence plan.

Your task is to order ALL provided images into a story (no omissions).

OUTPUT FORMAT (JSON only):
{
  "orderedIds": ["idA", "idB", ...],
  "beats": [
    { "id": "idA", "role": "opening|build|turn|climax|resolution", "reason": "brief why" }
  ]
}

HARD CONSTRAINTS:
1) Use only provided ids.
2) Return exactly ALL ids (orderedIds.length == images.length).
3) Each id appears exactly once.
4) Avoid near-duplicate adjacency (similar tags/composition).
5) Do NOT preserve upload order unless it is already the absolute best story.

Return valid JSON only, no markdown.`
      }, {
        role: 'user',
        content: `Order ALL images for a story (do NOT drop any).
User prompt: ${promptText || '(none)'}
images = ${JSON.stringify(images, null, 2)}

Return orderedIds containing every id exactly once (length == images.length) and beats with roles (opening/build/turn/climax/resolution).`
      }],
      temperature: 0.4,
      max_tokens: 2000
    }, {
      signal: controller.signal  // ✅ Correct: signal passed as second argument (request options)
    });
    
    clearTimeout(timeout);
    
    const content = response.choices[0].message.content.trim();
    const jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const raw = JSON.parse(jsonContent);
    const selectedOrderedIds = raw.orderedIds || raw.selectedOrderedIds || raw.ordered_ids || [];
    const beats = Array.isArray(raw.beats) ? raw.beats : [];
    const valid = isValidSelection(selectedOrderedIds, images, targetCount);
    
    let finalIds = selectedOrderedIds;
    if (!valid) {
      console.warn('[SEQUENCE-PLANNING] Model output invalid, using deterministic fallback');
      finalIds = deterministicFallback(images, targetCount);
    }
    
    // Build shots from beats or fallback
    const shots = buildShots(finalIds, beats);
    
    // Map ids to original image indices for renderer
    const orderedIdsStr = finalIds.map(id => (typeof id === 'string' ? id : String(id)));
    let selectedIndices = orderedIdsStr.map(id => images.findIndex(img => String(img.id) === String(id)));
    if (selectedIndices.some(idx => idx < 0 || idx >= images.length)) {
      throw new Error('[SEQUENCE-PLANNING] Invalid id mapping from model output; aborting (no upload-order fallback).');
    }
    // Build plan compatible with renderer/motion pipeline
    const plan = {
      theme: raw.theme || '',
      emotion_arc: raw.emotion_arc || [],
      ordered_ids: orderedIdsStr,
      shots,
      // Rendering contract: selected = indices into uploaded array, order = indices into selected
      selected: selectedIndices,
      order: Array.from({ length: orderedIdsStr.length }, (_, i) => i),
      durations: Array.from({ length: orderedIdsStr.length }, () => 3.8),
      transitions: Array.from({ length: Math.max(0, orderedIdsStr.length - 1) }, () => 'crossfade'),
      usedPlanner: 'ai'
    };
    
    // Validate against the full uploaded set (must cover all images)
    validateSequencePlan(plan, images.length, images);
    
    console.log(`[SEQUENCE-PLANNING] Created plan: ${plan.ordered_ids.length} images, ${plan.shots.length} shots (target=${targetCount})`);
    console.log(`[SEQUENCE-PLANNING] ordered_ids: [${plan.ordered_ids.join(', ')}]`);
    
    if (progressReporter) {
      progressReporter.report('sequence-planning', 70, 'Sequence planning complete');
    }
    
    return plan;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Sequence planning timed out after 30s');
    }
    
    // Check for malformed request body errors
    if (error.status === 400 && error.message && (
      error.message.includes('Unrecognized request argument') ||
      error.message.includes('unexpected field') ||
      error.message.includes('Invalid request')
    )) {
      console.error('[SEQUENCE-PLANNING] Server bug: Invalid OpenAI request payload');
      console.error('[SEQUENCE-PLANNING] Error details:', error.message);
      throw new Error('Server bug: invalid OpenAI request payload (unexpected field). Check server logs.');
    }
    
    console.error('[SEQUENCE-PLANNING] Error:', error);
    throw error;
  }
}

/**
 * Validate sequence plan
 * @param {Object} plan - Sequence plan object
 * @param {number} expectedCount - Target number of images (all uploaded)
 * @param {Array} images - image list for validation
 */
function validateSequencePlan(plan, expectedCount, images) {
  if (!plan.ordered_ids || !Array.isArray(plan.ordered_ids)) {
    throw new Error('Sequence plan missing ordered_ids array');
  }
  
  if (plan.ordered_ids.length !== expectedCount) {
    throw new Error(`Sequence plan includes ${plan.ordered_ids.length} images, expected ${expectedCount}.`);
  }
  
  const allowed = new Set(images.map(img => String(img.id)));
  const uniqueIds = new Set(plan.ordered_ids.map(String));
  if (uniqueIds.size !== expectedCount) {
    throw new Error('Sequence plan has duplicate IDs');
  }
  for (const id of uniqueIds) {
    if (!allowed.has(String(id))) {
      throw new Error(`Invalid id in ordered_ids: ${id}`);
    }
  }
  
  if (!plan.shots || !Array.isArray(plan.shots)) {
    throw new Error('Sequence plan missing shots array');
  }
  if (plan.shots.length !== expectedCount) {
    throw new Error(`shots length (${plan.shots.length}) != ordered_ids length (${expectedCount})`);
  }
  for (let i = 0; i < expectedCount; i++) {
    if (!plan.shots[i] || String(plan.shots[i].id) !== String(plan.ordered_ids[i])) {
      throw new Error(`Shot id mismatch at index ${i}`);
    }
  }
  
  if (!Array.isArray(plan.selected) || plan.selected.length !== expectedCount) {
    throw new Error('Plan selected must align to expectedCount');
  }
  if (!Array.isArray(plan.order) || plan.order.length !== expectedCount) {
    throw new Error('Plan order must align to expectedCount');
  }
  
  console.log(`[SEQUENCE-PLANNING] Validation passed: ${expectedCount} images, ${plan.shots.length} shots`);
}

/**
 * Repair sequence plan when shots.length !== ordered_ids.length
 * @param {OpenAI} openai - OpenAI client
 * @param {Object} plan - Original plan with mismatch
 * @param {number} totalImages - Total number of images
 * @param {Array} analysisSummary - Analysis summary for context
 * @param {string} promptText - User's prompt
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<Object>} Repaired plan
 */
async function repairSequencePlan(openai, plan, totalImages, analysisSummary, promptText, signal) {
  const currentShotsLength = plan.shots?.length || 0;
  const orderedIdsLength = plan.ordered_ids?.length || 0;
  
  console.log(`[SEQUENCE-PLANNING] Repairing: shots.length=${currentShotsLength}, ordered_ids.length=${orderedIdsLength}`);
  
  try {
    const repairResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: `You returned ${currentShotsLength} shots but need ${orderedIdsLength}. Return corrected JSON with shots length exactly ${orderedIdsLength}, keeping the same ordering as ordered_ids.

Each shot must have: {id, purpose, target_emotion, motion_hint} where shots[i].id === ordered_ids[i].`
      }, {
        role: 'user',
        content: `Fix the shots array. Current ordered_ids: [${plan.ordered_ids.join(', ')}]. Current shots: ${JSON.stringify(plan.shots || [])}. Return corrected plan with shots.length === ${orderedIdsLength}.`
      }],
      temperature: 0.2,
      max_tokens: 3000,
      signal
    });
    
    const repairContent = repairResponse.choices[0].message.content.trim();
    const repairJson = repairContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const repairedPlan = JSON.parse(repairJson);
    
    // Merge repaired shots into original plan
    if (repairedPlan.shots && Array.isArray(repairedPlan.shots)) {
      plan.shots = repairedPlan.shots;
      console.log(`[SEQUENCE-PLANNING] Repair successful: shots.length now ${plan.shots.length}`);
    } else {
      throw new Error('Repair response did not include valid shots array');
    }
  } catch (repairError) {
    console.warn(`[SEQUENCE-PLANNING] Repair failed, using deterministic fallback:`, repairError.message);
    // Generate missing shots deterministically
    plan.shots = generateDeterministicShots(plan.ordered_ids, analysisSummary);
  }
  
  return plan;
}

function isValidSelection(selectedOrderedIds, images, targetCount) {
  if (!Array.isArray(selectedOrderedIds)) return false;
  if (selectedOrderedIds.length !== targetCount) return false;
  const allowed = new Set(images.map(img => String(img.id)));
  const uniq = new Set();
  for (const id of selectedOrderedIds) {
    const s = String(id);
    if (!allowed.has(s)) return false;
    uniq.add(s);
  }
  return uniq.size === targetCount;
}

function deterministicFallback(images, targetCount) {
  // Use upload order to ensure no drops
  return images.map(img => String(img.id));
}

function buildShots(finalIds, beats) {
  const roleMap = new Map();
  if (Array.isArray(beats)) {
    for (const beat of beats) {
      if (beat && beat.id) {
        roleMap.set(String(beat.id), beat.role || 'build');
      }
    }
  }
  const rolesSeq = ['opening', 'build', 'turn', 'climax', 'resolution'];
  return finalIds.map((id, idx) => {
    const role = roleMap.get(String(id)) || rolesSeq[Math.min(idx, rolesSeq.length - 1)] || 'build';
    return {
      id: String(id),
      purpose: role,
      target_emotion: { primary: 'calm', secondary: '' },
      motion_hint: role === 'opening' || role === 'resolution' ? 'hold' : 'slow_push_in'
    };
  });
}

/**
 * Generate deterministic shots as fallback when repair fails
 * @param {Array<number>} orderedIds - Ordered image IDs
 * @param {Array} analysisSummary - Analysis summary for context
 * @returns {Array} Generated shots array
 */
function generateDeterministicShots(orderedIds, analysisSummary) {
  const shots = [];
  
  for (let i = 0; i < orderedIds.length; i++) {
    const imageId = orderedIds[i];
    const analysis = analysisSummary[imageId] || {};
    const subject = analysis.subject || 'unknown';
    const composition = analysis.composition || 'medium';
    
    // Deterministic motion rules based on subject/composition
    let motionHint = 'slow_push_in';
    let purpose = 'build';
    let targetEmotion = { primary: 'calm', secondary: '' };
    
    if (subject.includes('person') || subject.includes('portrait')) {
      motionHint = 'slow_push_in'; // 2-4%
      purpose = i < orderedIds.length * 0.3 ? 'establish' : 'build';
    } else if (subject.includes('architecture') || subject.includes('building')) {
      motionHint = 'slow_push_in'; // 1-3%, no lateral
      purpose = i < orderedIds.length * 0.2 ? 'establish' : 'build';
    } else if (subject.includes('street') || subject.includes('road')) {
      motionHint = 'gentle_pan'; // 1-3% following leading lines
      purpose = 'build';
    } else if (subject.includes('text') || subject.includes('sign')) {
      motionHint = 'hold'; // hold + micro push-in, avoid pan
      purpose = 'establish';
    }
    
    // Adjust purpose based on position
    const position = i / orderedIds.length;
    if (position < 0.15) {
      purpose = 'establish';
      targetEmotion = { primary: 'calm', secondary: 'awe' };
    } else if (position < 0.7) {
      purpose = 'build';
      targetEmotion = { primary: 'curiosity', secondary: 'mystery' };
    } else if (position < 0.9) {
      purpose = 'climax';
      targetEmotion = { primary: 'tension', secondary: 'awe' };
    } else {
      purpose = 'resolve';
      targetEmotion = { primary: 'calm', secondary: 'closure' };
    }
    
    shots.push({
      id: imageId,
      purpose,
      target_emotion: targetEmotion,
      motion_hint: motionHint
    });
  }
  
  console.log(`[SEQUENCE-PLANNING] Generated ${shots.length} deterministic shots as fallback`);
  return shots;
}

