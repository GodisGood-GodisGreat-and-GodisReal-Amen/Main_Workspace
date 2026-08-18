#!/usr/bin/env node
'use strict';

// Headless dev entry: runs the AeroLink server with the stub adapter so the
// whole app can be exercised on Linux (or any machine) without Electron.
const { createAeroServer } = require('../src/server/server');
const { createStubAdapter } = require('../src/server/stub-adapter');

const port = Number(process.env.PORT || 8890);
const server = createAeroServer({
  port,
  adapter: createStubAdapter(),
  log: (...args) => console.log('[aerolink]', ...args),
});

server.listen().then(({ port: actualPort, lanUrl }) => {
  console.log('');
  console.log('  AeroLink dev server (stub adapter — no macOS features)');
  console.log(`  Host UI:   http://127.0.0.1:${actualPort}/?role=host&hostToken=${server.hostToken}`);
  console.log(`  Phone URL: ${lanUrl}/?token=${server.pairingToken}`);
  console.log(`  Pairing token: ${server.pairingToken}`);
  console.log('');
}).catch((err) => {
  console.error('failed to start:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => server.stop().then(() => process.exit(0)));
