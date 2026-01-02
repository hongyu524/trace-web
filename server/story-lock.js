export function createStoryLock(analysisResults, sequencePlan, promptText = '') {
  const total = Array.isArray(sequencePlan?.ordered_ids) ? sequencePlan.ordered_ids.length : 0;
  const theme = sequencePlan?.theme || promptText || '';

  const story_arc = ['arrival', 'observation', 'distance', 'peak', 'release'];

  const ordered = Array.isArray(sequencePlan?.ordered_ids) ? sequencePlan.ordered_ids : [];
  const shots = Array.isArray(sequencePlan?.shots) ? sequencePlan.shots : [];

  const byId = (id) => {
    const a = analysisResults?.[id];
    return {
      id,
      filename: a?.filename,
      subject: a?.subject,
      mood: Array.isArray(a?.mood) ? a.mood : [],
      emotion_vector: (a && typeof a.emotion_vector === 'object' && a.emotion_vector) ? a.emotion_vector : { calm: 0.5, tension: 0.3, mystery: 0.2, intimacy: 0.3, awe: 0.2 },
      light: (a && typeof a.light === 'object' && a.light) ? a.light : { key: 'mid-key', contrast: 'medium', directionality: 'ambient' },
      visual_energy: Number.isFinite(a?.visual_energy) ? a.visual_energy : 5
    };
  };

  const candidates = ordered.map((id, idx) => {
    const s = shots[idx] || {};
    const a = byId(id);
    return {
      id,
      idx,
      purpose: s.purpose || 'build',
      visual_energy: a.visual_energy,
      subject: a.subject || 'unknown',
      mood: a.mood
    };
  });

  const purposeToBeat = (purpose, idx) => {
    const p = total > 1 ? idx / (total - 1) : 0.5;
    if (purpose === 'climax') return 'peak';
    if (purpose === 'establish') return 'arrival';
    if (purpose === 'resolve') return 'release';
    if (purpose === 'contrast' || purpose === 'isolate') return 'distance';
    if (purpose === 'observe') return 'observation';
    if (p < 0.18) return 'arrival';
    if (p < 0.45) return 'observation';
    if (p < 0.72) return 'distance';
    if (p < 0.90) return 'peak';
    return 'release';
  };

  const beat_of = {};
  for (const c of candidates) {
    beat_of[String(c.id)] = purposeToBeat(c.purpose, c.idx);
  }

  const overlapCount = (a, b) => {
    const sa = new Set(Array.isArray(a) ? a : []);
    let count = 0;
    for (const v of (Array.isArray(b) ? b : [])) {
      if (sa.has(v)) count += 1;
    }
    return count;
  };

  const cluster_of = {};
  const clusters = [];
  let currentCluster = [];
  let clusterId = 0;
  const flushCluster = () => {
    if (currentCluster.length > 0) {
      clusters.push({ id: clusterId, ids: currentCluster.map(x => x.id) });
      for (const x of currentCluster) cluster_of[String(x.id)] = clusterId;
      clusterId += 1;
      currentCluster = [];
    }
  };

  for (let i = 0; i < candidates.length; i++) {
    const cur = candidates[i];
    const prev = currentCluster.length > 0 ? currentCluster[currentCluster.length - 1] : null;
    let startNew = false;
    if (currentCluster.length >= 3) startNew = true;
    if (prev) {
      const beatChange = beat_of[String(prev.id)] !== beat_of[String(cur.id)];
      const subjectMatch = prev.subject && cur.subject && prev.subject === cur.subject;
      const moodOverlap = overlapCount(prev.mood, cur.mood);
      const similar = subjectMatch || moodOverlap > 0;
      if (beatChange) startNew = true;
      if (!similar && currentCluster.length >= 2) startNew = true;
    }
    if (startNew) flushCluster();
    currentCluster.push(cur);
  }
  flushCluster();

  const climax = candidates.find(c => c.purpose === 'climax');
  const hero_images = [];
  if (climax) hero_images.push(climax.id);

  const bestOther = candidates
    .filter(c => !hero_images.includes(c.id))
    .sort((a, b) => (b.visual_energy - a.visual_energy))
    .slice(0, Math.min(1, Math.max(0, total >= 6 ? 1 : 0)));

  for (const c of bestOther) hero_images.push(c.id);

  const heroSet = new Set(hero_images);
  const supporting_images = ordered.filter(id => !heroSet.has(id));

  const desiredCount = (() => {
    if (total <= 9) return total;
    if (total >= 13) return 9;
    return 8;
  })();

  const keepSet = new Set();
  if (desiredCount >= total) {
    for (const id of ordered) keepSet.add(id);
  } else {
    const byBeat = {};
    for (const b of story_arc) byBeat[b] = [];
    for (const c of candidates) {
      const beat = beat_of[String(c.id)] || 'observation';
      if (!byBeat[beat]) byBeat[beat] = [];
      byBeat[beat].push(c);
    }

    for (const b of story_arc) {
      const pick = (byBeat[b] || []).slice().sort((a, b2) => b2.visual_energy - a.visual_energy)[0];
      if (pick) keepSet.add(pick.id);
    }
    for (const id of hero_images) keepSet.add(id);

    const beatWeight = { arrival: 0.2, observation: 0.1, distance: 0.6, peak: 1.2, release: 0.4 };
    const keptByCluster = {};

    const scoreOf = (c) => {
      const beat = beat_of[String(c.id)] || 'observation';
      const w = Number.isFinite(beatWeight[beat]) ? beatWeight[beat] : 0;
      const hero = heroSet.has(c.id) ? 1.0 : 0.0;
      const cid = cluster_of[String(c.id)];
      const already = keptByCluster[String(cid)] || 0;
      const clusterPenalty = already >= 3 ? -10 : 0;
      const clusterBonus = already === 0 ? 0.3 : 0;
      return (c.visual_energy / 10) + w + hero + clusterBonus + clusterPenalty;
    };

    for (const id of keepSet) {
      const cid = cluster_of[String(id)];
      keptByCluster[String(cid)] = (keptByCluster[String(cid)] || 0) + 1;
    }

    const remaining = candidates
      .filter(c => !keepSet.has(c.id))
      .sort((a, b) => scoreOf(b) - scoreOf(a));

    for (const c of remaining) {
      if (keepSet.size >= desiredCount) break;
      const cid = cluster_of[String(c.id)];
      const already = keptByCluster[String(cid)] || 0;
      if (already >= 3) continue;
      keepSet.add(c.id);
      keptByCluster[String(cid)] = already + 1;
    }
  }

  const drop_ids = ordered.filter(id => !keepSet.has(id));
  const final_order = ordered.filter(id => keepSet.has(id));
  const final_shots = [];
  for (let i = 0; i < ordered.length; i++) {
    const id = ordered[i];
    if (keepSet.has(id)) final_shots.push(shots[i] || { id, purpose: 'build' });
  }

  const hinge_id = (() => {
    if (final_order.length < 3) return null;
    const firstId = final_order[0];
    const lastId = final_order[final_order.length - 1];
    let best = null;
    for (let i = 0; i < final_order.length; i++) {
      const id = final_order[i];
      if (id === firstId || id === lastId) continue;
      const c = candidates.find(x => x.id === id);
      const a = byId(id);
      const beat = beat_of[String(id)] || 'observation';
      if (beat !== 'distance' && beat !== 'peak') continue;
      const ev = a.emotion_vector || {};
      const tension = Number.isFinite(ev.tension) ? ev.tension : 0;
      const mystery = Number.isFinite(ev.mystery) ? ev.mystery : 0;
      const awe = Number.isFinite(ev.awe) ? ev.awe : 0;
      const energy = Number.isFinite(c?.visual_energy) ? c.visual_energy : 5;
      const score = energy + (tension * 6) + (mystery * 4) + (awe * 2);
      if (!best || score > best.score) best = { id, score };
    }
    return best ? best.id : null;
  })();

  const dissolve_cluster_id = (() => {
    if (!Array.isArray(clusters) || clusters.length === 0) return null;
    const posOf = (id) => final_order.indexOf(id);
    let best = null;
    for (const cl of clusters) {
      const keptIds = (cl.ids || []).filter(id => keepSet.has(id));
      if (keptIds.length < 2) continue;
      const positions = keptIds.map(posOf).filter(p => p >= 0).sort((a, b) => a - b);
      if (positions.length < 2) continue;
      const minPos = positions[0];
      const maxPos = positions[positions.length - 1];
      if (minPos <= 0) continue;
      if (maxPos >= final_order.length - 2) continue;

      let overlap = 0;
      for (let i = 0; i < keptIds.length - 1; i++) {
        const a = candidates.find(x => x.id === keptIds[i]);
        const b = candidates.find(x => x.id === keptIds[i + 1]);
        overlap += overlapCount(a?.mood, b?.mood);
      }
      const sizeBonus = keptIds.length === 2 ? 2 : 0;
      const score = sizeBonus + overlap;
      if (!best || score > best.score) best = { id: cl.id, score };
    }
    return best ? best.id : null;
  })();

  const why_each_image_is_here = {};
  for (let i = 0; i < ordered.length; i++) {
    const id = ordered[i];
    const a = byId(id);
    const s = shots[i] || {};
    const purpose = s.purpose || 'build';
    const hero = heroSet.has(id);
    why_each_image_is_here[String(id)] = {
      purpose,
      hero,
      beat: beat_of[String(id)] || 'observation',
      clusterId: cluster_of[String(id)],
      keep: keepSet.has(id),
      subject: a.subject || 'unknown',
      mood: a.mood,
      reason: hero ? `hero_${purpose}` : purpose
    };
  }

  return {
    theme,
    story_arc,
    hero_images,
    supporting_images,
    desired_count: desiredCount,
    drop_ids,
    hinge_id,
    dissolve_cluster_id,
    final_order,
    final_shots,
    cluster_of,
    clusters,
    beat_of,
    why_each_image_is_here
  };
}
