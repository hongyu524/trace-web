import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const SUPPORTED_EXTS = new Set(['.mp3', '.wav']);

export function getMusicPackPaths() {
  const projectRoot = process.cwd();
  const __filename = fileURLToPath(import.meta.url);
  const serverDir = path.dirname(__filename);
  const packDir = resolveMusicPackDir(projectRoot, serverDir);
  const manifestPath = path.join(packDir, 'manifest.json');
  return { packDir, manifestPath, projectRoot, serverDir };
}

function runProcess(bin, args, context = 'process', timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });

    let stdout = '';
    let stderr = '';

    const timeoutId = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      reject(new Error(`[${context}] timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutId);
      reject(err);
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutId);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`[${context}] exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

function tokenizeFilenameTags(file) {
  const base = path.basename(file, path.extname(file));
  return base
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t && !/^\d+$/.test(t));
}

function listSupportedAudioFiles(musicDir) {
  try {
    return fs
      .readdirSync(musicDir)
      .filter((f) => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
  } catch (_e) {
    return [];
  }
}

function loadMusicManifestOrFallback(musicDir) {
  const manifestPath = path.join(musicDir, 'manifest.json');

  if (fs.existsSync(manifestPath)) {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = tryParseJson(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.tracks) ? parsed.tracks : null);
    if (!list) {
      throw new Error(`[MUSIC] Invalid manifest.json format at ${manifestPath}. Expected an array or { "tracks": [...] }.`);
    }

    const tracks = list
      .filter((t) => t && typeof t === 'object')
      .map((t) => {
        const file = String(t.file || '');
        const ext = path.extname(file).toLowerCase();
        return {
          id: String(t.id || ''),
          file,
          moods: Array.isArray(t.moods) ? t.moods.map((m) => String(m).toLowerCase()) : [],
          energy: t.energy ? String(t.energy).toLowerCase() : 'low',
          tempo: t.tempo ? String(t.tempo).toLowerCase() : 'slow',
          hasDrop: Boolean(t.hasDrop),
          intro: t.intro ? String(t.intro).toLowerCase() : 'soft',
          outro: t.outro ? String(t.outro).toLowerCase() : 'resolving',
          attributionRequired: Boolean(t.attributionRequired),
          source: t.source ? String(t.source) : '',
          recommendedStartSec: (typeof t.recommendedStartSec === 'number' && Number.isFinite(t.recommendedStartSec)) ? t.recommendedStartSec : null
        };
      })
      .filter((t) => t.id && t.file);

    return { tracks, usedManifest: true, manifestPath };
  }

  console.warn(`[MUSIC] WARN: manifest.json missing at ${manifestPath}. Falling back to filename tags.`);

  const files = fs
    .readdirSync(musicDir)
    .filter((f) => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()));

  const tracks = files.map((f) => {
    const tags = tokenizeFilenameTags(f);
    const energy = tags.includes('high') ? 'high' : (tags.includes('medium') || tags.includes('med')) ? 'medium' : 'low';
    const hasDrop = tags.includes('drop') || tags.includes('beatdrop') || tags.includes('bassdrop');
    const intro = tags.includes('softintro') || tags.includes('soft') ? 'soft' : 'unknown';
    const outro = tags.includes('resolving') || tags.includes('resolve') ? 'resolving' : 'unknown';
    const attributionRequired = tags.includes('attrib') || tags.includes('attribution') || tags.includes('cc');

    return {
      id: path.basename(f, path.extname(f)),
      file: f,
      moods: tags,
      energy,
      tempo: tags.includes('fast') ? 'fast' : tags.includes('mediumtempo') ? 'medium' : 'slow',
      hasDrop,
      intro,
      outro,
      attributionRequired,
      source: 'filename-tags',
      recommendedStartSec: null
    };
  });

  return { tracks, usedManifest: false, manifestPath };
}

function deriveMusicBriefFromStoryLock(storyLock, isDeakins = false) {
  const avoid = ['uplifting', 'big drums', 'drop', 'trailer'];

  const moodCounts = new Map();
  const beatBuckets = { arrival: [], observation: [], distance: [], peak: [], release: [] };

  const why = (storyLock && storyLock.why_each_image_is_here) ? storyLock.why_each_image_is_here : {};
  for (const k of Object.keys(why)) {
    const entry = why[k] || {};
    const moods = Array.isArray(entry.mood) ? entry.mood : [];
    const beat = entry.beat || 'observation';

    for (const m of moods) {
      const mm = String(m).toLowerCase();
      moodCounts.set(mm, (moodCounts.get(mm) || 0) + 1);
      if (beatBuckets[beat]) beatBuckets[beat].push(mm);
    }
  }

  const topMoods = Array.from(moodCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m)
    .slice(0, 2);

  const peakTimePct = 0.7;

  const energyCurve = (() => {
    // v1: keep it simple and deterministic
    // Deakins: mostly low
    if (isDeakins) return ['low', 'low', 'low', 'low'];
    return ['low', 'low', 'medium', 'low'];
  })();

  const mood = topMoods.length > 0 ? topMoods : ['quiet', 'reflective'];

  if (isDeakins) {
    // Enforce Deakins constraints in brief
    avoid.push('uplifting', 'drop', 'big drums', 'trailer');
  }

  return {
    mood,
    energyCurve,
    peakTimePct,
    avoid
  };
}

