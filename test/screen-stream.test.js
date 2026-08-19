'use strict';

// Low-bandwidth screen streaming: ack pacing (latest frame wins), identical-
// frame dedup, the pinned eco profile, and the legacy firehose for clients
// that never ack.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createAeroServer } = require('../src/server/server');
const { createStubAdapter } = require('../src/server/stub-adapter');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aerolink-screen-'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Adapter whose frames are emitted by hand, recording profile switches.
function manualAdapter() {
  let cb = null;
  const profileCalls = [];
  const adapter = {
    platform: 'test',
    getClipboard: () => '',
    setClipboard: () => {},
    input: async () => ({ ok: true }),
    listApps: async () => [],
    startScreen(onFrame) { cb = onFrame; },
    stopScreen() { cb = null; },
    setScreenProfile(p) { profileCalls.push(p); },
    getStorageDir: () => tmpDir(),
  };
  return { adapter, emit: (frame) => cb && cb(frame), profileCalls };
}

const isFrame = (m) => m.type === 'screen-frame';

test('an acking client is paced: stale frames are dropped, the latest wins', async () => {
  const adapter = createStubAdapter({ storageDir: tmpDir(), frameIntervalMs: 50 });
  const server = createAeroServer({ port: 0, adapter });
  const { port } = await server.listen();
  const phone = await connect(`ws://127.0.0.1:${port}`, { role: 'phone-client', token: server.pairingToken });

  phone.send({ type: 'screen-start' });
  const first = await phone.next(isFrame);
  phone.send({ type: 'screen-ack', seq: first.seq }); // pacing engages here

  const second = await phone.next(isFrame);
  assert.equal(second.seq, first.seq + 1);

  // hold the ack while ~10 frames are produced — none may be delivered
  await sleep(500);
  assert.equal(phone.messages.filter(isFrame).length, 0);

  // the ack releases exactly one frame: the newest, not the backlog
  phone.send({ type: 'screen-ack', seq: second.seq });
  const third = await phone.next(isFrame);
  assert.ok(third.seq - second.seq >= 3, `expected a seq gap, got ${second.seq} -> ${third.seq}`);
  await sleep(150);
  assert.equal(phone.messages.filter(isFrame).length, 0, 'only the latest pending frame is sent');

  phone.close();
  await server.stop();
});

test('a legacy client that never acks still gets the plain stream', async () => {
  const adapter = createStubAdapter({ storageDir: tmpDir(), frameIntervalMs: 50 });
  const server = createAeroServer({ port: 0, adapter });
  const { port } = await server.listen();
  const phone = await connect(`ws://127.0.0.1:${port}`, { role: 'phone-client', token: server.pairingToken });

  phone.send({ type: 'screen-start' });
  const seqs = [];
  for (let i = 0; i < 4; i++) seqs.push((await phone.next(isFrame)).seq);
  assert.deepEqual(seqs, [seqs[0], seqs[0] + 1, seqs[0] + 2, seqs[0] + 3]);

  phone.close();
  await server.stop();
});

test('identical frames are deduplicated to zero bytes', async () => {
  const { adapter, emit } = manualAdapter();
  const server = createAeroServer({ port: 0, adapter });
  const { port } = await server.listen();
  const phone = await connect(`ws://127.0.0.1:${port}`, { role: 'phone-client', token: server.pairingToken });

  phone.send({ type: 'screen-start' });
  await sleep(50); // let screen-start register before emitting
  emit({ dataUrl: 'data:image/png;base64,AAAA', w: 10, h: 10, ts: 1 });
  emit({ dataUrl: 'data:image/png;base64,AAAA', w: 10, h: 10, ts: 2 });
  emit({ dataUrl: 'data:image/png;base64,AAAA', w: 10, h: 10, ts: 3 });
  emit({ dataUrl: 'data:image/png;base64,BBBB', w: 10, h: 10, ts: 4 });

  const a = await phone.next(isFrame);
  const b = await phone.next(isFrame);
  assert.ok(a.dataUrl.endsWith('AAAA'));
  assert.ok(b.dataUrl.endsWith('BBBB'));
  await sleep(150);
  assert.equal(phone.messages.filter(isFrame).length, 0, 'the two repeats must not be sent');

  phone.close();
  await server.stop();
});

test('screen-profile eco pins the lowest rung and frames say so', async () => {
  const { adapter, emit, profileCalls } = manualAdapter();
  const server = createAeroServer({ port: 0, adapter });
  const { port } = await server.listen();
  const phone = await connect(`ws://127.0.0.1:${port}`, { role: 'phone-client', token: server.pairingToken });

  phone.send({ type: 'screen-start' });
  phone.send({ type: 'screen-profile', mode: 'eco' });
  await sleep(50);

  const eco = profileCalls.find((p) => p.name === 'eco');
  assert.ok(eco, 'adapter must be switched to the eco profile');
  assert.ok(eco.width < 800 && eco.quality < 45, 'eco captures smaller, lighter frames');

  emit({ dataUrl: 'data:image/png;base64,CCCC', w: 10, h: 10, ts: 1 });
  const frame = await phone.next(isFrame);
  assert.equal(frame.profile, 'eco');

  // back to auto: no forced rung anymore, the ladder can climb again
  phone.send({ type: 'screen-profile', mode: 'auto' });
  await sleep(50);
  phone.send({ type: 'screen-ack', seq: frame.seq });

  phone.close();
  await server.stop();
});

test('three slow deliveries walk the capture profile down a rung', async () => {
  const { adapter, emit, profileCalls } = manualAdapter();
  const server = createAeroServer({ port: 0, adapter });
  const { port } = await server.listen();
  const phone = await connect(`ws://127.0.0.1:${port}`, { role: 'phone-client', token: server.pairingToken });

  phone.send({ type: 'screen-start' });
  await sleep(50);

  // hd budget is 650ms; acks arriving after ~900ms mean the link can't keep up
  for (let i = 1; i <= 3; i++) {
    emit({ dataUrl: `data:image/png;base64,frame${i}`, w: 10, h: 10, ts: i });
    const frame = await phone.next(isFrame);
    await sleep(900);
    phone.send({ type: 'screen-ack', seq: frame.seq });
    await sleep(30); // let the ack land before the next emit
  }

  assert.ok(
    profileCalls.some((p) => p.name === 'balanced'),
    `expected a step down to balanced, saw: ${JSON.stringify(profileCalls)}`
  );

  phone.close();
  await server.stop();
});
