/**
 * Music Selector
 * Automatically selects music track based on image mood and story theme
 */

import { readdirSync, existsSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load music tracks from manifest.json if available, otherwise use fallback
 */
function loadMusicTracks(assetsDir) {
  const manifestPath = path.join(assetsDir, 'manifest.json');
  
  if (existsSync(manifestPath)) {
    try {
      const manifestContent = readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestContent);
      
      if (manifest.tracks && Array.isArray(manifest.tracks)) {
        console.log(`[MUSIC] Loaded ${manifest.tracks.length} tracks from manifest.json`);
        // Convert manifest format to our internal format
        return manifest.tracks.map(track => ({
          id: track.id,
          file: track.file,
          mood: track.moods || [],
          energy: track.energy || 'low',
          tempo: track.tempo || 'slow',
          keywords: track.moods || []
        }));
      }
    } catch (error) {
      console.warn(`[MUSIC] Failed to load manifest.json: ${error.message}`);
    }
  }
  
  // Fallback: return empty array (will use filename-based matching)
  return [];
}

/**
 * Find assets directory (check multiple possible locations)
 */
function findAssetsDir() {
  const possiblePaths = [
    path.join(__dirname, 'assets', 'music_pack'),
    path.join(process.cwd(), 'assets', 'music_pack'),
    path.join(__dirname, '..', 'assets', 'music_pack'),
    path.join(process.cwd(), 'server', 'assets', 'music_pack'),
    // Fallback to 'music' folder name
    path.join(__dirname, 'assets', 'music'),
    path.join(process.cwd(), 'assets', 'music'),
    path.join(__dirname, '..', 'assets', 'music'),
    path.join(process.cwd(), 'server', 'assets', 'music'),
  ];
  
  for (const assetsPath of possiblePaths) {
    if (existsSync(assetsPath) && statSync(assetsPath).isDirectory()) {
      console.log(`[MUSIC] Found assets directory: ${assetsPath}`);
      return assetsPath;
    }
  }
  
  console.warn(`[MUSIC] Assets directory not found. Checked: ${possiblePaths.join(', ')}`);
  return null;
}

/**
 * Get available music files from assets directory
 */
function getAvailableMusicFiles() {
  const assetsDir = findAssetsDir();
  if (!assetsDir) {
    return [];
  }
  
  try {
    const files = readdirSync(assetsDir).filter(f => 
      f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.wav') || f.endsWith('.ogg')
    );
    console.log(`[MUSIC] Found ${files.length} music files in assets directory`);
    return files.map(f => path.join(assetsDir, f));
  } catch (error) {
    console.error(`[MUSIC] Error reading assets directory:`, error.message);
    return [];
  }
}

/**
 * Analyze mood from sequence plan and analysis results
 */
function analyzeMood(sequencePlan, analysisResults, promptText = '') {
  // Extract theme and emotion arc from sequence plan
  const theme = sequencePlan?.theme || '';
  const emotionArc = sequencePlan?.emotion_arc || [];
  
  // Extract dominant emotions from analysis results
  const allEmotions = [];
  if (Array.isArray(analysisResults)) {
    for (const analysis of analysisResults) {
      if (analysis.emotion) {
        allEmotions.push(analysis.emotion.toLowerCase());
      }
      if (analysis.mood) {
        allEmotions.push(analysis.mood.toLowerCase());
      }
    }
  }
  
  // Count emotion frequencies
  const emotionCounts = {};
  for (const emotion of allEmotions) {
    emotionCounts[emotion] = (emotionCounts[emotion] || 0) + 1;
  }
  
  // Determine dominant mood
  const dominantEmotion = Object.keys(emotionCounts).reduce((a, b) => 
    emotionCounts[a] > emotionCounts[b] ? a : b, 'calm'
  );
  
  // Analyze theme keywords
  const themeLower = theme.toLowerCase();
  const promptLower = (promptText || '').toLowerCase();
  const combinedText = `${themeLower} ${promptLower}`;
  
  // Determine energy level from emotion arc
  let energyLevel = 'low';
  if (Array.isArray(emotionArc) && emotionArc.length > 0) {
    const avgIntensity = emotionArc.reduce((sum, e) => {
      const intensity = e.intensity || 0.5;
      return sum + intensity;
    }, 0) / emotionArc.length;
    
    if (avgIntensity > 0.7) energyLevel = 'high';
    else if (avgIntensity > 0.4) energyLevel = 'medium';
  }
  
  // Determine mood keywords
  const moodKeywords = [];
  if (combinedText.includes('happy') || combinedText.includes('joy') || combinedText.includes('celebration')) {
    moodKeywords.push('happy', 'joyful', 'uplifting');
  }
  if (combinedText.includes('sad') || combinedText.includes('melancholic') || combinedText.includes('nostalgic')) {
    moodKeywords.push('melancholic', 'nostalgic', 'reflective');
  }
  if (combinedText.includes('calm') || combinedText.includes('peaceful') || combinedText.includes('quiet')) {
    moodKeywords.push('calm', 'peaceful', 'serene');
  }
  if (combinedText.includes('dramatic') || combinedText.includes('intense') || combinedText.includes('powerful')) {
    moodKeywords.push('dramatic', 'intense', 'powerful');
  }
  if (combinedText.includes('warm') || combinedText.includes('cozy') || combinedText.includes('intimate')) {
    moodKeywords.push('warm', 'cozy', 'intimate');
  }
  if (combinedText.includes('emotional') || combinedText.includes('moving') || combinedText.includes('touching')) {
    moodKeywords.push('emotional', 'moving', 'touching');
  }
  
  // If no keywords found, use dominant emotion
  if (moodKeywords.length === 0) {
    moodKeywords.push(dominantEmotion);
  }
  
  return {
    moodKeywords,
    energyLevel,
    dominantEmotion,
    theme
  };
}

