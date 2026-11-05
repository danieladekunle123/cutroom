<p align="center">
  <img src="build/icon.png" alt="Cutroom logo" width="96" height="96">
</p>

<h1 align="center">Cutroom</h1>

<p align="center">A Windows desktop app that cuts audio and video clips out of YouTube videos, TikTok videos and Twitch clips.</p>

## Getting started

Cutroom runs on 64-bit Windows.

1. [Download the latest release](https://github.com/danieladekunle123/cutroom/releases/latest) and extract the whole zip.
2. Install `yt-dlp` and `ffmpeg`, which Cutroom uses to download and cut video:

   ```
   winget install yt-dlp.yt-dlp
   winget install Gyan.FFmpeg
   ```

3. Open `Cutroom.exe` in the extracted folder.

The app isn't code-signed, so Windows may show "Windows protected your PC" the first time. To open it anyway, choose **More info**, then **Run anyway**.

If links stop loading, update yt-dlp first, since these sites change often:

```
winget upgrade yt-dlp.yt-dlp
```

## How to use it

1. Paste one or more YouTube, TikTok or Twitch links. You can also drop a link anywhere on the window.
2. Mark clips any of these ways:
   - drag across the waveform
   - press `I` for the start and `O` for the end while it plays
   - type times in the Clips box, like `0:13-0:27, 0:38-0:50`
3. Drag a clip's edges or middle to adjust it, or type exact times in its row. Drag the dots in a row to change the order.
4. Choose Video MP4 or Audio MP3, and Separate files or Merge into one. Press Preview to hear the merged order.
5. Press Export. Files go to `Downloads\Cutroom` unless you pick another folder. An existing file is never overwritten.

## Keyboard

| Key | Does |
| --- | --- |
| Space | Play or pause |
| I / O | Mark a clip's start / end |
| Left / Right | Move 1 second (hold Shift for 5) |
| Delete | Delete the selected clip |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Esc | Clear the selection |
| Mouse wheel on the timeline | Zoom (hold Shift to scroll) |

## Where things are stored

Your videos, clips and downloaded files live in `%LOCALAPPDATA%\Cutroom`, separate from the app. Press Clear under the video list to delete full-quality downloads. Removing a video deletes all of its stored files. Exported files are never touched.

Private, age-restricted and subscriber-only videos won't load, because Cutroom can't sign in to sites.

YouTube, TikTok and Twitch logos are trademarks of their owners and are only used to show which sites work. Their shapes come from Simple Icons.

## Building from source

You'll need [Node.js](https://nodejs.org), plus `yt-dlp` and `ffmpeg` as above. Download this repo, open a terminal in its folder, and run:

```
npm install
npm start
```

To build an app you can open without a terminal, run `npm run package`. It creates `dist\Cutroom-win32-x64\Cutroom.exe`.

## Running the tests

```
npm test
```
