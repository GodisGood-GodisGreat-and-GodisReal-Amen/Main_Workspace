'use strict';

const path = require('path');

const DEMO_APPS = [
  'Safari', 'Mail', 'Music', 'Photos', 'Messages', 'Calendar',
  'Notes', 'Maps', 'Finder', 'Terminal', 'System Settings', 'App Store',
].map((name) => ({ id: name, name }));

// A gentle Frutiger-flavored test card, streamed as an SVG data URL so the
// full-screen mode can be exercised without a Mac (dev server, e2e tests).
function demoFrame(n) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600">
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#bfe6ff"/><stop offset=".6" stop-color="#eaf6ff"/><stop offset="1" stop-color="#d8f3c8"/>
  </linearGradient></defs>
  <rect width="960" height="600" fill="url(#s)"/>
  <circle cx="${120 + (n * 37) % 720}" cy="${180 + (n * 23) % 240}" r="46" fill="#fff" opacity=".55"/>
  <circle cx="${760 - (n * 29) % 640}" cy="${420 - (n * 17) % 300}" r="28" fill="#fff" opacity=".45"/>
  <text x="480" y="284" text-anchor="middle" font-family="sans-serif" font-size="40" fill="#1266a8">Demo screen (stub adapter)</text>
  <text x="480" y="336" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#476982">frame ${n} — the real Mac app streams the actual display here</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// Host adapter used on Linux dev machines and in tests. Mirrors the interface
// of src/main/mac-adapter.js without touching Electron or macOS APIs.
function createStubAdapter(options = {}) {
  let clipboardText = '';
  let screenTimer = null;
  let frameNo = 0;
  return {
    platform: options.platform || process.platform,
    getClipboard: () => clipboardText,
    setClipboard: (text) => { clipboardText = String(text); },
    input: async () => ({
      ok: false,
      message: 'Remote control requires the macOS host app',
    }),
    listApps: async () => DEMO_APPS,
    startScreen(onFrame) {
      if (screenTimer) return;
      const tick = () => onFrame({ dataUrl: demoFrame(frameNo++), w: 960, h: 600, ts: Date.now() });
      tick();
      screenTimer = setInterval(tick, options.frameIntervalMs || 800);
    },
    stopScreen() {
      clearInterval(screenTimer);
      screenTimer = null;
    },
    getStorageDir: () =>
      options.storageDir || path.join(process.cwd(), 'received-files'),
  };
}

module.exports = { createStubAdapter };
