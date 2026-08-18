'use strict';

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { MSG, ROLES, INPUT_KINDS, CLOSE_BAD_TOKEN } = require('./protocol');
const { tokensEqual } = require('./token');

const HELLO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 25000;

// WebSocket hub: authenticates clients, tracks presence (which drives the
// host-side UI transformation), and routes clipboard / input / device-info
// messages through the host adapter.
function createHub({ httpServer, adapter, pairingToken, hostToken, log = () => {} }) {
  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Map(); // ws -> { id, role, device, transport, info }

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(msg, filter = () => true) {
    for (const [ws, meta] of clients) if (filter(meta)) send(ws, msg);
  }

  function presencePayload() {
    const phones = [];
    let hostConnected = false;
    for (const meta of clients.values()) {
      if (meta.role === ROLES.PHONE) {
        phones.push({
          clientId: meta.id,
          name: meta.device.name || 'Android device',
          transport: meta.transport,
          connectedAt: meta.connectedAt,
        });
      } else {
        hostConnected = true;
      }
    }
    return { type: MSG.PRESENCE, phones, hostConnected };
  }

  function broadcastPresence() {
    broadcast(presencePayload());
  }

  function detectTransport(ws, req, role) {
    if (role === ROLES.HOST) return 'local';
    const addr = req.socket.remoteAddress || '';
    const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    // A phone arriving over loopback got there through `adb reverse` (USB).
    return isLoopback ? 'usb' : 'wifi';
  }

  async function handleMessage(ws, meta, msg) {
    switch (msg.type) {
      case MSG.CLIPBOARD_SET: {
        const text = String(msg.text ?? '');
        try {
          adapter.setClipboard(text);
        } catch (err) {
          log('clipboard write failed:', err.message);
        }
        const from = meta.role === ROLES.HOST ? 'mac' : 'phone';
        broadcast(
          { type: MSG.CLIPBOARD_UPDATE, text, from, ts: Date.now() },
          (m) => m.role !== meta.role
        );
        break;
      }
      case MSG.CLIPBOARD_GET: {
        let text = '';
        try {
          text = String(adapter.getClipboard() ?? '');
        } catch (err) {
          log('clipboard read failed:', err.message);
        }
        send(ws, { type: MSG.CLIPBOARD_UPDATE, text, from: 'mac', ts: Date.now() });
        break;
      }
      case MSG.DEVICE_INFO: {
        meta.info = msg.info || null;
        broadcast(
          { type: MSG.DEVICE_INFO_UPDATE, clientId: meta.id, info: meta.info },
          (m) => m.role === ROLES.HOST
        );
        break;
      }
      case MSG.INPUT: {
        if (!INPUT_KINDS.includes(msg.kind)) {
          send(ws, { type: MSG.ERROR, code: 'bad-message', message: `unknown input kind: ${msg.kind}` });
          return;
        }
        let result;
        try {
          result = await adapter.input(msg);
        } catch (err) {
          result = { ok: false, message: err.message };
        }
        send(ws, { type: MSG.INPUT_RESULT, kind: msg.kind, ...result });
        break;
      }
      case MSG.SCREEN_START:
      case MSG.SCREEN_STOP:
        send(ws, { type: MSG.ERROR, code: 'not-supported', message: 'Screen preview is coming in a future version' });
        break;
      default:
        send(ws, { type: MSG.ERROR, code: 'bad-message', message: `unknown message type: ${msg.type}` });
    }
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.missedPongs = 0;
    ws.on('pong', () => { ws.missedPongs = 0; });

    const helloTimer = setTimeout(() => ws.close(CLOSE_BAD_TOKEN, 'hello timeout'), HELLO_TIMEOUT_MS);

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        send(ws, { type: MSG.ERROR, code: 'bad-message', message: 'invalid JSON' });
        return;
      }

      const meta = clients.get(ws);
      if (!meta) {
        // First message must be a valid hello.
        if (msg.type !== MSG.HELLO) {
          ws.close(CLOSE_BAD_TOKEN, 'hello required');
          return;
        }
        const role = msg.role === ROLES.HOST ? ROLES.HOST : ROLES.PHONE;
        const tokenOk =
          role === ROLES.HOST
            ? tokensEqual(msg.token, hostToken)
            : tokensEqual(msg.token, pairingToken) || tokensEqual(msg.token, hostToken);
        if (!tokenOk) {
          send(ws, { type: MSG.ERROR, code: 'bad-token', message: 'invalid pairing token' });
          ws.close(CLOSE_BAD_TOKEN, 'bad token');
          return;
        }
        clearTimeout(helloTimer);
        const newMeta = {
          id: crypto.randomBytes(6).toString('hex'),
          role,
          device: msg.device || {},
          transport: detectTransport(ws, req, role),
          connectedAt: Date.now(),
          info: null,
        };
        clients.set(ws, newMeta);
        send(ws, {
          type: MSG.HELLO_ACK,
          clientId: newMeta.id,
          role,
          server: { version: '0.1.0', platform: adapter.platform },
        });
        broadcastPresence();
        log(`${role} connected (${newMeta.transport})`);
        return;
      }

      handleMessage(ws, meta, msg).catch((err) => log('message error:', err.message));
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (clients.delete(ws)) broadcastPresence();
    });
    ws.on('error', () => {});
  });

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      ws.missedPongs = (ws.missedPongs || 0) + 1;
      if (ws.missedPongs > 2) {
        ws.terminate();
        continue;
      }
      try {
        ws.ping();
      } catch {}
    }
  }, PING_INTERVAL_MS);

  function broadcastToHosts(msg) {
    broadcast(msg, (m) => m.role === ROLES.HOST);
  }

  function stop() {
    clearInterval(pingTimer);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return { broadcast, broadcastToHosts, presencePayload, clients, stop };
}

module.exports = { createHub };
