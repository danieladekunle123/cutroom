// Video info, downloads, waveforms and exports.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { run, throwIfCancelled } = require('./tools');
const { availableQualities, buildExportPlan, normalizeClip, sourceSpec } = require('../shared/logic');

const SAFE_ID = /^[\w-]{1,64}$/;
const YTDLP_BASE = ['--ignore-config', '--no-playlist', '--no-warnings'];
const PROGRESS_ARGS = [
  '--newline', '--progress',
  '--progress-template', 'download:CUTROOM %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
];
// Previews must play on any PC. HEVC needs graphics hardware that not every PC has, so prefer H.264.
const PREVIEW = { format: '18/bv*+ba/b', sort: 'vcodec:h264,res:480,acodec:aac' };
const MAX_WAVEFORM_POINTS = 400000;
const WAVEFORM_POINTS_PER_SECOND = 100;
const WAVEFORM_SAMPLE_RATE = 8000;

function assertId(id) {
  if (!SAFE_ID.test(String(id))) throw new Error('Invalid video id');
  return id;
}

function videoDir(cacheRoot, id) {
  return path.join(cacheRoot, assertId(id));
}

/** Look up a link's title, length and available qualities without downloading it. */
async function fetchInfo(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only web links are supported.');
  const { stdout } = await run('yt-dlp', [...YTDLP_BASE, '-J', '--flat-playlist', '--playlist-end', '1', '--', parsed.href], { keepStdout: true });
  const info = JSON.parse(stdout);
  if (info._type === 'playlist') throw new Error('That link is a profile or playlist. Paste a link to one video.');
  if (info.is_live) throw new Error("That video is live right now, so it can't be cut yet.");
  if (!info.duration) throw new Error("Couldn't read that video's length.");
  const id = String(info.id).replace(/[^\w-]/g, '_').slice(0, 64);
  return {
    id,
    url: info.webpage_url || parsed.href,
    title: info.title || id,
    uploader: info.uploader || info.channel || '',
    duration: info.duration,
    thumbnail: info.thumbnail || '',
    heights: availableQualities(info.formats),
    infoVersion: 2,
  };
}

/** Find the finished file for a download stem, ignoring yt-dlp's temporary files. */
function findFinished(dir, stem) {
  if (!fs.existsSync(dir)) return null;
  const pattern = new RegExp(`^${stem}\\.(?!part$|ytdl$|temp$)[a-z0-9]+$`, 'i');
  const match = fs.readdirSync(dir).find((name) => pattern.test(name));
  return match ? path.join(dir, match) : null;
}

/** Download with yt-dlp, reporting 0..1 across all the streams it fetches. */
async function download({ url, dir, stem, format, sort, key, onProgress }) {
  await fsp.mkdir(dir, { recursive: true });
  let streams = 1;
  let phase = 0;
  let last = 0;
  const onLine = (line) => {
    const count = line.match(/Downloading (\d+) format/);
    if (count) streams = Number(count[1]) || 1;
    const match = line.match(/^CUTROOM (\S+) (\S+) (\S+)/);
    if (!match) return;
    const done = Number(match[1]);
    const total = Number(match[2]) || Number(match[3]);
    if (!(done >= 0) || !(total > 0)) return;
    const fraction = Math.min(1, done / total);
    if (fraction < last - 0.3) phase = Math.min(phase + 1, streams - 1);
    last = fraction;
    onProgress((phase + fraction) / streams);
  };
  await run('yt-dlp', [
    ...YTDLP_BASE, ...PROGRESS_ARGS,
    '-f', format,
    ...(sort ? ['-S', sort] : []),
    '--merge-output-format', 'mp4/mkv',
    '-P', dir,
    '-o', `${stem}.%(ext)s`,
    '--', url,
  ], { key, onLine });
  const file = findFinished(dir, stem);
  if (!file) throw new Error('The download finished but its file is missing.');
  return file;
}

async function probe(file, key) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', file], { key, keepStdout: true });
  const streams = JSON.parse(stdout).streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  return { hasVideo: Boolean(video), hasAudio: streams.some((s) => s.codec_type === 'audio'), videoCodec: video ? video.codec_name : '' };
}