/**
 * Select music track based on mood analysis
 */
function selectMusicTrack(sequencePlan, analysisResults, promptText = '') {
  const moodAnalysis = analyzeMood(sequencePlan, analysisResults, promptText);
  const assetsDir = findAssetsDir();
  const availableFiles = getAvailableMusicFiles();
  
  console.log(`[MUSIC] Mood analysis:`, moodAnalysis);
  console.log(`[MUSIC] Available files: ${availableFiles.length}`);
  
  // If no music files available, return null
  if (availableFiles.length === 0) {
    console.warn(`[MUSIC] No music files found in assets directory`);
    return null;
  }
  
  // Load tracks from manifest.json if available
  const musicTracks = assetsDir ? loadMusicTracks(assetsDir) : [];
  
  // Score each available file
  const scoredTracks = availableFiles.map(filePath => {
    const filename = path.basename(filePath);
    const filenameLower = filename.toLowerCase();
    let score = 0;
    
    // Match mood keywords against filename and manifest metadata
    for (const keyword of moodAnalysis.moodKeywords) {
      if (filenameLower.includes(keyword)) score += 2;
    }
    
    // Use manifest metadata if available
    const manifestTrack = musicTracks.find(track => track.file === filename || track.id === filename);
    if (manifestTrack) {
      // Match mood
      for (const keyword of moodAnalysis.moodKeywords) {
        if (manifestTrack.keywords?.includes(keyword) || manifestTrack.mood?.includes(keyword)) {
          score += 3;
        }
      }
      
      // Match energy level
      if (manifestTrack.energy === moodAnalysis.energyLevel) {
        score += 2;
      }
    }
    
    // Bonus for exact filename matches to known moods
    const moodFilenameMatches = [
      { keyword: 'nostalgia', score: 3 },
      { keyword: 'nostalgic', score: 3 },
      { keyword: 'calm', score: 2 },
      { keyword: 'serene', score: 2 },
      { keyword: 'romantic', score: 3 },
      { keyword: 'tender', score: 3 },
      { keyword: 'hopeful', score: 2 },
      { keyword: 'dramatic', score: 2 },
      { keyword: 'cinematic', score: 2 },
    ];
    
    for (const match of moodFilenameMatches) {
      if (filenameLower.includes(match.keyword)) {
        score += match.score;
      }
    }
    
    return {
      track: manifestTrack || { file: filename, id: filename },
      path: filePath,
      score
    };
  });
  
  // Sort by score (highest first)
  scoredTracks.sort((a, b) => b.score - a.score);
  
  // Get best match
  const bestMatch = scoredTracks[0];
  
  if (bestMatch && bestMatch.score > 0) {
    console.log(`[MUSIC] Selected track: ${bestMatch.track.id} (${bestMatch.track.file}) - score: ${bestMatch.score}`);
    return bestMatch.path;
  }
  
  // Fallback: use first available file
  if (availableFiles.length > 0) {
    console.log(`[MUSIC] Using fallback: first available file - ${path.basename(availableFiles[0])}`);
    return availableFiles[0];
  }
  
  console.warn(`[MUSIC] No suitable music track found`);
  return null;
}

export { selectMusicTrack, findAssetsDir, getAvailableMusicFiles };












