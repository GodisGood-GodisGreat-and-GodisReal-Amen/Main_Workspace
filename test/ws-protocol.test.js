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

async function startServer() {
  const server = createAeroServer({
    port: 0,
    adapter: createStubAdapter({ storageDir: tmpDir() }),
  });
  const { port } = await server.listen();
  return { server, wsUrl: `ws://127.0.0.1:${port}` };
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
