'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createAeroServer } = require('../src/server/server');
const { createStubAdapter } = require('../src/server/stub-adapter');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aerolink-ws-'));
}

async function startServer(adapterOptions = {}) {
  const adapter = createStubAdapter({ storageDir: tmpDir(), ...adapterOptions });
  const server = createAeroServer({ port: 0, adapter });
  const { port } = await server.listen();
  return { server, adapter, wsUrl: `ws://127.0.0.1:${port}` };
}

function connect(wsUrl, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const messages = [];
    const waiters = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...hello })));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const idx = waiters.findIndex((w) => w.match(msg));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
      else messages.push(msg);
    });
    ws.on('error', reject);
    const client = {
      ws,
      messages,
      next(match = () => true, timeoutMs = 3000) {
        const buffered = messages.findIndex(match);
        if (buffered >= 0) return Promise.resolve(messages.splice(buffered, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timeout waiting for message')), timeoutMs);
          waiters.push({ match, resolve: (m) => { clearTimeout(timer); res(m); } });
        });
      },
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
    };
    client.next((m) => m.type === 'hello-ack' || m.type === 'error').then((ack) => resolve({ ...client, ack }));
  });
}

test('hello with a bad token is rejected with close 4001', async () => {
  const { server, wsUrl } = await startServer();
  const ws = new WebSocket(wsUrl);
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'phone-client', token: 'nope' })));
  assert.equal(await closed, 4001);
  await server.stop();
});

test('phone join/leave fans presence out to the host', async () => {
  const { server, wsUrl } = await startServer();
  const host = await connect(wsUrl, { role: 'mac-host', token: server.hostToken, device: { name: 'Mac' } });
  assert.equal(host.ack.type, 'hello-ack');
  assert.equal(host.ack.role, 'mac-host');

  const phone = await connect(wsUrl, {
    role: 'phone-client',
    token: server.pairingToken,
    device: { name: 'Pixel 8' },
  });
  const joined = await host.next((m) => m.type === 'presence' && m.phones.length === 1);
  assert.equal(joined.phones[0].name, 'Pixel 8');
  assert.equal(joined.phones[0].transport, 'usb'); // loopback and not the host

  phone.close();
  const left = await host.next((m) => m.type === 'presence' && m.phones.length === 0);
  assert.equal(left.hostConnected, true);
  host.close();
  await server.stop();
});

test('a phone impersonating mac-host with the pairing token is rejected', async () => {
  const { server, wsUrl } = await startServer();
  const impostor = await connect(wsUrl, { role: 'mac-host', token: server.pairingToken });
  assert.equal(impostor.ack.type, 'error');
  assert.equal(impostor.ack.code, 'bad-token');
  await server.stop();
});

test('clipboard-set writes the adapter clipboard and notifies the other role', async () => {
  const { server, wsUrl } = await startServer();
  const host = await connect(wsUrl, { role: 'mac-host', token: server.hostToken });
  const phone = await connect(wsUrl, { role: 'phone-client', token: server.pairingToken });
  await host.next((m) => m.type === 'presence' && m.phones.length === 1);

  phone.send({ type: 'clipboard-set', text: 'beam me up' });
  const update = await host.next((m) => m.type === 'clipboard-update');
  assert.equal(update.text, 'beam me up');
  assert.equal(update.from, 'phone');

  // and clipboard-get reads it back from the stub
  phone.send({ type: 'clipboard-get' });
  const readback = await phone.next((m) => m.type === 'clipboard-update');
  assert.equal(readback.text, 'beam me up');
  host.close();
  phone.close();
  await server.stop();
});

test('device-info is forwarded to the host', async () => {
  const { server, wsUrl } = await startServer();
  const host = await connect(wsUrl, { role: 'mac-host', token: server.hostToken });
  const phone = await connect(wsUrl, { role: 'phone-client', token: server.pairingToken });
  phone.send({ type: 'device-info', info: { battery: { level: 0.8, charging: true } } });
  const update = await host.next((m) => m.type === 'device-info-update');
  assert.equal(update.info.battery.level, 0.8);
  host.close();
  phone.close();
  await server.stop();
});

test('input on a non-mac host returns a friendly failure', async () => {
  const { server, wsUrl } = await startServer();
  const phone = await connect(wsUrl, { role: 'phone-client', token: server.pairingToken });
  phone.send({ type: 'input', kind: 'text', text: 'hi' });
  const result = await phone.next((m) => m.type === 'input-result');
  assert.equal(result.ok, false);
  assert.match(result.message, /macOS/);
  phone.close();
  await server.stop();
});

test('unknown input kinds are rejected as bad-message', async () => {
  const { server, wsUrl } = await startServer();
  const phone = await connect(wsUrl, { role: 'phone-client', token: server.pairingToken });
  phone.send({ type: 'input', kind: 'explode' });
  const err = await phone.next((m) => m.type === 'error');
  assert.equal(err.code, 'bad-message');
  phone.close();
  await server.stop();
});

test('launch and click-at are valid input kinds (stub reports macOS-only)', async () => {
  const { server, wsUrl } = await startServer();
  const phone = await connect(wsUrl, { role: 'phone-client', token: server.pairingToken });
  phone.send({ type: 'input', kind: 'launch', app: 'Safari' });
  const launched = await phone.next((m) => m.type === 'input-result');
  assert.equal(launched.ok, false);
  assert.match(launched.message, /macOS/);
  phone.send({ type: 'input', kind: 'click-at', nx: 0.5, ny: 0.5 });
  const clicked = await phone.next((m) => m.type === 'input-result');
  assert.equal(clicked.ok, false); // routed to the adapter, not rejected as bad-message
  phone.close();
  await server.stop();
});

test('apps-get returns the adapter app list', async () => {
  const { server, wsUrl } = await startServer();
  const phone = await connect(wsUrl, { role: 'phone-client', token: server.pairingToken });
  phone.send({ type: 'apps-get' });
  const list = await phone.next((m) => m.type === 'apps-list');
  assert.ok(Array.isArray(list.apps) && list.apps.length > 0);
  assert.ok(list.apps.every((a) => a.id && a.name));
  phone.close();
  await server.stop();
});

test('screen-start streams frames and screen-stop ends the stream', async () => {
  const { server, wsUrl } = await startServer({ frameIntervalMs: 60 });
  const phone = await connect(wsUrl, { role: 'phone-client', token: server.pairingToken });

  phone.send({ type: 'screen-start' });
  const frame = await phone.next((m) => m.type === 'screen-frame');
  assert.match(frame.dataUrl, /^data:image\//);
  assert.ok(frame.w > 0 && frame.h > 0);

  phone.send({ type: 'screen-stop' });
  await new Promise((r) => setTimeout(r, 150)); // let in-flight frames drain
  phone.messages.length = 0;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(phone.messages.filter((m) => m.type === 'screen-frame').length, 0);
  phone.close();
  await server.stop();
});

test('a Mac clipboard change is pushed to the phone automatically', async () => {
  const { server, adapter, wsUrl } = await startServer();
  const phone = await connect(wsUrl, { role: 'phone-client', token: server.pairingToken });
  adapter.setClipboard('copied on the mac'); // as if the user pressed cmd-C
  const update = await phone.next((m) => m.type === 'clipboard-update', 4000);
  assert.equal(update.text, 'copied on the mac');
  assert.equal(update.from, 'mac');
  phone.close();
  await server.stop();
});
