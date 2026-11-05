const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/shared/logic');

test('parseTime reads the formats people type', () => {
  assert.equal(L.parseTime('83'), 83);
  assert.equal(L.parseTime('83.5'), 83.5);
  assert.equal(L.parseTime('1:23'), 83);
  assert.equal(L.parseTime('1:23.25'), 83.25);
  assert.equal(L.parseTime('01:02:03'), 3723);
  for (const bad of ['', 'abc', '1:75', '1:2:3:4', '-5', '1::2']) assert.equal(L.parseTime(bad), null, bad);
});

test('formatTime carries rounding and shows hours only when needed', () => {
  assert.equal(L.formatTime(13), '0:13.00');
  assert.equal(L.formatTime(59.999), '1:00.00');
  assert.equal(L.formatTime(3723.5, 1), '1:02:03.5');
  assert.equal(L.formatTime(65, 0), '1:05');
});

test('parseRanges handles the list a person pastes', () => {
  const { ranges, errors } = L.parseRanges('0:13-0:27, 0:38-0:50, 0:52-0:56', 132);
  assert.deepEqual(ranges, [{ start: 13, end: 27 }, { start: 38, end: 50 }, { start: 52, end: 56 }]);
  assert.deepEqual(errors, []);
});

test('parseRanges clamps to the video and reports bad pieces', () => {
  const { ranges, errors } = L.parseRanges('2:00-9:00; 5-3\n9:00-9:10\nnonsense', 132);
  assert.deepEqual(ranges, [{ start: 120, end: 132 }]);
  assert.equal(errors.length, 3);
});

test('splitUrls finds links, adds https to bare youtube links, removes duplicates', () => {
  const { urls, invalid } = L.splitUrls('https://youtu.be/abc youtube.com/watch?v=x\nhttps://youtu.be/abc file:///c:/x hello');
  assert.deepEqual(urls, ['https://youtu.be/abc', 'https://youtube.com/watch?v=x']);
  assert.deepEqual(invalid, ['file:///c:/x', 'hello']);
});

test('sanitizeFilename removes what Windows rejects', () => {
  assert.equal(L.sanitizeFilename('a/b:c*d?"e<f>|g\\h.'), 'a b c d e f g h');
  assert.equal(L.sanitizeFilename('CON'), '_CON');
  assert.equal(L.sanitizeFilename('   ', 'Clip 1'), 'Clip 1');
  assert.ok(L.sanitizeFilename('x'.repeat(500)).length <= 100);
});

test('normalizeClip clamps to the video and rejects clips that cannot fit', () => {
  assert.deepEqual(L.normalizeClip({ name: 'a', start: 10, end: 500 }, 132), { name: 'a', start: 10, end: 132 });
  assert.equal(L.normalizeClip({ start: 132, end: 140 }, 132), null);
  assert.equal(L.normalizeClip({ start: -1, end: 5 }, 132), null);
  assert.equal(L.normalizeClip({ start: 'x', end: 5 }, 132), null);
});

const clips = [{ name: 'Intro', start: 13, end: 27 }, { name: 'Fight', start: 38, end: 50 }];
const both = { path: 'in.mkv', hasVideo: true, hasAudio: true };

test('separate export makes one job per clip with accurate seeks', () => {
  const jobs = L.buildExportPlan({ source: both, clips, kind: 'mp4', merge: false, baseName: 'My: video' });
  assert.deepEqual(jobs.map((j) => j.fileName), ['My video - Intro.mp4', 'My video - Fight.mp4']);
  assert.deepEqual(jobs.map((j) => j.duration), [14, 12]);
  const args = jobs[1].args('out.mp4');
  assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-i') + 2), ['-ss', '38', '-t', '12', '-i', 'in.mkv']);
  assert.ok(args.includes('libx264'));
  assert.equal(args.at(-1), 'out.mp4');
});

test('merged export joins every clip in list order', () => {
  const [job, ...rest] = L.buildExportPlan({ source: both, clips, kind: 'mp4', merge: true, baseName: 'V' });
  assert.equal(rest.length, 0);
  assert.equal(job.fileName, 'V - merged.mp4');
  assert.equal(job.duration, 26);
  const args = job.args('o.mp4');
  assert.equal(args[args.indexOf('-filter_complex') + 1], '[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]');
});

test('merged MP3 uses audio only at the chosen bitrate', () => {
  const [job] = L.buildExportPlan({ source: both, clips, kind: 'mp3', merge: true, baseName: 'V', bitrate: 320 });
  const args = job.args('o.mp3');
  assert.equal(args[args.indexOf('-filter_complex') + 1], '[0:a:0][1:a:0]concat=n=2:v=0:a=1[a]');
  assert.equal(args[args.indexOf('-b:a') + 1], '320k');
  assert.ok(!args.includes('libx264'));
  assert.ok(!args.includes('[v]'));
});

