/**
 * Validation test for Auto-Reframe system
 * Tests crop coordinates for rotated images (EXIF 6/8)
 * Run with: node server/test-auto-reframe-validation.js <image-path>
 */

import * as autoReframe from './auto-reframe.js';
import { promises as fsp } from 'fs';
import sharp from 'sharp';

async function testRotatedImage(imagePath) {
  console.log('=== Auto-Reframe Crop Coordinate Validation ===\n');
  console.log(`Image: ${imagePath}\n`);

  try {
    // Read image buffer
    const imageBuffer = await fsp.readFile(imagePath);
    
    // Get metadata
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    const { width, height, orientation } = metadata;
    
    console.log('Original metadata:');
    console.log(`  Width: ${width}`);
    console.log(`  Height: ${height}`);
    console.log(`  EXIF Orientation: ${orientation || 'none (1)'}`);
    
    // Determine expected rotated dimensions
    let rotatedWidth = width;
    let rotatedHeight = height;
    let expectedRotationDeg = 0;
    if (orientation) {
      switch (orientation) {
        case 6:
          expectedRotationDeg = 90;
          rotatedWidth = height;
          rotatedHeight = width;
          break;
        case 8:
          expectedRotationDeg = 270;
          rotatedWidth = height;
          rotatedHeight = width;
          break;
        case 3:
          expectedRotationDeg = 180;
          break;
        default:
          expectedRotationDeg = 0;
      }
    }
    
    console.log('\nExpected after rotation:');
    console.log(`  Rotation: ${expectedRotationDeg}°`);
    console.log(`  Rotated Width: ${rotatedWidth}`);
    console.log(`  Rotated Height: ${rotatedHeight}`);
    
    // Test with 16:9 aspect ratio
    const targetAspect = 16 / 9;
    console.log(`\nTarget aspect ratio: ${targetAspect.toFixed(4)} (16:9)\n`);
    
    // Create frame plan
    const plan = await autoReframe.createFramePlan(imageBuffer, targetAspect, {
      imageKey: 'test-image',
      confidenceThreshold: 0.55,
      headroomBias: 0.075,
    });
    
    console.log('Frame Plan:');
    console.log(`  Rotation: ${plan.rotationDeg}°`);
    console.log(`  Crop: x=${plan.crop.x}, y=${plan.crop.y}, w=${plan.crop.w}, h=${plan.crop.h}`);
    console.log(`  Anchor: (${plan.anchor.x.toFixed(3)}, ${plan.anchor.y.toFixed(3)})`);
    console.log(`  Confidence: ${plan.confidence.toFixed(3)}`);
    console.log(`  Reason: ${plan.reason}`);
    
    // Validate crop coordinates
    console.log('\n=== Validation ===');
    
    // Assert 1: Rotation matches EXIF
    if (plan.rotationDeg !== expectedRotationDeg) {
      console.error(`✗ Rotation mismatch: expected ${expectedRotationDeg}°, got ${plan.rotationDeg}°`);
      process.exit(1);
    } else {
      console.log(`✓ Rotation matches EXIF: ${plan.rotationDeg}°`);
    }
    
    // Assert 2: Crop bounds
    const boundsOk = 
      plan.crop.x >= 0 &&
      plan.crop.y >= 0 &&
      plan.crop.x + plan.crop.w <= rotatedWidth &&
      plan.crop.y + plan.crop.h <= rotatedHeight;
    
    if (!boundsOk) {
      console.error(`✗ Crop bounds invalid:`);
      console.error(`  crop.x (${plan.crop.x}) must be >= 0`);
      console.error(`  crop.y (${plan.crop.y}) must be >= 0`);
      console.error(`  crop.x + crop.w (${plan.crop.x + plan.crop.w}) must be <= rotatedWidth (${rotatedWidth})`);
      console.error(`  crop.y + crop.h (${plan.crop.y + plan.crop.h}) must be <= rotatedHeight (${rotatedHeight})`);
      process.exit(1);
    } else {
      console.log(`✓ Crop bounds valid: [${plan.crop.x}, ${plan.crop.y}, ${plan.crop.w}, ${plan.crop.h}] within [${rotatedWidth}x${rotatedHeight}]`);
    }
    
    // Assert 3: Aspect ratio
    const cropAspect = plan.crop.w / plan.crop.h;
    const aspectDiff = Math.abs(cropAspect - targetAspect);
    const tolerance = 0.02;
    
    if (aspectDiff > tolerance) {
      console.error(`✗ Aspect ratio mismatch:`);
      console.error(`  crop aspect: ${cropAspect.toFixed(4)}`);
      console.error(`  target aspect: ${targetAspect.toFixed(4)}`);
      console.error(`  difference: ${aspectDiff.toFixed(4)} (tolerance: ${tolerance})`);
      process.exit(1);
    } else {
      console.log(`✓ Aspect ratio matches: ${cropAspect.toFixed(4)} (target: ${targetAspect.toFixed(4)}, diff: ${aspectDiff.toFixed(4)})`);
    }
    
    // Use validation function
    const validation = autoReframe.validateCropRect(plan.crop, rotatedWidth, rotatedHeight, targetAspect);
    if (!validation.valid) {
      console.error(`✗ Validation function found errors:`);
      validation.errors.forEach(err => console.error(`  - ${err}`));
      process.exit(1);
    } else {
      console.log(`✓ Validation function passed`);
    }
    
    // Apply frame plan and verify output
    console.log('\n=== Applying Frame Plan ===');
    const reframedBuffer = await autoReframe.applyFramePlan(imageBuffer, plan);
    const reframedMetadata = await sharp(reframedBuffer).metadata();
    console.log(`Reframed image: ${reframedMetadata.width}x${reframedMetadata.height}`);
    
    const reframedAspect = reframedMetadata.width / reframedMetadata.height;
    if (Math.abs(reframedAspect - targetAspect) > tolerance) {
      console.error(`✗ Reframed aspect ratio (${reframedAspect.toFixed(4)}) doesn't match target (${targetAspect.toFixed(4)})`);
      process.exit(1);
    } else {
      console.log(`✓ Reframed aspect ratio matches: ${reframedAspect.toFixed(4)}`);
    }
    
    console.log('\n=== All Validations Passed ===');
    
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: node server/test-auto-reframe-validation.js <image-path>');
  console.error('Example: node server/test-auto-reframe-validation.js test-images/portrait_rotated.jpg');
  process.exit(1);
}

testRotatedImage(imagePath);