/** Decode the audio and reduce it to one loudness byte per bucket. */
async function buildWaveform(file, duration, key, onProgress) {
  const pointsPerSecond = Math.min(WAVEFORM_POINTS_PER_SECOND, MAX_WAVEFORM_POINTS / Math.max(duration, 1));
  const samplesPerPoint = Math.max(1, Math.round(WAVEFORM_SAMPLE_RATE / pointsPerSecond));
  const points = new Uint8Array(Math.ceil((duration + 1) * WAVEFORM_SAMPLE_RATE / samplesPerPoint));
  let index = 0;
  let count = 0;
  let peak = 0;
  let carry = null;
  const totalSamples = duration * WAVEFORM_SAMPLE_RATE;
  let seen = 0;
  const addSample = (sample) => {
    const level = Math.abs(sample);
    if (level > peak) peak = level;
    seen += 1;
    if (++count === samplesPerPoint) {
      if (index < points.length) points[index++] = Math.min(255, peak >> 7);
      count = 0;
      peak = 0;
    }
  };
  const onData = (chunk) => {
    let data = chunk;
    if (carry !== null) {
      addSample(Buffer.from([carry, data[0]]).readInt16LE(0));
      data = data.subarray(1);
      carry = null;
    }
    const usable = data.length - (data.length % 2);
    for (let i = 0; i < usable; i += 2) addSample(data.readInt16LE(i));
    if (usable !== data.length) carry = data[usable];
    onProgress(Math.min(1, seen / totalSamples));
  };
  await run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(WAVEFORM_SAMPLE_RATE), '-f', 's16le', '-'], { key, onData });
  return { points: points.subarray(0, index), pointsPerSecond: WAVEFORM_SAMPLE_RATE / samplesPerPoint };
}

/** Everything the editor needs, or null when this video still has to be prepared. */
async function loadPrepared(cacheRoot, id) {
  const dir = videoDir(cacheRoot, id);
  const preview = findFinished(dir, 'preview');
  const metaFile = path.join(dir, 'meta.json');
  if (!preview || !fs.existsSync(metaFile)) return null;
  try {
    const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
    if (meta.previewCodec === undefined) {
      // Made before previews preferred H.264. Replace one that some PCs can't show.
      const { videoCodec } = await probe(preview);
      if (videoCodec === 'hevc') {
        await fsp.rm(preview, { force: true });
        await fsp.rm(metaFile, { force: true });
        return null;
      }
      meta.previewCodec = videoCodec;
      await fsp.writeFile(metaFile, JSON.stringify(meta));
    }
    const peaks = meta.hasAudio ? await fsp.readFile(path.join(dir, 'peaks.bin')) : Buffer.alloc(0);
    return { previewPath: preview, peaks: new Uint8Array(peaks), peaksPerSecond: meta.pointsPerSecond || 0, ...meta };
  } catch {
    return null;
  }
}

/** Download a small preview and draw its waveform. Resumes if it was interrupted. */
async function prepare({ cacheRoot, video, key, onProgress }) {
  const existing = await loadPrepared(cacheRoot, video.id);
  if (existing) return existing;
  const dir = videoDir(cacheRoot, video.id);
  const preview = findFinished(dir, 'preview') || await download({
    url: video.url,
    dir,
    stem: 'preview',
    format: PREVIEW.format,
    sort: PREVIEW.sort,
    key,
    onProgress: (p) => onProgress('preview', p),
  });
  const streams = await probe(preview, key);
  let waveform = { points: new Uint8Array(0), pointsPerSecond: 0 };
  if (streams.hasAudio) {
    onProgress('waveform', 0);
    waveform = await buildWaveform(preview, video.duration, key, (p) => onProgress('waveform', p));
    await fsp.writeFile(path.join(dir, 'peaks.bin'), waveform.points);
  }
  const { videoCodec, ...kinds } = streams;
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ ...kinds, previewCodec: videoCodec, pointsPerSecond: waveform.pointsPerSecond }));
  return loadPrepared(cacheRoot, video.id);
}

function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