function scoreTrackV1(track, musicBrief, isDeakins = false) {
  const reasons = [];
  const breakdown = {
    moodOverlap: 0,
    energyMatch: 0,
    noDrop: 0,
    softIntro: 0,
    resolvingOutro: 0,
    attributionPenalty: 0,
    total: 0
  };

  if (track.attributionRequired) {
    breakdown.attributionPenalty = -999;
    breakdown.total = -999;
    return { score: breakdown.total, breakdown, reasons: ['rejected: attributionRequired=true'] };
  }

  const briefMoods = new Set(Array.isArray(musicBrief?.mood) ? musicBrief.mood.map((m) => String(m).toLowerCase()) : []);
  const trackMoods = new Set(Array.isArray(track?.moods) ? track.moods.map((m) => String(m).toLowerCase()) : []);
  let overlap = 0;
  for (const m of briefMoods) if (trackMoods.has(m)) overlap += 1;
  breakdown.moodOverlap = overlap * 3;
  if (overlap > 0) reasons.push(`mood overlap x${overlap}`);

  const overallEnergy = (() => {
    const curve = Array.isArray(musicBrief?.energyCurve) ? musicBrief.energyCurve : [];
    const counts = { low: 0, medium: 0, high: 0 };
    for (const e of curve) {
      const ee = String(e).toLowerCase();
      if (counts[ee] !== undefined) counts[ee] += 1;
    }
    if (counts.high > counts.medium && counts.high > counts.low) return 'high';
    if (counts.medium > counts.low) return 'medium';
    return 'low';
  })();

  if (String(track.energy).toLowerCase() === overallEnergy) {
    breakdown.energyMatch = 2;
    reasons.push(`energy match (${overallEnergy})`);
  }

  if (track.hasDrop === false) {
    breakdown.noDrop = 2;
    reasons.push('no drop');
  } else if (isDeakins) {
    // Deakins hard reject drops
    return { score: -999, breakdown: { ...breakdown, total: -999 }, reasons: ['rejected: hasDrop=true (deakins)'] };
  }

  if (String(track.intro).toLowerCase() === 'soft') {
    breakdown.softIntro = 1;
    reasons.push('soft intro');
  } else if (isDeakins) {
    return { score: -999, breakdown: { ...breakdown, total: -999 }, reasons: ['rejected: intro not soft (deakins)'] };
  }

  if (String(track.outro).toLowerCase() === 'resolving') {
    breakdown.resolvingOutro = 1;
    reasons.push('resolving outro');
  } else if (isDeakins) {
    return { score: -999, breakdown: { ...breakdown, total: -999 }, reasons: ['rejected: outro not resolving (deakins)'] };
  }

  breakdown.total =
    breakdown.moodOverlap +
    breakdown.energyMatch +
    breakdown.noDrop +
    breakdown.softIntro +
    breakdown.resolvingOutro +
    breakdown.attributionPenalty;

  return { score: breakdown.total, breakdown, reasons };
}

function pickStartAtSec(track, trackDurationSec, videoDurationSec) {
  const rec = (typeof track.recommendedStartSec === 'number' && Number.isFinite(track.recommendedStartSec))
    ? Math.max(0, track.recommendedStartSec)
    : 0;

  if (rec + videoDurationSec <= trackDurationSec + 1e-6) return rec;
  if (0 + videoDurationSec <= trackDurationSec + 1e-6) return 0;
  return null;
}

function getFfprobePathFromFfmpeg(ffmpegPath) {
  if (!ffmpegPath || ffmpegPath === 'ffmpeg') return 'ffprobe';
  const dir = path.dirname(ffmpegPath);
  const probe = path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return probe;
}

async function probeDurationSec(ffprobePath, mediaPath) {
  const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mediaPath];
  const { stdout } = await runProcess(ffprobePath, args, 'ffprobe', 60000);
  const v = parseFloat(String(stdout).trim());
  if (!Number.isFinite(v) || v <= 0) throw new Error(`[MUSIC] ffprobe returned invalid duration for ${mediaPath}: ${stdout}`);
  return v;
}

