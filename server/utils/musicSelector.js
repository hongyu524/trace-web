import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GetObjectCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Curated subset of tracks (IDs) - use only these until full metadata is added
const CURATED_TRACK_IDS = [
  'acoustic_guitar_emotional_nostalgia',
  'affection_full_length',
  'beo_for_the_rest_of_my_life',
  'daniel_catala_elevare',
  'dodo_danciu_scarlett',
  'flint_take_my_time',
  'golden_waves',
  'idokay_chronos',
  'inspirations_cinematic_felt_piano',
  'jeremy_chontow_into_the_deep',
  'nature',
  'roie_shpigler_clarity',
  'romeo_eagle_flight',
  'romeo_rivulet',
  'tristan_barton_mind_heart'
].slice(0, 12); // Take first 12

/**
 * Load recently used tracks from persistence file
 */
function loadRecentTracks() {
  const recentFile = path.join(process.cwd(), 'outputs', 'music_recent.json');
  if (!fs.existsSync(recentFile)) {
    return [];
  }
  try {
    const content = fs.readFileSync(recentFile, 'utf-8');
    const data = JSON.parse(content);
    return Array.isArray(data.trackIds) ? data.trackIds : [];
  } catch (error) {
    console.warn('[MUSIC] Failed to load recent tracks:', error.message);
    return [];
  }
}

/**
 * Save recently used tracks to persistence file (keep last 30)
 */
function saveRecentTrack(trackId) {
  const outputsDir = path.join(process.cwd(), 'outputs');
  if (!fs.existsSync(outputsDir)) {
    fs.mkdirSync(outputsDir, { recursive: true });
  }
  
  const recentFile = path.join(outputsDir, 'music_recent.json');
  let recentTracks = loadRecentTracks();
  
  // Remove if already exists (to move to end)
  recentTracks = recentTracks.filter(id => id !== trackId);
  
  // Add to end
  recentTracks.push(trackId);
  
  // Keep only last 30
  if (recentTracks.length > 30) {
    recentTracks = recentTracks.slice(-30);
  }
  
  try {
    fs.writeFileSync(recentFile, JSON.stringify({ trackIds: recentTracks }, null, 2));
  } catch (error) {
    console.warn('[MUSIC] Failed to save recent tracks:', error.message);
  }
}

/**
 * Download file from S3 to local temp directory
 */
async function downloadFromS3(s3Client, bucket, key, localPath) {
  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    
    const response = await s3Client.send(command);
    
    // Convert stream to buffer and write to file
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    
    // Write buffer to file
    fs.writeFileSync(localPath, buffer);
    
    console.log(`[MUSIC] Downloaded ${key} (${(buffer.length / 1024 / 1024).toFixed(2)} MB) to ${localPath}`);
  } catch (error) {
    console.error(`[MUSIC] Failed to download ${key} from S3:`, error.message);
    throw error;
  }
}

/**
 * Load music catalog from S3 manifest
 */
async function loadMusicCatalogFromS3(s3Client, bucket, musicPrefix = 'music/') {
  const manifestKey = `${musicPrefix}manifest.json`;
  
  try {
    // Create temp directory for manifest
    const tempDir = path.join(__dirname, '../../tmp/music');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const manifestPath = path.join(tempDir, 'manifest.json');
    
    // Download manifest from S3
    await downloadFromS3(s3Client, bucket, manifestKey, manifestPath);
    
    // Read and parse manifest
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    const catalog = JSON.parse(manifestContent);
    
    console.log('[MUSIC] Loaded catalog from S3:', {
      bucket,
      key: manifestKey,
      tracks: catalog.tracks?.length || 0
    });
    
    return catalog;
  } catch (error) {
    console.error('[MUSIC] Failed to load catalog from S3:', error.message);
    // Fallback to local manifest if available
    const localManifestPath = path.join(__dirname, '../../assets/music_pack/manifest.json');
    if (fs.existsSync(localManifestPath)) {
      console.warn('[MUSIC] Falling back to local manifest');
      const manifestContent = fs.readFileSync(localManifestPath, 'utf-8');
      return JSON.parse(manifestContent);
    }
    return { tracks: [] };
  }
}

/**
 * Extract story signals from video plan and analysis results
 * @param {Object} options
 * @param {number} options.totalDurationSec - Total video duration in seconds
 * @param {number} options.photoCount - Number of photos
 * @param {Array} options.analysisResults - Vision analysis results (for visual tone)
 * @param {Array} options.durations - Per-image durations in seconds (optional)
 * @returns {Object} Story signals {pacing, visualTone, totalDurationSec, avgImageDurationSec}
 */
