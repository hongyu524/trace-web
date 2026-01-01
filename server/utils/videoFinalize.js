import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

function run(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}\n${stderr}`));
    });
  });
}

export async function ffprobeInfo(filePath, opts = {}) {
  const ffprobePath = opts.ffprobePath || 'ffprobe';
  const args = [
    '-v', 'error',
    '-show_entries', 'format=format_name:stream=index,codec_type,codec_name,profile,level,pix_fmt,codec_tag_string,bits_per_raw_sample,width,height,avg_frame_rate,sample_rate,channels',
    '-of', 'json',
    filePath,
  ];
  const { stdout } = await run(ffprobePath, args);
  const parsed = JSON.parse(stdout);
  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio');
  return {
    formatName: parsed.format?.format_name,
    video,
    audio,
  };
}

function isWebSafe(info) {
  const v = info.video;
  if (!v) return false;
  const codecOk = v.codec_name === 'h264';
  const pixOk = v.pix_fmt === 'yuv420p';
  const evenDims = v.width % 2 === 0 && v.height % 2 === 0;
  const levelOk = !v.level || v.level <= 41;
  const audioOk = !info.audio || info.audio.codec_name === 'aac';
  const containerOk = info.formatName ? /mp4|mov/.test(info.formatName) : true;
  return codecOk && pixOk && evenDims && levelOk && audioOk && containerOk;
}

/**
 * Finalize video for web playback with optional music
 * @param {string} inputPath - Path to input video file
 * @param {string} outputPath - Path to output video file
 * @param {boolean} forceTranscode - Force transcoding even if already web-safe
 * @param {Object} opts - Options
 * @param {string} opts.ffmpegPath - Path to ffmpeg binary
 * @param {string} opts.ffprobePath - Path to ffprobe binary
 * @param {Object} opts.musicTrack - Music track object with {path, recommendedStartSec}
 * @returns {Promise<Object>} Video info
 */
export async function finalizeForWeb(inputPath, outputPath, forceTranscode = true, opts = {}) {
  const ffmpegPath = opts.ffmpegPath || 'ffmpeg';
  const ffprobePath = opts.ffprobePath || 'ffprobe';
  const musicTrack = opts.musicTrack || null;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  // Get video duration first (needed for music trimming)
  let videoDuration = 0;
  try {
    const inputInfo = await ffprobeInfo(inputPath, { ffprobePath });
    if (inputInfo.video) {
      // Try to get duration from format
      const { stdout } = await run(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inputPath
      ]);
      videoDuration = parseFloat(stdout) || 0;
    }
  } catch (err) {
    console.warn('[VIDEO] Could not determine video duration:', err.message);
  }

  // If not forcing and no music, probe first
  if (!forceTranscode && !musicTrack) {
    try {
      const info = await ffprobeInfo(inputPath, { ffprobePath });
      if (isWebSafe(info)) {
        fs.copyFileSync(inputPath, outputPath);
        return info;
      }
    } catch (err) {
      // fall through to transcode
    }
  }

  const args = ['-y'];
  
  // Add video input
  args.push('-i', inputPath);
  
  // Add music input if provided
  let musicStartOffset = 0;
  if (musicTrack && musicTrack.path && fs.existsSync(musicTrack.path)) {
    musicStartOffset = musicTrack.recommendedStartSec || 0;
    args.push('-ss', String(musicStartOffset), '-i', musicTrack.path);
    console.log('[MUSIC] Adding music track:', {
      file: musicTrack.file || path.basename(musicTrack.path),
      startOffset: musicStartOffset,
      videoDuration: videoDuration.toFixed(2)
    });
  }

  // Video encoding
  args.push(
    '-map', '0:v:0', // Map video from first input
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level:v', '4.1',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-preset', 'medium',
    '-r', '24'
  );

  // Audio encoding
  if (musicTrack && musicTrack.path && fs.existsSync(musicTrack.path)) {
    // Map audio from music track (second input)
    args.push('-map', '1:a:0'); // Map audio from second input (music)
    
    // Trim music to video duration and add cinematic fades
    if (videoDuration > 0) {
      const fadeIn = 0.8; // 0.8s fade in (cinematic standard)
      const fadeOut = 1.5; // 1.5s fade out (cinematic standard)
      const fadeOutStart = Math.max(0, videoDuration - fadeOut);
      // Combine fades with volume normalization
      const afilter = `afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fadeOutStart}:d=${fadeOut},volume=-3dB`;
      
      args.push('-af', afilter);
      
      // Trim audio to match video duration
      args.push('-shortest'); // Stop encoding when shortest stream ends
      
      console.log('[MUSIC] Audio processing:', {
        trim: `0-${videoDuration.toFixed(2)}s`,
        fadeIn: `${fadeIn}s`,
        fadeOut: `${fadeOut.toFixed(2)}s (starts at ${fadeOutStart.toFixed(2)}s)`,
        startOffset: musicStartOffset,
        volume: '-3dB'
      });
    } else {
      // No duration info - just normalize volume
      args.push('-af', 'volume=-3dB');
      console.log('[MUSIC] Audio processing (no duration): volume normalization only');
    }
    
    // Audio codec settings
    args.push(
      '-c:a', 'aac',
      '-b:a', '160k', // Higher bitrate for music
      '-ac', '2',
      '-ar', '48000'
    );
  } else {
    // No music - copy audio from video if it exists, otherwise no audio
    args.push(
      '-map', '0:a?', // Map audio from video if it exists (optional)
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-ar', '48000'
    );
    console.log('[MUSIC] No music track provided - using video audio if available');
  }

  // Output options
  args.push(
    '-movflags', '+faststart',
    outputPath
  );

  console.log('[VIDEO][FINALIZE] FFmpeg command:', `${ffmpegPath} ${args.join(' ')}`);
  
  await run(ffmpegPath, args);
  
  // Verify output
  const info = await ffprobeInfo(outputPath, { ffprobePath });
  
  // Verify audio was added if music was provided
  if (musicTrack && musicTrack.path) {
    console.log('[MUSIC][MUX] Verifying audio stream in final MP4...');
    
    if (!info.audio) {
      console.error('[MUSIC][MUX][FAILED] Output has no audio stream - mux failed!');
      throw new Error('[MUSIC] Failed to add audio track - output has no audio stream');
    }
    
    if (info.audio.codec_name !== 'aac') {
      console.error(`[MUSIC][MUX][FAILED] Audio codec is not AAC: ${info.audio.codec_name}`);
      throw new Error(`[MUSIC] Audio codec is not AAC: ${info.audio.codec_name}`);
    }
    
    // Log proof that mux succeeded
    console.log('[MUSIC][MUX][SUCCESS] Audio stream verified in final MP4:', {
      codec: info.audio.codec_name,
      sampleRate: info.audio.sample_rate,
      channels: info.audio.channels,
      bitrate: info.audio.bit_rate || 'unknown',
      duration: info.format?.duration || 'unknown'
    });
    console.log('[MUSIC][MUX] ffprobe confirms audio stream exists in output file');
  } else if (musicTrack) {
    console.warn('[MUSIC][MUX] Music track provided but no path available');
  }
  
  if (!isWebSafe(info)) {
    throw new Error('Output not web-safe after transcode');
  }
  
  return info;
}
