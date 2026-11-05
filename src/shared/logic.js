// Pure logic shared by the main process (require) and the renderer (script tag).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MIN_CLIP = 0.1;

  /** "1:23", "1:23.5", "01:02:03", "83", "83.5" -> seconds, or null when invalid. */
  function parseTime(text) {
    const value = String(text == null ? '' : text).trim();
    if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(value)) return null;
    const parts = value.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  /** Seconds -> "m:ss.dd" or "h:mm:ss.dd". `digits` is the number of decimals (0-3). */
  function formatTime(seconds, digits = 2) {
    const scale = Math.pow(10, digits);
    const whole = Math.round(Math.max(0, seconds || 0) * scale);
    const totalSeconds = Math.floor(whole / scale);
    const fraction = whole - totalSeconds * scale;
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const ss = String(s).padStart(2, '0');
    const tail = digits > 0 ? '.' + String(fraction).padStart(digits, '0') : '';
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}${tail}`;
    return `${m}:${ss}${tail}`;
  }

  /** "0:13-0:27, 0:38-0:50" -> { ranges: [{start, end}], errors: [text] }. */
  function parseRanges(text, duration) {
    const ranges = [];
    const errors = [];
    const max = duration > 0 ? duration : Infinity;
    for (const chunk of String(text || '').split(/[,;\n]+/)) {
      const piece = chunk.trim();
      if (!piece) continue;
      const match = piece.match(/^(.+?)\s*(?:-|–|—|\bto\b)\s*(.+)$/i);
      const start = match ? parseTime(match[1]) : null;
      const end = match ? parseTime(match[2]) : null;
      if (start === null || end === null) {
        errors.push(`"${piece}" isn't a start-end range`);
      } else if (start >= max) {
        errors.push(`"${piece}" starts after the video ends`);
      } else if (Math.min(end, max) - start < MIN_CLIP) {
        errors.push(`"${piece}" ends before it starts`);
      } else {
        ranges.push({ start, end: Math.min(end, max) });
      }
    }
    return { ranges, errors };
  }

  /** Pull http(s) links out of pasted text. Bare YouTube, TikTok and Twitch links get https://. */
  function splitUrls(text) {
    const urls = [];
    const invalid = [];
    for (const token of String(text || '').split(/[\s,]+/)) {
      if (!token) continue;
      let candidate = token;
      if (/^((www|m|music|vm|vt|clips)\.)?(youtube\.com|youtu\.be|tiktok\.com|twitch\.tv)\//i.test(candidate)) candidate = 'https://' + candidate;
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') urls.push(parsed.href);
        else invalid.push(token);
      } catch {
        invalid.push(token);
      }
    }
    return { urls: [...new Set(urls)], invalid };
  }

  /** Make text safe to use as a Windows file name. */
  function sanitizeFilename(name, fallback = 'clip') {
    let clean = String(name || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100)
      .replace(/[. ]+$/, '');
    if (!clean) clean = fallback;
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean)) clean = '_' + clean;
    return clean;
  }

  /** Keep a clip inside the video and at least MIN_CLIP long, or return null if it can't fit. */
  function normalizeClip(clip, duration) {
    const start = Number(clip.start);
    const rawEnd = Number(clip.end);
    if (!Number.isFinite(start) || !Number.isFinite(rawEnd) || start < 0) return null;
    const end = duration > 0 ? Math.min(rawEnd, duration) : rawEnd;
    if (end - start < MIN_CLIP) return null;
    return { name: clip.name, start, end };
  }

  const num = (n) => String(Math.round(n * 1000) / 1000);

  function encoderArgs(kind, bitrate, hasVideo) {
    if (kind === 'mp3') return ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`];
    const audio = ['-c:a', 'aac', '-b:a', '192k'];
    if (!hasVideo) return audio;
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', ...audio, '-movflags', '+faststart'];
  }

  /**
   * Plan the ffmpeg runs for an export. Each job has the file name it produces, the length of
   * that output, and `args(outputPath)` for ffmpeg. Seeking before -i with a re-encode is
   * frame accurate, so cuts land exactly where the clip says.
   */
  function buildExportPlan({ source, clips, kind, merge, baseName, bitrate = 192 }) {
    const ext = kind === 'mp3' ? 'mp3' : 'mp4';
    const useVideo = kind === 'mp4' && source.hasVideo;
    const useAudio = source.hasAudio;
    if (kind === 'mp3' && !useAudio) throw new Error("This video has no audio track, so it can't be exported as MP3.");
    if (!useVideo && !useAudio) throw new Error('This video has nothing to export.');

    const base = ['-hide_banner', '-v', 'error', '-y', '-progress', 'pipe:1', '-nostats'];
    const safeBase = sanitizeFilename(baseName, 'video');
    const inputFor = (clip) => ['-ss', num(clip.start), '-t', num(clip.end - clip.start), '-i', source.path];
    const encode = encoderArgs(kind, bitrate, useVideo);

    if (merge && clips.length > 1) {
      const pads = clips
        .map((_, i) => (useVideo ? `[${i}:v:0]` : '') + (useAudio ? `[${i}:a:0]` : ''))
        .join('');
      const outPads = (useVideo ? '[v]' : '') + (useAudio ? '[a]' : '');
      const filter = `${pads}concat=n=${clips.length}:v=${useVideo ? 1 : 0}:a=${useAudio ? 1 : 0}${outPads}`;
      const maps = [...(useVideo ? ['-map', '[v]'] : []), ...(useAudio ? ['-map', '[a]'] : [])];
      return [{
        fileName: `${safeBase} - merged.${ext}`,
        label: `Merging ${clips.length} clips`,
        duration: clips.reduce((sum, c) => sum + (c.end - c.start), 0),
        args: (output) => [...base, ...clips.flatMap(inputFor), '-filter_complex', filter, ...maps, ...encode, output],
      }];
    }

    const seen = new Map();
    return clips.map((clip, index) => {
      let name = `${safeBase} - ${sanitizeFilename(clip.name, `Clip ${index + 1}`)}`;
      const key = name.toLowerCase();
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      if (count > 1) name += ` (${count})`;
      const maps = [...(useVideo ? ['-map', '0:v:0'] : []), ...(useAudio ? ['-map', '0:a:0'] : [])];
      return {
        fileName: `${name}.${ext}`,
        label: clips.length > 1 ? `Cutting clip ${index + 1} of ${clips.length}` : 'Cutting clip',
        duration: clip.end - clip.start,
        args: (output) => [...base, ...inputFor(clip), ...maps, ...encode, output],
      };
    });
  }

  /**
   * yt-dlp format selector and cache file stem for an export's source file. Sorting by "res"
   * goes by a picture's short side, so 720 means 720x1280 on a vertical video as well.
   */
  function sourceSpec(kind, quality) {
    if (kind === 'mp3') return { stem: 'audio', format: 'ba/b' };
    const size = Number(quality);
    if (Number.isFinite(size) && size > 0) {
      return { stem: `source_${size}`, format: 'bv*+ba/b', sort: `res:${size}` };
    }
    return { stem: 'source_best', format: 'bv*+ba/b' };
  }

  /**
   * Quality steps a video offers, largest first, named by the picture's short side.
   * A vertical 1080x1920 video is 1080p, and sites that don't report a codec still count.
   */
  function availableQualities(formats) {
    const sizes = new Set();
    for (const f of formats || []) {
      if (!f.height || f.vcodec === 'none') continue;
      sizes.add(f.width ? Math.min(f.width, f.height) : f.height);
    }
    return [...sizes].sort((a, b) => b - a);
  }

  /** Which of the sites Cutroom names a link belongs to, or null for anything else. */
  function siteOf(url) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    const on = (domain) => host === domain || host.endsWith(`.${domain}`);
    if (on('youtube.com') || on('youtu.be')) return 'youtube';
    if (on('tiktok.com')) return 'tiktok';
    if (on('twitch.tv')) return 'twitch';
    return null;
  }

  /** Turn yt-dlp's errors into what they mean for the person using the app. */
  function friendlyError(message) {
    const text = String(message || '');
    if (/IP address is blocked/i.test(text)) {
      return "TikTok wouldn't open that video. It may be deleted or private, or TikTok may be blocking your connection. Check the link in your browser.";
    }
    if (/not currently live/i.test(text)) return "That's a channel page. Paste a link to a clip or a past broadcast.";
    if (/Unsupported URL/i.test(text)) return "That link doesn't go to a video Cutroom can read. Check it in your browser.";
    if (/(subscriber|members?[- ]only|private|log ?in|sign ?in|cookies)/i.test(text)) {
      return "That video needs an account to watch, and Cutroom can't sign in to sites.";
    }
    if (/(Unable to extract|Unexpected response|caused by|HTTP Error 403)/i.test(text)) {
      return 'The site may have changed how it works. Update yt-dlp and try again: winget upgrade yt-dlp.yt-dlp';
    }
    return text;
  }

  /** Spacing of ruler labels, in seconds, for a given zoom. */
  function tickStep(secondsPerPixel, minPixels = 72) {
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
    return steps.find((step) => step / secondsPerPixel >= minPixels) || 14400;
  }

  return { MIN_CLIP, parseTime, formatTime, parseRanges, splitUrls, sanitizeFilename, normalizeClip, buildExportPlan, sourceSpec, availableQualities, siteOf, friendlyError, tickStep };
});