function extractStorySignals({ totalDurationSec, photoCount, analysisResults = [], durations = [] }) {
  // Calculate pacing (images per minute)
  const imagesPerMinute = photoCount > 0 && totalDurationSec > 0 
    ? (photoCount / (totalDurationSec / 60))
    : 0;
  
  let pacing = 'medium';
  if (imagesPerMinute < 5) {
    pacing = 'slow';
  } else if (imagesPerMinute > 10) {
    pacing = 'fast';
  }
  
  // Calculate average image duration
  const avgImageDurationSec = durations.length > 0
    ? durations.reduce((sum, d) => sum + d, 0) / durations.length
    : (totalDurationSec / photoCount);
  
  // Infer visual tone from analysis results
  let visualTone = 'neutral';
  if (analysisResults && analysisResults.length > 0) {
    // Count visual characteristics
    let bwCount = 0;
    let lowContrastCount = 0;
    let facesCount = 0;
    let brightCount = 0;
    let emotionalCount = 0;
    
    for (const analysis of analysisResults) {
      const composition = analysis.composition || {};
      const light = analysis.light || {};
      const subject = analysis.subject || '';
      
      // Check for black & white (would need color analysis - approximate with low contrast + architecture)
      if (light.contrast === 'low' && (subject.includes('architecture') || subject.includes('street'))) {
        bwCount++;
      }
      
      // Low contrast / architecture / empty streets
      if (light.contrast === 'low' || subject.includes('architecture') || subject.includes('street')) {
        lowContrastCount++;
      }
      
      // Faces / people
      if (subject.includes('person') || subject.includes('face') || composition.framing === 'close') {
        facesCount++;
      }
      
      // Bright colors / daylight
      if (light.key === 'high-key' || light.directionality === 'front') {
        brightCount++;
      }
      
      // Emotional (from emotion_vector or mood)
      if (analysis.emotion_vector) {
        const { intimacy = 0, tension = 0, awe = 0 } = analysis.emotion_vector;
        if (intimacy > 0.5 || tension > 0.5 || awe > 0.5) {
          emotionalCount++;
        }
      }
    }
    
    const total = analysisResults.length;
    
    // Determine dominant visual tone
    if (bwCount > total * 0.5) {
      visualTone = 'reflective';
    } else if (lowContrastCount > total * 0.5) {
      visualTone = 'contemplative';
    } else if (facesCount > total * 0.3 || emotionalCount > total * 0.3) {
      visualTone = 'emotional';
    } else if (brightCount > total * 0.5) {
      visualTone = 'uplifting';
    }
  }
  
  return {
    pacing,
    visualTone,
    totalDurationSec,
    avgImageDurationSec,
    imagesPerMinute
  };
}

/**
 * Normalize energy from string to number (1-5)
 */
function normalizeEnergy(energy) {
  if (typeof energy === 'number') {
    return Math.max(1, Math.min(5, Math.round(energy)));
  }
  const energyMap = {
    'low': 1,
    'medium-low': 2,
    'medium': 3,
    'medium-high': 4,
    'high': 5
  };
  return energyMap[energy?.toLowerCase()] || 3;
}

/**
 * Get BPM from track (estimate if not available)
 */
function getBPM(track) {
  if (track.bpm && typeof track.bpm === 'number') {
    return track.bpm;
  }
  // Estimate from tempo
  const tempoMap = {
    'slow': 60,
    'medium': 90,
    'fast': 120
  };
  return tempoMap[track.tempo?.toLowerCase()] || 90;
}

/**
 * Score a track based on story signals (deterministic)
 * @param {Object} track - Music track with metadata
 * @param {Object} storySignals - Story signals {pacing, visualTone, totalDurationSec}
 * @param {number} usedTrackId - ID of recently used track (for penalty)
 * @returns {Object} Score breakdown {total, breakdown}
 */
