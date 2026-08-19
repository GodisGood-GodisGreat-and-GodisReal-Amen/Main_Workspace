'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAeroServer } = require('../src/server/server');
const { createStubAdapter } = require('../src/server/stub-adapter');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aerolink-test-'));
}

async function startServer() {
  const storageDir = tmpDir();
  const server = createAeroServer({
    port: 0,
    adapter: createStubAdapter({ storageDir }),
  });
  const { port } = await server.listen();
  return { server, port, base: `http://127.0.0.1:${port}`, storageDir };
}

test('static index is served without a token', async () => {
  const { server, base } = await startServer();
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /AeroLink/);
  await server.stop();
});

test('static serving refuses path traversal', async () => {
  const { server, base } = await startServer();
  const res = await fetch(base + '/..%2f..%2fpackage.json');
  assert.equal(res.status, 404);
  await server.stop();
});

test('/api/state requires a token and returns a snapshot', async () => {
  const { server, base } = await startServer();
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state?token=wrong')).status, 401);
  const res = await fetch(base + `/api/state?token=${server.pairingToken}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.phones, []);
  assert.deepEqual(data.files, []);
  assert.ok(data.lanUrl.startsWith('http://'));
  await server.stop();
});

test('/api/qr is host-only and returns a PNG data URL with the pairing token', async () => {
  const { server, base } = await startServer();
  assert.equal((await fetch(base + `/api/qr?token=${server.pairingToken}`)).status, 403);
  const res = await fetch(base + `/api/qr?token=${server.hostToken}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.dataUrl.startsWith('data:image/png;base64,'));
  assert.ok(data.url.includes(`token=${server.pairingToken}`));
  await server.stop();
});

test('upload sanitizes hostile filenames and download round-trips bytes', async () => {
  const { server, base, storageDir } = await startServer();
  const body = 'hello aero world';
  const up = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: {
      'X-Aero-Token': server.pairingToken,
      'X-Filename': encodeURIComponent('../../evil  name.txt'),
    },
    body,
  });
  assert.equal(up.status, 200);
  const { file } = await up.json();
  assert.equal(file.name, 'evil  name.txt'); // path stripped, spaces kept
  assert.equal(file.from, 'phone');
  assert.ok(fs.existsSync(path.join(storageDir, file.name)));
  assert.ok(!fs.existsSync(path.join(storageDir, '..', 'evil  name.txt')));

  const down = await fetch(base + `/api/files/${file.id}/download?token=${server.pairingToken}`);
  assert.equal(down.status, 200);
  assert.equal(await down.text(), body);
  await server.stop();
});

test('uploads from the host token are attributed to the mac', async () => {
  const { server, base } = await startServer();
  const up = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: { 'X-Aero-Token': server.hostToken, 'X-Filename': 'note.txt' },
    body: 'from the mac',
  });
  const { file } = await up.json();
  assert.equal(file.from, 'mac');
  await server.stop();
});

test('duplicate filenames get a numbered suffix', async () => {
  const { server, base } = await startServer();
  const send = () =>
    fetch(base + '/api/upload', {
      method: 'POST',
      headers: { 'X-Aero-Token': server.pairingToken, 'X-Filename': 'dup.txt' },
      body: 'x',
    }).then((r) => r.json());
  const a = await send();
  const b = await send();
  assert.equal(a.file.name, 'dup.txt');
  assert.equal(b.file.name, 'dup (1).txt');
  await server.stop();
});

test('DELETE removes the file from disk and the listing', async () => {
  const { server, base, storageDir } = await startServer();
  const up = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: { 'X-Aero-Token': server.pairingToken, 'X-Filename': 'gone.txt' },
    body: 'bye',
  });
  const { file } = await up.json();
  const del = await fetch(base + `/api/files/${file.id}?token=${server.pairingToken}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(path.join(storageDir, 'gone.txt')));
  const list = await (await fetch(base + `/api/files?token=${server.pairingToken}`)).json();
  assert.deepEqual(list, []);
  await server.stop();
});
