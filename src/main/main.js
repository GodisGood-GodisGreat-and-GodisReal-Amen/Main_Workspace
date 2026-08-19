'use strict';

// AeroLink Electron entry: start the embedded server, open the host window,
// and (on macOS) watch for USB devices via adb.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { createAeroServer } = require('../server/server');
const { createStubAdapter } = require('../server/stub-adapter');
const { createAdbWatcher } = require('./adb');

const BASE_PORT = 8890;

let mainWindow = null;
let server = null;
let adb = null;

async function startServer() {
  const adapter =
    process.platform === 'darwin'
      ? require('./mac-adapter').createMacAdapter()
      : createStubAdapter(); // lets `npm start` run on Linux/Windows for dev
  // retry once on a busy port; the QR always encodes the real port
  for (const port of [BASE_PORT, BASE_PORT + 1]) {
    server = createAeroServer({ port, adapter, log: console.log });
    try {
      const { port: actualPort } = await server.listen();
      return actualPort;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`ports ${BASE_PORT} and ${BASE_PORT + 1} are both in use`);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: 'AeroLink',
    backgroundColor: '#eaf6ff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/?hostToken=${server.hostToken}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    const port = await startServer();
    createWindow(port);
    adb = createAdbWatcher({
      port,
      pairingToken: server.pairingToken,
      onStatus: (status) => server.hub.broadcastToHosts(status),
    });
    adb.start();
  } catch (err) {
    console.error('AeroLink failed to start:', err.message);
    app.quit();
  }

  app.on('activate', () => {
    if (!mainWindow && server) createWindow(server.httpServer.address().port);
  });
});

app.on('window-all-closed', () => {
  // keep serving while the phone is linked? No — quitting the app ends the
  // session everywhere, which is the least surprising behavior.
  app.quit();
});

app.on('will-quit', () => {
  if (adb) adb.stop();
  if (server) server.stop();
});