function scoreTrack(track, storySignals, usedTrackId = null) {
  let total = 0;
  const breakdown = [];
  
  // 1. Mood match (+5 points)
  const trackMoods = track.moods || [];
  const visualToneLower = storySignals.visualTone.toLowerCase();
  
  // Map visual tones to mood keywords
  const toneToMoods = {
    'reflective': ['reflective', 'nostalgic', 'contemplative', 'melancholic'],
    'contemplative': ['contemplative', 'reflective', 'calm', 'quiet'],
    'emotional': ['emotional', 'tender', 'warm', 'intimate'],
    'uplifting': ['uplifting', 'hopeful', 'inspiring', 'bright'],
    'neutral': ['warm', 'calm', 'reflective']
  };
  
  const expectedMoods = toneToMoods[visualToneLower] || toneToMoods['neutral'];
  const normalizedTrackMoods = trackMoods.map(m => m.toLowerCase());
  
  const moodMatch = expectedMoods.some(expected => 
    normalizedTrackMoods.some(trackMood => 
      trackMood.includes(expected) || expected.includes(trackMood)
    )
  );
  
  if (moodMatch) {
    total += 5;
    breakdown.push('mood match');
  }
  
  // 2. Pacing match (+3 points)
  const pacing = storySignals.pacing; // 'slow', 'medium', 'fast'
  const trackTempo = track.tempo?.toLowerCase() || 'medium';
  const bpm = getBPM(track);
  
  let pacingMatch = false;
  if (pacing === 'slow' && (trackTempo === 'slow' || bpm < 75)) {
    pacingMatch = true;
  } else if (pacing === 'medium' && (trackTempo === 'medium' || (bpm >= 75 && bpm <= 100))) {
    pacingMatch = true;
  } else if (pacing === 'fast' && (trackTempo === 'fast' || bpm > 100)) {
    pacingMatch = true;
  }
  
  if (pacingMatch) {
    total += 3;
    breakdown.push('pacing match');
  }
  
  // 3. Duration fit (+3 points)
  const trackMinDuration = track.minDuration || 0;
  const trackMaxDuration = track.maxDuration || Infinity;
  const videoDuration = storySignals.totalDurationSec;
  
  if (videoDuration >= trackMinDuration && videoDuration <= trackMaxDuration) {
    total += 3;
    breakdown.push('duration fit');
  } else if (videoDuration >= trackMinDuration * 0.8 && videoDuration <= trackMaxDuration * 1.2) {
    total += 1; // Partial fit
    breakdown.push('duration partial fit');
  }
  
  // 4. Energy alignment (+2 points)
  const trackEnergy = normalizeEnergy(track.energy);
  // For memory videos, prefer lower energy (1-2)
  const preferredEnergy = 2;
  const energyDiff = Math.abs(trackEnergy - preferredEnergy);
  
  if (energyDiff === 0) {
    total += 2;
    breakdown.push('energy perfect');
  } else if (energyDiff === 1) {
    total += 1;
    breakdown.push('energy good');
  }
  
  // 5. Penalty if used recently (-5 points)
  if (usedTrackId && track.id === usedTrackId) {
    total -= 5;
    breakdown.push('penalty: used recently');
  }
  
  // 6. Penalty if BPM too high for slow pacing (-3 points)
  if (pacing === 'slow' && bpm > 90) {
    total -= 3;
    breakdown.push('penalty: bpm too high for slow pacing');
  }
  
  return { total, breakdown };
}

/**
 * Select the best music track based on story signals (deterministic)
 * Downloads the selected track from S3 to a temp directory
 * @param {Object} options
 * @param {number} options.totalDurationSec - Total video duration in seconds
 * @param {number} options.photoCount - Number of photos
 * @param {Array} options.analysisResults - Vision analysis results
 * @param {Array} options.durations - Per-image durations (optional)
 * @param {string} options.promptText - User's storytelling context (optional, for logging)
 * @param {Object} options.s3Client - AWS S3 Client instance
 * @param {string} options.bucket - S3 bucket name
 * @param {string} options.musicPrefix - S3 prefix for music files (defaults to 'music/')
 * @param {string} options.usedTrackId - ID of recently used track (for penalty)
 * @returns {Promise<Object|null>} Selected track with local path, or null if no track available
 */
