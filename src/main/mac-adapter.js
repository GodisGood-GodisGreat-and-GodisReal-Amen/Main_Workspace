'use strict';

// Host adapter for macOS: Electron clipboard + osascript-driven input,
// /Applications scan for the launcher, desktopCapturer for the live screen.
// Interface mirrors src/server/stub-adapter.js.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { clipboard, desktopCapturer, screen } = require('electron');
const { createMacInput } = require('./mac-input');

const APP_DIRS = ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
const APPS_CACHE_MS = 30000;
const FRAME_INTERVAL_MS = 650;
const FRAME_WIDTH = 1024;
const JPEG_QUALITY = 55;

function createMacAdapter() {
  const macInput = createMacInput({
    getScreenSize: () => screen.getPrimaryDisplay().size,
  });

  let appsCache = { at: 0, list: [] };
  let screenTimer = null;
  let capturing = false;

  async function listApps() {
    if (Date.now() - appsCache.at < APPS_CACHE_MS) return appsCache.list;
    const names = new Set();
    for (const dir of APP_DIRS) {
      let entries = [];
      try {
        entries = await fs.promises.readdir(dir);
      } catch {
        continue; // dir may not exist (e.g. ~/Applications)
      }
      for (const entry of entries) {
        if (entry.endsWith('.app') && !entry.startsWith('.')) names.add(entry.slice(0, -4));
      }
    }
    const list = [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ id: name, name }));
    appsCache = { at: Date.now(), list };
    return list;
  }

  function startScreen(onFrame) {
    if (screenTimer) return;
    const capture = async () => {
      if (capturing) return; // never queue captures behind a slow one
      capturing = true;
      try {
        const { size } = screen.getPrimaryDisplay();
        const height = Math.round((FRAME_WIDTH / size.width) * size.height);
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: FRAME_WIDTH, height },
        });
        const source = sources[0];
        if (source && !source.thumbnail.isEmpty()) {
          const jpeg = source.thumbnail.toJPEG(JPEG_QUALITY);
          onFrame({
            dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
            w: size.width,
            h: size.height,
            ts: Date.now(),
          });
        }
      } catch {
        // missing Screen Recording permission — keep trying quietly; macOS
        // shows its own prompt the first time and frames flow once granted
      } finally {
        capturing = false;
      }
    };
    capture();
    screenTimer = setInterval(capture, FRAME_INTERVAL_MS);
  }

  function stopScreen() {
    clearInterval(screenTimer);
    screenTimer = null;
  }

  return {
    platform: 'darwin',
    getClipboard: () => clipboard.readText(),
    setClipboard: (text) => clipboard.writeText(String(text)),
    input: (msg) => macInput.handle(msg),
    listApps,
    startScreen,
    stopScreen,
    getStorageDir: () => path.join(os.homedir(), 'Downloads', 'AeroLink'),
  };
}

module.exports = { createMacAdapter };
