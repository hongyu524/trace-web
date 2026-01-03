/**
 * Test harness for Documentary Motion Pack
 * Run with: node server/test-documentary-pack.js
 */

import * as documentaryPack from './motion-pack-documentary.js';

function runTests() {
  console.log('=== Documentary Motion Pack Tests ===\n');

  // Test 1: Default configuration
  console.log('Test 1: Default configuration');
  const defaults = documentaryPack.getDocumentaryDefaults();
  console.log('Defaults:', JSON.stringify(defaults, null, 2));
  console.log('✓ Defaults loaded\n');

  // Test 2: Pick presets for 20 shots
  console.log('Test 2: Pick presets for 20 shots (check distribution)');
  const presets = [];
  let previousPreset = null;
  let previousPreviousPreset = null;

  for (let i = 0; i < 20; i++) {
    const shotMeta = {
      position: i / 19,
      index: i,
      totalShots: 20,
      frameWidth: 1920,
      frameHeight: 1080,
      previousPreset,
      previousPreviousPreset,
    };
    const seed = 12345 + i * 7919;
    const rng = new documentaryPack.SeededRNG(seed);
    const preset = documentaryPack.pickDocumentaryPreset(shotMeta, rng, defaults);
    presets.push(preset);
    previousPreviousPreset = previousPreset;
    previousPreset = preset;
  }

  // Count distribution
  const counts = {};
  presets.forEach(p => {
    counts[p] = (counts[p] || 0) + 1;
  });
  console.log('Presets:', presets);
  console.log('Distribution:', counts);
  const staticCount = counts['STATIC'] || 0;
  const staticPercent = ((staticCount / 20) * 100).toFixed(1);
  console.log(`Static shots: ${staticCount}/20 (${staticPercent}%)`);
  console.log(`Expected: 40-50% static (8-10 shots)`);
  console.log(staticPercent >= 40 && staticPercent <= 50 ? '✓ Distribution OK\n' : '⚠ Distribution outside expected range\n');

  // Test 3: Transform at t=0 and t=1 for each preset
  console.log('Test 3: Transform parameters (t=0 and t=1)');
  const testPresets = ['STATIC', 'SLOW_PUSH_IN', 'SLOW_PULL_BACK', 'LATERAL_DRIFT_L', 'LATERAL_DRIFT_R'];
  testPresets.forEach(preset => {
    const t0 = documentaryPack.getDocumentaryTransformAt(0, preset, {
      frameWidth: 1920,
      frameHeight: 1080,
      seed: 12345,
      config: defaults,
    });
    const t1 = documentaryPack.getDocumentaryTransformAt(1, preset, {
      frameWidth: 1920,
      frameHeight: 1080,
      seed: 12345,
      config: defaults,
    });
    console.log(`${preset}:`);
    console.log(`  t=0: scale=${t0.scale.toFixed(3)}, x=${t0.translateX.toFixed(1)}, y=${t0.translateY.toFixed(1)}, rot=${t0.rotateDeg}`);
    console.log(`  t=1: scale=${t1.scale.toFixed(3)}, x=${t1.translateX.toFixed(1)}, y=${t1.translateY.toFixed(1)}, rot=${t1.rotateDeg}`);
  });
  console.log('✓ Transforms calculated\n');

  // Test 4: Clamps and safety checks
  console.log('Test 4: Clamps and safety checks');
  let allPassed = true;

  // Check rotateDeg is always 0
  testPresets.forEach(preset => {
    const t0 = documentaryPack.getDocumentaryTransformAt(0, preset, {
      frameWidth: 1920,
      frameHeight: 1080,
      seed: 12345,
      config: defaults,
    });
    if (t0.rotateDeg !== 0) {
      console.log(`✗ ${preset}: rotateDeg should be 0, got ${t0.rotateDeg}`);
      allPassed = false;
    }
  });
  console.log('✓ rotateDeg always 0');

  // Check scale is within bounds
  testPresets.forEach(preset => {
    for (let t = 0; t <= 1; t += 0.1) {
      const transform = documentaryPack.getDocumentaryTransformAt(t, preset, {
        frameWidth: 1920,
        frameHeight: 1080,
        seed: 12345,
        config: defaults,
      });
      if (transform.scale < 1.0 || transform.scale > 1.035) {
        console.log(`✗ ${preset} t=${t}: scale=${transform.scale.toFixed(3)} out of bounds [1.0, 1.035]`);
        allPassed = false;
      }
    }
  });
  console.log('✓ Scale within [1.0, 1.035]');

  // Check translateY is 0 for lateral drift
  ['LATERAL_DRIFT_L', 'LATERAL_DRIFT_R'].forEach(preset => {
    for (let t = 0; t <= 1; t += 0.1) {
      const transform = documentaryPack.getDocumentaryTransformAt(t, preset, {
        frameWidth: 1920,
        frameHeight: 1080,
        seed: 12345,
        config: defaults,
      });
      if (transform.translateY !== 0) {
        console.log(`✗ ${preset} t=${t}: translateY should be 0, got ${transform.translateY}`);
        allPassed = false;
      }
    }
  });
  console.log('✓ translateY = 0 for lateral drift');

  // Check drift pixels don't exceed 2% of frame width
  ['LATERAL_DRIFT_L', 'LATERAL_DRIFT_R'].forEach(preset => {
    const transform = documentaryPack.getDocumentaryTransformAt(1, preset, {
      frameWidth: 1920,
      frameHeight: 1080,
      seed: 12345,
      config: defaults,
    });
    const driftPx = Math.abs(transform.translateX);
    const maxDriftPx = (1920 * 2.0) / 100; // 2% of width
    if (driftPx > maxDriftPx) {
      console.log(`✗ ${preset}: driftPx=${driftPx.toFixed(1)} exceeds max ${maxDriftPx.toFixed(1)}`);
      allPassed = false;
    }
  });
  console.log('✓ Drift pixels within 2% of frame width');

  console.log(allPassed ? '✓ All safety checks passed\n' : '✗ Some safety checks failed\n');

  // Test 5: Conversion to motion params
  console.log('Test 5: Convert to motion parameters');
  testPresets.forEach(preset => {
    const params = documentaryPack.convertDocumentaryPresetToMotionParams(
      preset,
      1920,
      1080,
      12345,
      defaults
    );
    console.log(`${preset}: zoomStart=${params.zoomStart.toFixed(3)}, zoomEnd=${params.zoomEnd.toFixed(3)}, panX=${params.panXPercent.toFixed(2)}%, panAxis=${params.panAxis}`);
  });
  console.log('✓ Conversion successful\n');

  console.log('=== All Tests Complete ===');
}

runTests();

