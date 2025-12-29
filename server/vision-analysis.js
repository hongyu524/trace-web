/**
 * Stage 1: Vision Analysis
 * Analyzes ALL images using OpenAI Vision API
 * Returns structured JSON per image with composition, mood, emotion vectors, and motion recommendations
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

/**
 * Analyze a single image using OpenAI Vision API
 * @param {string} imagePath - Absolute path to image file
 * @param {string} filename - Original filename for logging
 * @param {OpenAI} openai - OpenAI client instance
 * @returns {Promise<Object>} Structured analysis JSON
 */
async function analyzeImage(imagePath, filename, openai) {
  // Read image file and convert to base64
  const imageBuffer = fs.readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  
  // Determine MIME type from extension
  const ext = path.extname(filename).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 
                   ext === '.webp' ? 'image/webp' : 
                   'image/jpeg';
  
  try {
    const modelName = 'gpt-4o';
    const endpoint = 'chat.completions.create';
    const apiKeySuffix = openai.apiKey ? openai.apiKey.slice(-6) : 'N/A';
    
    console.log(`[OPENAI] Vision Analysis - Endpoint: ${endpoint}, Model: ${modelName}, Key (last6): ...${apiKeySuffix}`);
    
    const response = await openai.chat.completions.create({
      model: modelName, // Use vision-capable model
      messages: [{
        role: 'system',
        content: `You are a professional cinematographer and video editor analyzing images for a cinematic memory video.

Your task is to analyze each image and output structured JSON with:
- subject: what the image is "about" (architecture/person/object/landscape/abstract)
- composition: framing (wide/medium/close), symmetry (high/medium/low), leading_lines (yes/no), negative_space (high/medium/low)
- light: key (high-key/low-key/mid-key), contrast (high/medium/low), directionality (front/side/back/ambient)
- mood: array of 3-5 mood tags (e.g., ["solitude", "tension", "calm", "awe"])
- visual_energy: 1-10 (1=very still, 10=very dynamic)
- emotion_vector: object with values 0-1 for {calm, tension, mystery, intimacy, awe}
- motion_safe_zones: object with {center: boolean, left: boolean, right: boolean, top: boolean, bottom: boolean} indicating safe areas for pan/zoom
- recommended_move_types: array of allowed moves (e.g., ["slow_push_in", "drift_left", "hold", "reveal"])
- do_not: array of forbidden moves (e.g., ["fast_zoom", "random_direction", "heavy_shake", "excessive_rotation"])
- best_role: array of roles with scores (e.g., [{"role": "opener", "score": 0.8}, {"role": "bridge", "score": 0.3}])

CRITICAL RULES:
- Do not suggest motion not supported by composition. Motion must serve emotion.
- If important subject near frame edge, prohibit pans toward that edge.
- If text/signage exists, movement must be slow enough to not blur it.
- If composition has high symmetry, prefer straight push/pull (no sideways drift).
- If no depth exists, do not suggest parallax moves.

Output ONLY valid JSON, no markdown.`
      }, {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Analyze this image and output the structured JSON as specified.'
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`
            }
          }
        ]
      }],
      max_tokens: 800,
      temperature: 0.3
    });
    
    const content = response.choices[0].message.content.trim();
    // Remove markdown code blocks if present
    const jsonContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const analysis = JSON.parse(jsonContent);
    
    // Validate and add filename/index metadata
    return {
      filename,
      imagePath,
      ...analysis
    };
  } catch (error) {
    console.error(`[VISION-ANALYSIS] Error analyzing ${filename}:`, error.message);
    // Return safe defaults if analysis fails
    return {
      filename,
      imagePath,
      subject: 'unknown',
      composition: { framing: 'medium', symmetry: 'medium', leading_lines: false, negative_space: 'medium' },
      light: { key: 'mid-key', contrast: 'medium', directionality: 'ambient' },
      mood: ['unknown'],
      visual_energy: 5,
      emotion_vector: { calm: 0.5, tension: 0.3, mystery: 0.2, intimacy: 0.3, awe: 0.2 },
      motion_safe_zones: { center: true, left: true, right: true, top: true, bottom: true },
      recommended_move_types: ['hold', 'slow_push_in'],
      do_not: ['fast_zoom', 'random_direction'],
      best_role: [{ role: 'bridge', score: 0.5 }],
      analysisError: error.message
    };
  }
}

/**
 * Analyze ALL images (Stage 1)
 * @param {Array<Object>} photos - Array of photo objects with {filename, storedPath, ...}
 * @param {string} uploadsSessionDir - Directory containing uploaded images
 * @param {string} openaiApiKey - OpenAI API key
 * @param {Object} progressReporter - Optional progress reporter for SSE updates
 * @returns {Promise<Array<Object>>} Array of analysis results, one per image
 */
export async function analyzeAllImages(photos, uploadsSessionDir, openaiApiKey, progressReporter = null) {
  console.log(`[VISION-ANALYSIS] Starting analysis of ${photos.length} images...`);
  
  if (!openaiApiKey) {
    throw new Error('OpenAI API key required for vision analysis');
  }
  
  const apiKeySuffix = openaiApiKey.slice(-6);
  console.log(`[VISION-ANALYSIS] OpenAI client initialized with key (last6): ...${apiKeySuffix}`);
  
  const openai = new OpenAI({ apiKey: openaiApiKey });
  const analysisResults = [];
  
  // Analyze each image sequentially (to avoid rate limits)
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const imagePath = photo.storedPath || path.join(uploadsSessionDir, photo.filename);
    
    if (!fs.existsSync(imagePath)) {
      console.error(`[VISION-ANALYSIS] Image not found: ${imagePath}`);
      throw new Error(`Image not found: ${imagePath}`);
    }
    
    // Report progress (5-55% range for image analysis)
    if (progressReporter) {
      const progress = (i + 1) / photos.length;
      const percent = 5 + (50 * progress); // 5% to 55%
      progressReporter.report('analyzing', percent, `Analyzing image ${i + 1}/${photos.length}`);
    }
    
    console.log(`[VISION-ANALYSIS] Analyzing ${i + 1}/${photos.length}: ${photo.filename}`);
    const analysis = await analyzeImage(imagePath, photo.filename || photo.originalName, openai);
    analysisResults.push(analysis);
    
    // Small delay to avoid rate limits (50ms between requests)
    if (i < photos.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  
  // Validation: ensure all images were analyzed
  if (analysisResults.length !== photos.length) {
    const analyzedFilenames = new Set(analysisResults.map(a => a.filename));
    const missingFilenames = photos
      .map(p => p.filename || p.originalName)
      .filter(f => !analyzedFilenames.has(f));
    
    throw new Error(
      `Analysis incomplete: ${analysisResults.length}/${photos.length} images analyzed. ` +
      `Missing: ${missingFilenames.join(', ')}`
    );
  }
  
  console.log(`[VISION-ANALYSIS] Completed analysis of ${analysisResults.length} images`);
  return analysisResults;
}

