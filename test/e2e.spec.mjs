// End-to-end check of the signature flow: the host waits with a QR code, a
// phone joins, the host transforms into the Frutiger Aero menu, the phone
// renders the simplified single-column layout, and disconnecting reverts the
// host. Uses playwright-core with a system Chromium — set CHROMIUM_PATH or
// rely on the Claude Code default install location.
//
// Run: npm run test:e2e   (screenshots land in test/artifacts/)

import { chromium } from 'playwright-core';
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const { createAeroServer } = require('../src/server/server.js');
const { createStubAdapter } = require('../src/server/stub-adapter.js');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(ROOT, 'artifacts');
mkdirSync(ART, { recursive: true });

const CHROMIUM =
  process.env.CHROMIUM_PATH ||
  '/opt/pw-browsers/chromium';

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? '  ok' : 'FAIL'} - ${label}`);
  if (!ok) failures++;
}

const server = createAeroServer({
  port: 0,
  adapter: createStubAdapter({ storageDir: path.join(ART, 'store') }),
});
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });

// --- host: desktop viewport, waiting scene with QR ---
const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const host = await hostCtx.newPage();
await host.goto(`${base}/?role=host&hostToken=${server.hostToken}`);
await host.waitForSelector('body[data-state="waiting"]');
await host.waitForFunction(() => document.querySelector('#qr-img').src.startsWith('data:image/png'));
check('host boots into the waiting scene with a QR code', true);
const hostCols = await host.$eval('#menu-grid', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
await host.screenshot({ path: path.join(ART, 'host-waiting.png') });

// --- phone: Android-like context joins with the pairing token ---
const phoneCtx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36',
  hasTouch: true,
  isMobile: true,
});
const phone = await phoneCtx.newPage();
await phone.goto(`${base}/?token=${server.pairingToken}`);
await phone.waitForSelector('body[data-state="menu"]', { timeout: 5000 });
check('phone lands in the menu', true);

// --- the transformation ---
try {
  await host.waitForSelector('body[data-state="menu"]', { timeout: 3000 });
  check('host transforms to the menu within 3s of the phone joining', true);
} catch {
  check('host transforms to the menu within 3s of the phone joining', false);
}
await host.waitForTimeout(1500); // let the staggered tile entrance finish
await host.screenshot({ path: path.join(ART, 'host-menu.png') });
await phone.screenshot({ path: path.join(ART, 'phone-menu.png') });

// --- responsive: desktop grid vs simplified single column ---
const phoneCols = await phone.$eval('#menu-grid', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
check(`desktop menu is a multi-column grid (${hostCols} cols)`, hostCols > 1);
check('phone menu is a single column', phoneCols === 1);

// --- clipboard round trip through the stub adapter ---
await phone.click('[data-tile="clipboard"]');
await phone.waitForSelector('body[data-state="view"]');
await phone.fill('#clip-text', 'aero e2e clipboard');
await phone.click('#clip-send');
await host.click('[data-tile="clipboard"]');
await host.waitForSelector('body[data-state="view"]');
await host.click('#clip-fetch');
try {
  await host.waitForFunction(
    () => document.querySelector('#clip-text').value === 'aero e2e clipboard',
    { timeout: 3000 }
  );
  check('clipboard round-trips phone -> mac -> host view', true);
} catch {
  check('clipboard round-trips phone -> mac -> host view', false);
}

// --- remote control surfaces the non-mac stub message ---
await phone.click('#back-btn');
await phone.click('[data-tile="remote"]');
await phone.click('[data-key="return"]');
await phone.waitForSelector('.remote-note.show');
const note = await phone.$eval('.remote-note', (n) => n.textContent);
check('remote input reports the macOS-only message', /macOS/.test(note));

// --- disconnect: host reverts to waiting after the grace period ---
await phoneCtx.close();
try {
  await host.waitForSelector('body[data-state="waiting"]', { timeout: 8000 });
  check('host reverts to waiting after the phone leaves', true);
} catch {
  check('host reverts to waiting after the phone leaves', false);
}

await browser.close();
await server.stop();

if (failures) {
  console.error(`\n${failures} e2e check(s) failed`);
  process.exit(1);
}
console.log('\nAll e2e checks passed. Screenshots: test/artifacts/');
