// Regenerates the README screenshots (docs/*.jpg) against the stub adapter.
// Run: node scripts/screenshots.mjs   (set CHROMIUM_PATH if needed)

import { chromium } from 'playwright-core';
import { createRequire } from 'module';
import { mkdirSync, mkdtempSync } from 'fs';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { createAeroServer } = require('../src/server/server.js');
const { createStubAdapter } = require('../src/server/stub-adapter.js');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCS = path.join(ROOT, 'docs');
mkdirSync(DOCS, { recursive: true });

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const adapter = createStubAdapter({
  storageDir: mkdtempSync(path.join(tmpdir(), 'aerolink-shots-')),
  frameIntervalMs: 250,
});
const server = createAeroServer({ port: 0, adapter });
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const shot = (page, name) =>
  page.screenshot({ path: path.join(DOCS, name), type: 'jpeg', quality: 82 });

// host waits with the QR…
const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await host.goto(`${base}/?role=host&hostToken=${server.hostToken}`);
await host.waitForFunction(() => document.querySelector('#qr-img').src.startsWith('data:image/png'));
await shot(host, 'host-waiting.jpg');

// …the phone joins and the menu blossoms
const phone = await (await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36',
  hasTouch: true,
  isMobile: true,
})).newPage();
await phone.goto(`${base}/?token=${server.pairingToken}`);
await host.waitForSelector('body[data-state="menu"]');
await host.waitForTimeout(1600); // let the staggered tile entrance settle
await shot(host, 'host-menu.jpg');
await shot(phone, 'phone-menu.jpg');

// the full-screen remote mode, streaming stub frames
await phone.click('[data-tile="remote"]');
await phone.waitForSelector('#screen-img.live', { timeout: 5000 });
await shot(phone, 'phone-fullscreen.jpg');

await browser.close();
await server.stop();
console.log('Screenshots written to docs/');