async function muxMusicOntoVideo({ ffmpegPath, videoPath, musicPath, startAtSec, videoDurationSec, outPath }) {
  const fadeIn = 0.7;
  const fadeOut = 1.5;
  const endAt = startAtSec + videoDurationSec;
  const fadeOutStart = Math.max(0, videoDurationSec - fadeOut);

  console.log(`[MUSIC] trim start=${startAtSec.toFixed(3)} end=${endAt.toFixed(3)} fadeIn=${fadeIn} fadeOut=${fadeOut}`);

  const afilter =
    `[1:a]` +
    `atrim=start=${startAtSec.toFixed(3)}:end=${endAt.toFixed(3)},` +
    `asetpts=PTS-STARTPTS,` +
    `afade=t=in:st=0:d=${fadeIn},` +
    `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut},` +
    `aresample=48000,` +
    `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
    `volume=-6dB` +
    `[amusic]`;

  const args = [
    '-i', videoPath,
    '-i', musicPath,
    '-filter_complex', afilter,
    '-map', '0:v:0',
    '-map', '[amusic]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-y',
    outPath
  ];

  await runProcess(ffmpegPath, args, 'ffmpeg-mux-music', 300000);
}

function resolveMusicPackDir(projectRoot, serverDir) {
  const candidates = [
    path.join(projectRoot, 'assets', 'music_pack'),
    path.join(serverDir, 'music_pack')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  return candidates[0];
}

export async function tryAddMusicV1({
  ffmpegPath,
  videoPath,
  outputsDir,
  storyLock,
  editStyle,
  musicEnabled = true
}) {
  const briefPath = path.join(outputsDir, 'musicBrief.json');
  const decisionPath = path.join(outputsDir, 'musicDecision.json');
  const errorPath = path.join(outputsDir, 'musicError.txt');

  try {
    const projectRoot = process.cwd();
    const __filename = fileURLToPath(import.meta.url);
    const serverDir = path.dirname(__filename);

    const musicDir = resolveMusicPackDir(projectRoot, serverDir);
    const manifestJsonPath = path.join(musicDir, 'manifest.json');

    console.log('[MUSIC] ENTER addMusicStep', { musicEnabled, packDir: musicDir, manifestPath: manifestJsonPath });

    if (!musicEnabled) {
      fs.writeFileSync(decisionPath, JSON.stringify({ ok: false, reason: 'music disabled', musicDir, manifestPath: manifestJsonPath }, null, 2));
      return null;
    }

    const packExists = fs.existsSync(musicDir);
    console.log('[MUSIC] packDir', { packDir: musicDir, exists: packExists });
    if (!packExists) {
      throw new Error(`[MUSIC] pack empty or path wrong: folder missing at ${musicDir}`);
    }

    const discoveredFiles = listSupportedAudioFiles(musicDir);
    console.log('[MUSIC] discovered audio files', { count: discoveredFiles.length, files: discoveredFiles });
    if (discoveredFiles.length === 0) {
      throw new Error('[MUSIC] pack empty or path wrong');
    }

    const manifestExists = fs.existsSync(manifestJsonPath);
    console.log('[MUSIC] manifest.json', { exists: manifestExists, manifestPath: manifestJsonPath });

    const ffprobePath = getFfprobePathFromFfmpeg(ffmpegPath);

    try {
      const { stdout: ffmpegVer } = await runProcess(ffmpegPath, ['-version'], 'ffmpeg-version', 8000);
      console.log('[MUSIC] ffmpeg -version', String(ffmpegVer).split('\n')[0] || 'unknown');
    } catch (e) {
      throw new Error(`[MUSIC] ffmpeg/ffprobe not found; cannot add music (${e.message})`);
    }

    try {
      const { stdout: ffprobeVer } = await runProcess(ffprobePath, ['-version'], 'ffprobe-version', 8000);
      console.log('[MUSIC] ffprobe -version', String(ffprobeVer).split('\n')[0] || 'unknown');
    } catch (e) {
      throw new Error(`[MUSIC] ffmpeg/ffprobe not found; cannot add music (${e.message})`);
    }

    const videoDurationSec = await probeDurationSec(ffprobePath, videoPath);
    console.log(`[MUSIC] videoDuration=${videoDurationSec.toFixed(3)}s`);

    const isDeakins = String(editStyle || '').toLowerCase() === 'deakins';

    const { tracks, usedManifest, manifestPath } = loadMusicManifestOrFallback(musicDir);
    if (!Array.isArray(tracks) || tracks.length === 0) {
      throw new Error('[MUSIC] no tracks available in music pack.');
    }

    const musicBrief = deriveMusicBriefFromStoryLock(storyLock, isDeakins);
    fs.writeFileSync(briefPath, JSON.stringify(musicBrief, null, 2));

    // Score tracks, probe duration, reject short tracks (v1 no looping)
    let best = null;
    const considered = [];

    for (const t of tracks) {
      const ext = path.extname(t.file).toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) continue;

      const fullPath = path.join(musicDir, t.file);
      if (!fs.existsSync(fullPath)) {
        considered.push({ id: t.id, file: t.file, rejected: true, reason: 'missing file' });
        continue;
      }

      let trackDurationSec;
      try {
        trackDurationSec = await probeDurationSec(ffprobePath, fullPath);
      } catch (e) {
        considered.push({ id: t.id, file: t.file, rejected: true, reason: `ffprobe failed: ${e.message}` });
        continue;
      }

      if (trackDurationSec + 1e-6 < videoDurationSec) {
        console.log(`[MUSIC] rejected short track: ${t.id} trackDuration=${trackDurationSec.toFixed(3)} videoDuration=${videoDurationSec.toFixed(3)}`);
        considered.push({ id: t.id, file: t.file, rejected: true, reason: 'too short', trackDurationSec });
        continue;
      }

      const scored = scoreTrackV1(t, musicBrief, isDeakins);
      console.log(`[MUSIC] score track=${t.id} score=${scored.score} reasons=${(scored.reasons || []).join(', ')}`);
      if (scored.score <= -999) {
        considered.push({ id: t.id, file: t.file, rejected: true, reason: scored.reasons[0] || 'rejected', trackDurationSec });
        continue;
      }

      const startAtSec = pickStartAtSec(t, trackDurationSec, videoDurationSec);
      if (startAtSec === null) {
        considered.push({ id: t.id, file: t.file, rejected: true, reason: 'no valid startAt segment', trackDurationSec });
        continue;
      }

      const candidate = {
        track: t,
        fullPath,
        trackDurationSec,
        startAtSec,
        score: scored.score,
        breakdown: scored.breakdown,
        reasons: scored.reasons
      };

      considered.push({ id: t.id, file: t.file, rejected: false, score: scored.score, breakdown: scored.breakdown, reasons: scored.reasons, trackDurationSec, startAtSec });

      if (!best || candidate.score > best.score) best = candidate;
    }

    if (!best) {
      console.warn('[MUSIC] no suitable track found');
      fs.writeFileSync(decisionPath, JSON.stringify({
        ok: false,
        reason: 'no suitable track found',
        usedManifest,
        manifestPath,
        musicDir,
        videoDurationSec,
        considered
      }, null, 2));
      return null;
    }

    console.log(`[MUSIC] selected track=${best.track.id} score=${best.score} reason=${best.reasons.join(', ')}`);

    const decision = {
      ok: true,
      selected: {
        trackId: best.track.id,
        file: best.track.file,
        score: best.score,
        breakdown: best.breakdown,
        reasons: best.reasons,
        usedManifest,
        manifestPath,
        source: best.track.source || ''
      },
      trim: {
        startAtSec: best.startAtSec,
        endAtSec: best.startAtSec + videoDurationSec,
        fadeInSec: 0.7,
        fadeOutSec: 1.5
      },
      durations: {
        videoDurationSec,
        musicDurationSec: best.trackDurationSec
      },
      considered
    };

    fs.writeFileSync(decisionPath, JSON.stringify(decision, null, 2));

    const base = path.basename(videoPath, path.extname(videoPath));
    const outWithMusic = path.join(path.dirname(videoPath), `${base}_with_music.mp4`);

    await muxMusicOntoVideo({
      ffmpegPath,
      videoPath,
      musicPath: best.fullPath,
      startAtSec: best.startAtSec,
      videoDurationSec,
      outPath: outWithMusic
    });

    if (!fs.existsSync(outWithMusic) || fs.statSync(outWithMusic).size === 0) {
      throw new Error(`[MUSIC] output final_with_music.mp4 missing or empty: ${outWithMusic}`);
    }

    const stableOut = path.join(outputsDir, 'final_with_music.mp4');
    try {
      fs.copyFileSync(outWithMusic, stableOut);
    } catch (_e) {
      // Ignore copy failures; primary output is still outWithMusic
    }

    console.log('[MUSIC] SUCCESS wrote final_with_music.mp4');
    console.log(`[MUSIC] wrote ${outWithMusic}`);

    return {
      outPath: outWithMusic,
      briefPath,
      decisionPath,
      musicBrief,
      decision
    };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.error(`[MUSIC] failed to add music: ${msg}`);
    try {
      if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });
      if (!fs.existsSync(briefPath)) {
        const fallbackBrief = deriveMusicBriefFromStoryLock(storyLock, String(editStyle || '').toLowerCase() === 'deakins');
        fs.writeFileSync(briefPath, JSON.stringify(fallbackBrief, null, 2));
      }
      if (!fs.existsSync(decisionPath)) {
        fs.writeFileSync(decisionPath, JSON.stringify({ ok: false, reason: msg }, null, 2));
      }
      fs.writeFileSync(errorPath, msg);
    } catch (_writeErr) {
      // ignore
    }
    throw e;
  }
}