test('merge with one clip is a plain cut', () => {
  const jobs = L.buildExportPlan({ source: both, clips: clips.slice(0, 1), kind: 'mp3', merge: true, baseName: 'V' });
  assert.equal(jobs[0].fileName, 'V - Intro.mp3');
  assert.ok(!jobs[0].args('o').includes('-filter_complex'));
});

test('clips sharing a name get distinct files', () => {
  const same = [{ name: 'A', start: 0, end: 1 }, { name: 'a', start: 2, end: 3 }];
  const names = L.buildExportPlan({ source: both, clips: same, kind: 'mp3', merge: false, baseName: 'V' }).map((j) => j.fileName);
  assert.deepEqual(names, ['V - A.mp3', 'V - a (2).mp3']);
});

test('videos without audio or video still build the right streams', () => {
  const silent = { path: 'in', hasVideo: true, hasAudio: false };
  assert.throws(() => L.buildExportPlan({ source: silent, clips, kind: 'mp3', merge: false, baseName: 'V' }), /no audio/);
  const [job] = L.buildExportPlan({ source: silent, clips, kind: 'mp4', merge: true, baseName: 'V' });
  const args = job.args('o.mp4');
  assert.equal(args[args.indexOf('-filter_complex') + 1], '[0:v:0][1:v:0]concat=n=2:v=1:a=0[v]');
});

test('sourceSpec picks a cache file per quality', () => {
  assert.equal(L.sourceSpec('mp3', 720).stem, 'audio');
  assert.equal(L.sourceSpec('mp4', 'best').stem, 'source_best');
  assert.equal(L.sourceSpec('mp4', 720).stem, 'source_720');
  assert.equal(L.sourceSpec('mp4', 720).sort, 'res:720');
  assert.equal(L.sourceSpec('mp4', 'best').sort, undefined);
});

test('splitUrls adds https to bare TikTok and Twitch links', () => {
  const { urls, invalid } = L.splitUrls('tiktok.com/@a/video/1 vm.tiktok.com/x clips.twitch.tv/y www.twitch.tv/z/clip/w');
  assert.deepEqual(urls, ['https://tiktok.com/@a/video/1', 'https://vm.tiktok.com/x', 'https://clips.twitch.tv/y', 'https://www.twitch.tv/z/clip/w']);
  assert.deepEqual(invalid, []);
});

test('availableQualities names vertical video by its short side', () => {
  const tiktok = [{ width: 1080, height: 1920, vcodec: 'h265' }, { width: 720, height: 1280, vcodec: 'h264' }, { vcodec: 'none', height: 90, width: 160 }, { format_id: 'audio', vcodec: 'none' }];
  assert.deepEqual(L.availableQualities(tiktok), [1080, 720]);
});

test('availableQualities counts formats with no reported codec', () => {
  assert.deepEqual(L.availableQualities([{ height: 360 }, { height: 1080 }, { height: 720 }]), [1080, 720, 360]);
  assert.deepEqual(L.availableQualities(undefined), []);
});

test('siteOf recognises the three sites and nothing else', () => {
  const cases = {
    'https://www.youtube.com/watch?v=a': 'youtube', 'https://youtu.be/a': 'youtube', 'https://music.youtube.com/watch?v=a': 'youtube',
    'https://www.tiktok.com/@a/video/1': 'tiktok', 'https://vm.tiktok.com/x': 'tiktok',
    'https://clips.twitch.tv/x': 'twitch', 'https://www.twitch.tv/videos/1': 'twitch',
    'https://nottiktok.com/x': null, 'https://youtube.com.evil.example/x': null, 'not a link': null,
  };
  for (const [url, site] of Object.entries(cases)) assert.equal(L.siteOf(url), site, url);
});

test('friendlyError explains the errors sites give', () => {
  assert.match(L.friendlyError('[TikTok] 111: Your IP address is blocked from accessing this post'), /deleted or private/);
  assert.match(L.friendlyError('[twitch:stream] twitch: The channel is not currently live'), /channel page/);
  assert.match(L.friendlyError('Unsupported URL: https://www.tiktok.com/?_r=1'), /doesn't go to a video/);
  assert.match(L.friendlyError('This video is private'), /needs an account/);
  assert.match(L.friendlyError('Unable to extract universal data for rehydration'), /winget upgrade/);
  assert.equal(L.friendlyError('[twitch:clips] x: This clip is no longer available'), '[twitch:clips] x: This clip is no longer available');
  assert.match(L.friendlyError("yt-dlp isn't installed or isn't on your PATH. Install it with: winget install yt-dlp.yt-dlp"), /isn't installed/);
});

test('tickStep gives readable label spacing', () => {
  assert.equal(L.tickStep(0.1), 10);
  assert.equal(L.tickStep(1), 120);
});