export async function selectMusicTrack({ 
  totalDurationSec = 0,
  photoCount = 0,
  analysisResults = [],
  durations = [],
  promptText = '',
  s3Client = null,
  bucket = null,
  musicPrefix = 'music/',
  usedTrackId = null
}) {
  // Require S3 client and bucket
  if (!s3Client || !bucket) {
    console.error('[MUSIC] S3 client and bucket are required for music selection');
    return null;
  }
  
  // Require duration and photo count
  if (!totalDurationSec || totalDurationSec <= 0 || !photoCount || photoCount <= 0) {
    console.error('[MUSIC] totalDurationSec and photoCount are required');
    return null;
  }
  
  // Load catalog
  const catalog = await loadMusicCatalogFromS3(s3Client, bucket, musicPrefix);
  let tracks = catalog.tracks || [];
  
  if (tracks.length === 0) {
    console.error('[MUSIC][NO_MATCH] No tracks available in catalog');
    return null;
  }
  
  // Restrict to curated subset (until full metadata is added)
  tracks = tracks.filter(track => CURATED_TRACK_IDS.includes(track.id));
  if (tracks.length === 0) {
    console.error('[MUSIC][NO_MATCH] No curated tracks available');
    return null;
  }
  console.log(`[MUSIC] Using curated subset: ${tracks.length} tracks`);
  
  // Load recently used tracks for penalty
  const recentTrackIds = loadRecentTracks();
  const lastUsedTrackId = recentTrackIds.length > 0 ? recentTrackIds[recentTrackIds.length - 1] : null;
  
  // Extract story signals
  const storySignals = extractStorySignals({
    totalDurationSec,
    photoCount,
    analysisResults,
    durations
  });
  
  // Score all tracks (use last used track ID for penalty if not provided)
  const penaltyTrackId = usedTrackId || lastUsedTrackId;
  const scoredTracks = tracks.map(track => {
    const { total, breakdown } = scoreTrack(track, storySignals, penaltyTrackId);
    return { track, score: total, breakdown };
  });
  
  // Sort by score (highest first) - DETERMINISTIC: no randomness
  scoredTracks.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score; // Higher score first
    }
    // Tie-breaker: use track ID for deterministic ordering
    return a.track.id.localeCompare(b.track.id);
  });
  
  // Select highest scoring track (NO randomness)
  const best = scoredTracks[0];
  
  // Check if score meets minimum threshold
  const MIN_SCORE_THRESHOLD = 3;
  if (best.score < MIN_SCORE_THRESHOLD) {
    console.log('[MUSIC][NO_MATCH] No track scored above threshold', {
      maxScore: best.score,
      threshold: MIN_SCORE_THRESHOLD,
      topTracks: scoredTracks.slice(0, 3).map(s => ({ id: s.track.id, score: s.score }))
    });
    
    // Use neutral ambient fallback (first track with low energy)
    const fallback = tracks.find(t => normalizeEnergy(t.energy) <= 2) || tracks[0];
    console.log('[MUSIC][NO_MATCH] Using neutral fallback:', fallback.id);
    
    // Continue with fallback track
    const selectedTrack = fallback;
    const musicS3Key = `${musicPrefix}${selectedTrack.file}`;
    const tempDir = path.join(__dirname, '../../tmp/music');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const localFileName = `${selectedTrack.id}-${Date.now()}.mp3`;
    const localFilePath = path.join(tempDir, localFileName);
    
    try {
      await downloadFromS3(s3Client, bucket, musicS3Key, localFilePath);
      return {
        id: selectedTrack.id,
        file: selectedTrack.file,
        path: localFilePath,
        s3Key: musicS3Key,
        score: 0,
        reason: 'fallback (no match)',
        _tempFile: true
      };
    } catch (error) {
      console.error('[MUSIC] Failed to download fallback track:', error.message);
      return null;
    }
  }
  
  const selectedTrack = best.track;
  const reason = best.breakdown.join(' + ');
  
  // Log selection with required format (single clean line)
  console.log(`[MUSIC] storyTone=${storySignals.visualTone} pacing=${storySignals.pacing} selectedTrack=${selectedTrack.id} score=${best.score} reason="${reason}"`);
  
  // Download music file from S3 to temp directory
  const musicS3Key = `${musicPrefix}${selectedTrack.file}`;
  const tempDir = path.join(__dirname, '../../tmp/music');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  // Use unique filename to avoid collisions
  const localFileName = `${selectedTrack.id}-${Date.now()}.mp3`;
  const localFilePath = path.join(tempDir, localFileName);
  
  try {
    console.log('[MUSIC] Downloading track from S3:', {
      bucket,
      key: musicS3Key,
      localPath: localFilePath
    });
    
    await downloadFromS3(s3Client, bucket, musicS3Key, localFilePath);
    
    console.log('[MUSIC] Track downloaded successfully');
    
    // Save to recent tracks (persistence)
    saveRecentTrack(selectedTrack.id);
    
    return {
      id: selectedTrack.id,
      file: selectedTrack.file,
      path: localFilePath,
      s3Key: musicS3Key,
      moods: selectedTrack.moods || [],
      energy: normalizeEnergy(selectedTrack.energy),
      tempo: selectedTrack.tempo || 'medium',
      recommendedStartSec: selectedTrack.recommendedStartSec || 0,
      score: best.score,
      reason: reason,
      // Mark for cleanup after use
      _tempFile: true
    };
  } catch (error) {
    console.error('[MUSIC] Failed to download track from S3:', error.message);
    return null;
  }
}
