const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const tools = require('./tools');
const media = require('./media');
const { friendlyError } = require('../shared/logic');

// Keep data outside the app's folder and out of the roaming profile: previews can be large.
const dataDir = process.env.CUTROOM_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Cutroom');
app.setPath('userData', dataDir);
const cacheRoot = path.join(dataDir, 'videos');
const libraryFile = path.join(dataDir, 'library.json');

let mainWindow = null;
let prepareQueue = Promise.resolve();

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1240,
    minHeight: 720,
    backgroundColor: '#000000',
    title: 'Cutroom',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#ffffff', height: 52 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Playback has to keep following the clips while another window is on top.
      backgroundThrottling: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function readableError(error) {
  if (error && error.cancelled) return { cancelled: true };
  return { error: friendlyError(error && error.message ? error.message : String(error)) };
}

/** Run a handler so failures arrive as { error } rather than Electron's wrapped exceptions. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: await fn(...args) };
    } catch (error) {
      return readableError(error);
    }
  });
}

function withPreviewUrl(prepared) {
  if (!prepared) return null;
  const { previewPath, ...rest } = prepared;
  return { ...rest, previewUrl: pathToFileURL(previewPath).href };
}

async function loadLibrary() {
  try {
    return JSON.parse(await fsp.readFile(libraryFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await fsp.rename(libraryFile, `${libraryFile}.broken`).catch(() => {});
    }
    return { videos: [], settings: {} };
  }
}

handle('tools:check', () => tools.checkTools());

handle('library:load', async () => {
  const library = await loadLibrary();
  return {
    videos: Array.isArray(library.videos) ? library.videos : [],
    settings: {
      kind: 'mp3',
      merge: false,
      quality: 'best',
      bitrate: 192,
      volume: 1,
      outDir: path.join(app.getPath('downloads'), 'Cutroom'),
      ...(library.settings || {}),
    },
  };
});

handle('library:save', async (library) => {
  await fsp.mkdir(dataDir, { recursive: true });
  const temp = `${libraryFile}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(library));
  await fsp.rename(temp, libraryFile);
});

handle('video:info', (url) => media.fetchInfo(String(url)));

handle('video:load', async (id) => withPreviewUrl(await media.loadPrepared(cacheRoot, id)));

handle('video:prepare', (video) => {
  const key = `prepare:${video.id}`;
  tools.clearCancel(key);
  // One at a time: parallel downloads get throttled and make every progress bar crawl.
  const work = prepareQueue.then(async () => {
    tools.throwIfCancelled(key);
    const prepared = await media.prepare({
      cacheRoot,
      video,
      key,
      onProgress: (stage, progress) => send('video:progress', { id: video.id, stage, progress }),
    });
    return withPreviewUrl(prepared);
  });
  prepareQueue = work.catch(() => {});
  return work;
});

handle('video:remove', async (id) => {
  tools.cancelJob(`prepare:${id}`);
  await media.removeVideoFiles(cacheRoot, id).catch(async () => {
    // A cancelled process can hold its file for a moment on Windows.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await media.removeVideoFiles(cacheRoot, id);
  });
});

handle('export:start', async (request) => {
  const key = 'export';
  tools.clearCancel(key);
  return media.exportClips({
    cacheRoot,
    request,
    key,
    onProgress: (progress) => send('export:progress', progress),
  });
});

handle('export:cancel', () => tools.cancelJob('export'));

handle('dialog:chooseFolder', async (current) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where exports are saved',
    defaultPath: current,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

handle('dialog:confirm', async ({ message, detail, action }) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    message,
    detail,
    buttons: [action, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
});

handle('shell:showFile', (file) => {
  if (fs.existsSync(file)) shell.showItemInFolder(file);
});

handle('cache:usage', () => media.directorySize(cacheRoot));
handle('cache:clear', () => media.clearSources(cacheRoot));

app.whenReady()
  .then(() => media.moveOldVideos(path.join(dataDir, 'cache'), cacheRoot))
  .then(createWindow);
app.on('window-all-closed', () => {
  tools.cancelJob('export');
  app.quit();
});
