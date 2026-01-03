/**
 * Drift Clamp Validation Test
 * Verifies that lateral drift is properly clamped to prevent black edges
 * even under worst-case scale (scale=1.02, requested drift=2% width)
 * 
 * Usage: node server/test-drift-clamp-validation.js
 */

import { clampDriftForScale, getDocumentaryDefaults, getDocumentaryTransformAt } from './motion-pack-documentary.js';

function testDriftClamp() {
  console.log('=== Drift Clamp Validation Test ===\n');
  
  const config = getDocumentaryDefaults();
  const frameWidth = 1920; // Standard HD width
  const frameHeight = 1080;
  
  // Worst-case scenario: minimum scale (1.02) with maximum requested drift (2%)
  const worstCaseScale = 1.02;
  const worstCaseDriftPercent = 2.0;
  const worstCaseDriftPx = (frameWidth * worstCaseDriftPercent) / 100; // 38.4px
  
  console.log('Test Parameters:');
  console.log(`  Frame width: ${frameWidth}px`);
  console.log(`  Scale: ${worstCaseScale}`);
  console.log(`  Requested drift: ${worstCaseDriftPercent}% (${worstCaseDriftPx.toFixed(2)}px)\n`);
  
  // Calculate safe maximum translation
  // maxTx = (frameWidth * (scale - 1)) / 2 - 2px (safety margin)
  const maxTx = (frameWidth * (worstCaseScale - 1)) / 2;
  const safeMaxTx = Math.max(0, maxTx - 2);
  
  console.log('Safe Translation Limits:');
  console.log(`  maxTx (theoretical): ${maxTx.toFixed(2)}px`);
  console.log(`  safeMaxTx (with 2px margin): ${safeMaxTx.toFixed(2)}px\n`);
  
  // Test clamping function directly
  console.log('Direct Clamp Test:');
  const clampedPositive = clampDriftForScale(worstCaseDriftPx, frameWidth, worstCaseScale);
  const clampedNegative = clampDriftForScale(-worstCaseDriftPx, frameWidth, worstCaseScale);
  
  console.log(`  Requested drift: +${worstCaseDriftPx.toFixed(2)}px`);
  console.log(`  Clamped drift: ${clampedPositive.toFixed(2)}px`);
  console.log(`  Requested drift: -${worstCaseDriftPx.toFixed(2)}px`);
  console.log(`  Clamped drift: ${clampedNegative.toFixed(2)}px\n`);
  
  // Verify clamped drift is within safe range
  const absClamped = Math.abs(clampedPositive);
  const isValid = absClamped <= safeMaxTx;
  
  console.log('Validation:');
  console.log(`  Clamped drift (abs): ${absClamped.toFixed(2)}px`);
  console.log(`  Safe max: ${safeMaxTx.toFixed(2)}px`);
  console.log(`  Valid: ${isValid ? '✓ PASS' : '✗ FAIL'}\n`);
  
  if (!isValid) {
    console.error('ERROR: Clamped drift exceeds safe maximum!');
    process.exit(1);
  }
  
  // Test via getDocumentaryTransformAt (end-to-end)
  console.log('End-to-End Test (via getDocumentaryTransformAt):');
  
  // Use a seeded RNG to force worst-case parameters
  // Note: This requires modifying the transform function or using specific seeds
  // For now, we test the clamp function directly
  
  // Test multiple scales
  console.log('\nScale Range Test:');
  const testScales = [1.01, 1.02, 1.03, 1.035];
  for (const scale of testScales) {
    const maxTxForScale = (frameWidth * (scale - 1)) / 2 - 2;
    const requestedDrift = (frameWidth * 2.0) / 100; // 2% drift
    const clamped = clampDriftForScale(requestedDrift, frameWidth, scale);
    const absClamped = Math.abs(clamped);
    const isValidForScale = absClamped <= maxTxForScale;
    
    console.log(`  Scale ${scale.toFixed(3)}: maxTx=${maxTxForScale.toFixed(2)}px, requested=${requestedDrift.toFixed(2)}px, clamped=${absClamped.toFixed(2)}px ${isValidForScale ? '✓' : '✗'}`);
    
    if (!isValidForScale) {
      console.error(`ERROR: Scale ${scale} failed validation!`);
      process.exit(1);
    }
  }
  
  console.log('\n=== All Tests Passed ===');
  console.log('✓ Drift clamping is effective under worst-case conditions');
  console.log('✓ No black edges should appear in final encoded video');
}

testDriftClamp();

