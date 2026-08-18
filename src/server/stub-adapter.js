'use strict';

const path = require('path');

// Host adapter used on Linux dev machines and in tests. Mirrors the interface
// of src/main/mac-adapter.js without touching Electron or macOS APIs.
function createStubAdapter(options = {}) {
  let clipboardText = '';
  return {
    platform: options.platform || process.platform,
    getClipboard: () => clipboardText,
    setClipboard: (text) => { clipboardText = String(text); },
    input: async () => ({
      ok: false,
      message: 'Remote control requires the macOS host app',
    }),
    getStorageDir: () =>
      options.storageDir || path.join(process.cwd(), 'received-files'),
  };
}

module.exports = { createStubAdapter };