async function runFfmpegJob(job, tempFile, key, onFraction) {
  const onLine = (line) => {
    const match = line.match(/^out_time_us=(\d+)/);
    if (match) onFraction(Math.min(1, Number(match[1]) / 1e6 / Math.max(job.duration, 0.001)));
  };
  await run('ffmpeg', job.args(tempFile), { key, onLine });
}

/** Fetch the export-quality source once, then cut it. Never overwrites an existing file. */
async function exportClips({ cacheRoot, request, key, onProgress }) {
  const { video, kind, merge, quality, bitrate, outDir } = request;
  const clips = request.clips.map((c) => normalizeClip(c, video.duration)).filter(Boolean);
  if (!clips.length) throw new Error('There are no clips to export.');

  const dir = videoDir(cacheRoot, video.id);
  const spec = sourceSpec(kind, quality);
  let sourcePath = findFinished(dir, spec.stem);
  if (!sourcePath) {
    const what = kind === 'mp3' ? 'audio' : (spec.stem === 'source_best' ? 'best-quality video' : `${quality}p video`);
    onProgress({ stage: 'download', label: `Downloading ${what}`, progress: 0 });
    sourcePath = await download({
      url: video.url,
      dir,
      stem: spec.stem,
      format: spec.format,
      sort: spec.sort,
      key,
      onProgress: (p) => onProgress({ stage: 'download', label: `Downloading ${what}`, progress: p }),
    });
  }

  const streams = await probe(sourcePath, key);
  const jobs = buildExportPlan({
    source: { path: sourcePath, ...streams },
    clips,
    kind,
    merge,
    baseName: video.title,
    bitrate,
  });

  await fsp.mkdir(outDir, { recursive: true });
  const total = jobs.reduce((sum, job) => sum + job.duration, 0);
  let finished = 0;
  const outputs = [];
  for (const job of jobs) {
    throwIfCancelled(key);
    const finalPath = uniquePath(outDir, job.fileName);
    const ext = path.extname(finalPath);
    const tempFile = `${finalPath.slice(0, finalPath.length - ext.length)}.cutroom-tmp${ext}`;
    try {
      onProgress({ stage: 'cut', label: job.label, progress: finished / total });
      await runFfmpegJob(job, tempFile, key, (f) => {
        onProgress({ stage: 'cut', label: job.label, progress: (finished + f * job.duration) / total });
      });
      await fsp.rename(tempFile, finalPath);
    } catch (error) {
      await fsp.rm(tempFile, { force: true });
      throw error;
    }
    finished += job.duration;
    outputs.push(finalPath);
  }
  return { outputs, outDir };
}

async function directorySize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else total += (await fsp.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Delete export-quality downloads. Previews and waveforms stay so the editor keeps working. */
async function clearSources(cacheRoot) {
  let entries = [];
  try {
    entries = await fsp.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const dir = path.join(cacheRoot, entry.name);
    for (const name of await fsp.readdir(dir)) {
      if (/^(source_|audio\.)/.test(name)) await fsp.rm(path.join(dir, name), { force: true });
    }
  }
}

/**
 * Videos used to live in a folder named "cache", which on Windows is also Chromium's own "Cache"
 * folder. Move them out, leaving Chromium's files where they are. A video that can't move stays
 * put and is downloaded again if it's opened.
 */
async function moveOldVideos(oldRoot, newRoot) {
  let entries = [];
  try {
    entries = await fsp.readdir(oldRoot, { withFileTypes: true });
  } catch {
    return;
  }
  await fsp.mkdir(newRoot, { recursive: true });
  for (const entry of entries.filter((e) => e.isDirectory() && SAFE_ID.test(e.name))) {
    const from = path.join(oldRoot, entry.name);
    const to = path.join(newRoot, entry.name);
    try {
      const names = await fsp.readdir(from);
      if (names.some((n) => /^(meta\.json$|preview\.|source_|audio\.)/.test(n)) && !fs.existsSync(to)) {
        await fsp.rename(from, to);
      }
    } catch {
      // Leave it. See above.
    }
  }
}

async function removeVideoFiles(cacheRoot, id) {
  await fsp.rm(videoDir(cacheRoot, id), { recursive: true, force: true });
}

module.exports = { fetchInfo, prepare, loadPrepared, exportClips, directorySize, clearSources, moveOldVideos, removeVideoFiles };
