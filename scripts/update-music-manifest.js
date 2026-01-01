/**
 * Script to update music manifest.json with all MP3 files in the music_pack directory
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MUSIC_PACK_DIR = path.join(__dirname, '../assets/music_pack');
const MANIFEST_PATH = path.join(MUSIC_PACK_DIR, 'manifest.json');

/**
 * Generate a clean ID from filename
 */
function generateId(filename) {
  return filename
    .replace(/\.mp3$/i, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')  // Convert dashes to underscores
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .toLowerCase()
    .trim();
}

/**
 * Infer default metadata from filename
 */
function inferMetadata(filename) {
  const id = generateId(filename);
  const lower = filename.toLowerCase();
  
  // Default metadata (conservative defaults)
  const metadata = {
    id: id,
    file: filename,
    moods: ['neutral'],
    energy: 'low',
    tempo: 'slow',
    hasDrop: false,
    intro: 'soft',
    outro: 'resolving',
    attributionRequired: false,
    source: 'local',
    recommendedStartSec: 0
  };
  
  // Infer moods from filename keywords
  if (lower.includes('emotional') || lower.includes('nostalgia') || lower.includes('nostalgic')) {
    metadata.moods.push('nostalgic', 'reflective', 'emotional');
  }
  if (lower.includes('cinematic') || lower.includes('epic')) {
    metadata.moods.push('cinematic');
  }
  if (lower.includes('uplifting') || lower.includes('hope') || lower.includes('bright')) {
    metadata.moods.push('uplifting', 'hopeful');
  }
  if (lower.includes('warm') || lower.includes('tender') || lower.includes('romantic')) {
    metadata.moods.push('warm', 'tender');
  }
  if (lower.includes('calm') || lower.includes('peaceful') || lower.includes('quiet')) {
    metadata.moods.push('calm', 'contemplative');
  }
  if (lower.includes('dark') || lower.includes('mysterious') || lower.includes('melancholic')) {
    metadata.moods.push('dark', 'melancholic');
  }
  if (lower.includes('adventure') || lower.includes('hero') || lower.includes('flight')) {
    metadata.moods.push('cinematic', 'adventure');
    metadata.energy = 'medium';
  }
  if (lower.includes('groovy') || lower.includes('funky') || lower.includes('playful')) {
    metadata.moods.push('playful', 'groovy');
    metadata.energy = 'medium';
    metadata.tempo = 'medium';
  }
  
  // Infer energy/tempo from keywords
  if (lower.includes('energy') || lower.includes('powerful') || lower.includes('intense')) {
    metadata.energy = 'medium';
  }
  if (lower.includes('fast') || lower.includes('upbeat')) {
    metadata.tempo = 'medium';
    metadata.energy = 'medium';
  }
  if (lower.includes('instrumental')) {
    metadata.hasDrop = false;
  }
  
  // Remove duplicates from moods
  metadata.moods = [...new Set(metadata.moods)];
  
  // Default to at least one mood
  if (metadata.moods.length === 0 || metadata.moods[0] === 'neutral') {
    metadata.moods = ['neutral', 'reflective'];
  }
  
  return metadata;
}

/**
 * Main function
 */
function main() {
  console.log('[UPDATE-MANIFEST] Starting manifest update...');
  
  // Read existing manifest
  let existingManifest = { tracks: [] };
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      const content = fs.readFileSync(MANIFEST_PATH, 'utf-8');
      existingManifest = JSON.parse(content);
      console.log(`[UPDATE-MANIFEST] Loaded existing manifest with ${existingManifest.tracks?.length || 0} tracks`);
    } catch (error) {
      console.error('[UPDATE-MANIFEST] Failed to read existing manifest:', error.message);
    }
  }
  
  // Build map of existing tracks by filename
  const existingByFile = new Map();
  if (existingManifest.tracks && Array.isArray(existingManifest.tracks)) {
    for (const track of existingManifest.tracks) {
      if (track.file) {
        existingByFile.set(track.file, track);
      }
    }
  }
  
  // Read all MP3 files
  const files = fs.readdirSync(MUSIC_PACK_DIR)
    .filter(f => f.toLowerCase().endsWith('.mp3'))
    .sort();
  
  console.log(`[UPDATE-MANIFEST] Found ${files.length} MP3 files in directory`);
  
  // Build new tracks array
  const tracks = [];
  let added = 0;
  let updated = 0;
  
  for (const filename of files) {
    if (existingByFile.has(filename)) {
      // Keep existing entry (preserve custom metadata)
      tracks.push(existingByFile.get(filename));
      console.log(`[UPDATE-MANIFEST] Keeping existing: ${filename}`);
    } else {
      // Generate new entry
      const metadata = inferMetadata(filename);
      tracks.push(metadata);
      added++;
      console.log(`[UPDATE-MANIFEST] Added new: ${filename} (id: ${metadata.id})`);
    }
  }
  
  // Create new manifest
  const newManifest = {
    tracks: tracks
  };
  
  // Write updated manifest
  const output = JSON.stringify(newManifest, null, 2);
  fs.writeFileSync(MANIFEST_PATH, output, 'utf-8');
  
  console.log(`[UPDATE-MANIFEST] Manifest updated!`);
  console.log(`[UPDATE-MANIFEST] Total tracks: ${tracks.length}`);
  console.log(`[UPDATE-MANIFEST] Added: ${added}`);
  console.log(`[UPDATE-MANIFEST] Preserved: ${tracks.length - added}`);
  console.log(`[UPDATE-MANIFEST] Manifest written to: ${MANIFEST_PATH}`);
}

main();

