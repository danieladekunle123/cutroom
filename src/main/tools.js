// Runs yt-dlp, ffmpeg and ffprobe as child processes, with cancellation by job key.
const { spawn, spawnSync } = require('node:child_process');

const INSTALL_HINT = {
  'yt-dlp': 'winget install yt-dlp.yt-dlp',
  ffmpeg: 'winget install Gyan.FFmpeg',
  ffprobe: 'winget install Gyan.FFmpeg',
};

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

const running = new Map(); // job key -> Set of child processes
const cancelledKeys = new Set();

function killTree(child) {
  if (!child.pid) return;
  // yt-dlp starts ffmpeg itself, so the whole process tree has to go.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

function cancelJob(key) {
  cancelledKeys.add(key);
  for (const child of running.get(key) || []) killTree(child);
}

function clearCancel(key) {
  cancelledKeys.delete(key);
}

function throwIfCancelled(key) {
  if (key && cancelledKeys.has(key)) throw new CancelledError();
}

function lastErrorLine(stderr) {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const flagged = [...lines].reverse().find((l) => l.startsWith('ERROR:'));
  return (flagged || lines[lines.length - 1] || 'Unknown error').replace(/^ERROR:\s*/, '');
}

/**
 * Run a tool. `onLine` receives stdout line by line; `onData` receives raw stdout chunks.
 * Resolves with { stdout } when it exits 0, rejects with a readable Error otherwise.
 */
function run(cmd, args, { key, onLine, onData, keepStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    try {
      throwIfCancelled(key);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (key) {
      if (!running.has(key)) running.set(key, new Set());
      running.get(key).add(child);
    }
    const forget = () => {
      if (!key || !running.has(key)) return;
      running.get(key).delete(child);
      if (running.get(key).size === 0) running.delete(key);
    };

    let stdout = '';
    let stderr = '';
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      if (onData) onData(chunk);
      if (keepStdout) stdout += chunk.toString('utf8');
      if (onLine) {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        lines.forEach(onLine);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8000);
    });
    child.on('error', (error) => {
      forget();
      if (error.code === 'ENOENT') {
        reject(new Error(`${cmd} isn't installed or isn't on your PATH. Install it with: ${INSTALL_HINT[cmd] || cmd}`));
      } else {
        reject(error);
      }
    });
    child.on('close', (code) => {
      forget();
      if (key && cancelledKeys.has(key)) reject(new CancelledError());
      else if (code === 0) resolve({ stdout });
      else reject(new Error(lastErrorLine(stderr)));
    });
  });
}

function versionOf(cmd) {
  const result = spawnSync(cmd, [cmd === 'yt-dlp' ? '--version' : '-version'], { windowsHide: true, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.split(/\r?\n/)[0].trim();
}

function checkTools() {
  return ['yt-dlp', 'ffmpeg', 'ffprobe']
    .filter((cmd) => !versionOf(cmd))
    .map((cmd) => ({ cmd, install: INSTALL_HINT[cmd] }));
}

module.exports = { run, cancelJob, clearCancel, throwIfCancelled, checkTools, CancelledError };
