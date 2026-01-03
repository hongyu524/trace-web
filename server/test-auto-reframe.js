/**
 * Test harness for Auto-Reframe system
 * Run with: node server/test-auto-reframe.js <folder-path>
 * Outputs debug crops to <folder-path>/reframed/
 */

import * as autoReframe from './auto-reframe.js';
import { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest(folderPath) {
  if (!folderPath) {
    console.error('Usage: node server/test-auto-reframe.js <folder-path>');
    console.error('Example: node server/test-auto-reframe.js ./test-images');
    process.exit(1);
  }

  console.log('=== Auto-Reframe Test ===\n');
  console.log(`Input folder: ${folderPath}\n`);

  try {
    // Read all image files from folder
    const files = await fsp.readdir(folderPath);
    const imageFiles = files.filter(f => 
      /\.(jpg|jpeg|png|webp)$/i.test(f)
    ).map(f => path.join(folderPath, f));

    if (imageFiles.length === 0) {
      console.error('No image files found in folder');
      process.exit(1);
    }

    console.log(`Found ${imageFiles.length} images\n`);

    // Create output directory
    const outputDir = path.join(folderPath, 'reframed');
    await fsp.mkdir(outputDir, { recursive: true });

    // Test with different aspect ratios
    const aspectRatios = [
      { name: '16:9', value: 16 / 9 },
      { name: '1:1', value: 1.0 },
      { name: '9:16', value: 9 / 16 },
    ];

    const allPlans = [];
    const confidenceStats = {
      total: 0,
      high: 0, // >= 0.7
      medium: 0, // 0.4 - 0.7
      low: 0, // < 0.4
      needsReview: 0,
    };

    // Process each aspect ratio
    for (const { name, value } of aspectRatios) {
      console.log(`\n=== Testing aspect ratio: ${name} (${value.toFixed(3)}) ===\n`);
      
      const aspectDir = path.join(outputDir, name.replace(':', '-'));
      await fsp.mkdir(aspectDir, { recursive: true });

      for (let i = 0; i < imageFiles.length; i++) {
        const imagePath = imageFiles[i];
        const fileName = path.basename(imagePath);
        const baseName = path.parse(fileName).name;
        const ext = path.parse(fileName).ext;

        try {
          console.log(`[${i + 1}/${imageFiles.length}] ${fileName}`);

          // Read image buffer
          const imageBuffer = await fsp.readFile(imagePath);

          // Create frame plan
          const plan = await autoReframe.createFramePlan(imageBuffer, value, {
            confidenceThreshold: 0.55,
            headroomBias: 0.075,
          });

          allPlans.push({ fileName, aspectRatio: name, plan });

          // Track confidence stats
          confidenceStats.total++;
          if (plan.confidence >= 0.7) {
            confidenceStats.high++;
          } else if (plan.confidence >= 0.4) {
            confidenceStats.medium++;
          } else {
            confidenceStats.low++;
          }
          if (plan.needsReview) {
            confidenceStats.needsReview++;
          }

          // Apply frame plan
          const reframedBuffer = await autoReframe.applyFramePlan(imageBuffer, plan);

          // Save reframed image
          const outputPath = path.join(aspectDir, `${baseName}_reframed${ext}`);
          await fsp.writeFile(outputPath, reframedBuffer);

          console.log(`  Rotation: ${plan.rotationDeg}°`);
          console.log(`  Crop: ${plan.crop.w}x${plan.crop.h} at (${plan.crop.x}, ${plan.crop.y})`);
          console.log(`  Anchor: (${plan.anchor.x.toFixed(3)}, ${plan.anchor.y.toFixed(3)})`);
          console.log(`  Confidence: ${plan.confidence.toFixed(3)} ${plan.needsReview ? '[NEEDS_REVIEW]' : ''}`);
          console.log(`  Reason: ${plan.reason}`);
          console.log(`  Saved: ${outputPath}\n`);

        } catch (err) {
          console.error(`  Error processing ${fileName}:`, err.message);
        }
      }
    }

    // Print summary statistics
    console.log('\n=== Summary Statistics ===\n');
    console.log(`Total images processed: ${confidenceStats.total}`);
    console.log(`Confidence distribution:`);
    console.log(`  High (>= 0.7): ${confidenceStats.high} (${((confidenceStats.high / confidenceStats.total) * 100).toFixed(1)}%)`);
    console.log(`  Medium (0.4-0.7): ${confidenceStats.medium} (${((confidenceStats.medium / confidenceStats.total) * 100).toFixed(1)}%)`);
    console.log(`  Low (< 0.4): ${confidenceStats.low} (${((confidenceStats.low / confidenceStats.total) * 100).toFixed(1)}%)`);
    console.log(`  Needs Review: ${confidenceStats.needsReview} (${((confidenceStats.needsReview / confidenceStats.total) * 100).toFixed(1)}%)`);

    // Flag low-confidence cases
    if (confidenceStats.low > 0) {
      console.log(`\n⚠️  ${confidenceStats.low} images have low confidence (< 0.4)`);
    }
    if (confidenceStats.needsReview > 0) {
      console.log(`⚠️  ${confidenceStats.needsReview} images need manual review`);
    }

    console.log(`\nReframed images saved to: ${outputDir}`);
    console.log('\n=== Test Complete ===');

  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

const folderPath = process.argv[2];
runTest(folderPath);
