'use strict';

// The Electron renderer is just another web client of the local server; the
// only thing it needs to know natively is that it IS the host window.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('aeroHost', { isElectronHost: true });
