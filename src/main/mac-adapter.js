'use strict';

// Host adapter for macOS: Electron clipboard + osascript-driven input.
// Interface mirrors src/server/stub-adapter.js.

const os = require('os');
const path = require('path');
const { clipboard } = require('electron');
const { createMacInput } = require('./mac-input');

function createMacAdapter() {
  const macInput = createMacInput();
  return {
    platform: 'darwin',
    getClipboard: () => clipboard.readText(),
    setClipboard: (text) => clipboard.writeText(String(text)),
    input: (msg) => macInput.handle(msg),
    getStorageDir: () => path.join(os.homedir(), 'Downloads', 'AeroLink'),
  };
}

module.exports = { createMacAdapter };
