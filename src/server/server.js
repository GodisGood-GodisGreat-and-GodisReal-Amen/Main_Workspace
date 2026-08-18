'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { createHub } = require('./ws-hub');
const { createFileStore } = require('./files');
const { generateToken, tokensEqual } = require('./token');
const { getLanAddress } = require('./net-info');
const { MSG } = require('./protocol');

const CLIENT_DIR = path.join(__dirname, '..', 'client');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

// Creates the embedded HTTP + WebSocket server. `adapter` is the host
// integration seam: the Electron main process passes a macOS adapter, the
// Linux dev runner and tests pass the stub. This module must never import
// Electron.
function createAeroServer({ port = 8890, host = '0.0.0.0', adapter, log = () => {} } = {}) {
  if (!adapter) throw new Error('createAeroServer requires an adapter');

  const pairingToken = generateToken();
  const hostToken = generateToken();
  const store = createFileStore(adapter.getStorageDir());

  let hub = null;

  function requestToken(req, url) {
    return url.searchParams.get('token') || req.headers['x-aero-token'] || '';
  }

  function isAuthorized(req, url) {
    const t = requestToken(req, url);
    return tokensEqual(t, pairingToken) || tokensEqual(t, hostToken);
  }

  function isHost(req, url) {
    return tokensEqual(requestToken(req, url), hostToken);
  }

  function lanUrl(actualPort) {
    return `http://${getLanAddress()}:${actualPort}`;
  }

  function serveStatic(res, urlPath) {
    let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const full = path.resolve(CLIENT_DIR, rel);
    if (!full.startsWith(path.resolve(CLIENT_DIR) + path.sep) && full !== path.resolve(CLIENT_DIR, 'index.html')) {
      json(res, 404, { error: 'not found' });
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        json(res, 404, { error: 'not found' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      if (!p.startsWith('/api/')) {
        serveStatic(res, p);
        return;
      }

      if (!isAuthorized(req, url)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }

      const actualPort = httpServer.address()?.port || port;

      if (p === '/api/state' && req.method === 'GET') {
        json(res, 200, {
          phones: hub ? hub.presencePayload().phones : [],
          files: store.list(),
          lanUrl: lanUrl(actualPort),
          platform: adapter.platform,
          version: '0.1.0',
        });
        return;
      }

      if (p === '/api/qr' && req.method === 'GET') {
        if (!isHost(req, url)) {
          json(res, 403, { error: 'host only' });
          return;
        }
        const pairUrl = `${lanUrl(actualPort)}/?token=${pairingToken}`;
        const dataUrl = await QRCode.toDataURL(pairUrl, {
          width: 340,
          margin: 2,
          color: { dark: '#1266a8', light: '#ffffff' },
        });
        json(res, 200, { dataUrl, url: pairUrl, token: pairingToken });
        return;
      }

      if (p === '/api/upload' && req.method === 'POST') {
        let rawName = req.headers['x-filename'] || 'file';
        try {
          rawName = decodeURIComponent(rawName);
        } catch { /* malformed escape — keep the raw header, sanitized below */ }
        const from = isHost(req, url) ? 'mac' : 'phone';
        try {
          const file = await store.saveStream(req, rawName, from);
          if (hub) hub.broadcast({ type: MSG.FILE_ADDED, file });
          json(res, 200, { file });
        } catch (err) {
          json(res, err.message === 'file too large' ? 413 : 500, { error: err.message });
        }
        return;
      }

      if (p === '/api/files' && req.method === 'GET') {
        json(res, 200, store.list());
        return;
      }

      const fileMatch = p.match(/^\/api\/files\/([a-f0-9]+)(\/download)?$/);
      if (fileMatch) {
        const file = store.get(fileMatch[1]);
        if (!file) {
          json(res, 404, { error: 'not found' });
          return;
        }
        if (fileMatch[2] && req.method === 'GET') {
          const asciiName = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': file.size,
            'Content-Disposition':
              `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          });
          fs.createReadStream(file.path).pipe(res);
          return;
        }
        if (!fileMatch[2] && req.method === 'DELETE') {
          store.remove(file.id);
          if (hub) hub.broadcast({ type: MSG.FILE_REMOVED, id: file.id });
          json(res, 200, { ok: true });
          return;
        }
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      log('request error:', err.message);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  });

  hub = createHub({ httpServer, adapter, pairingToken, hostToken, log });

  function listen() {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        const actualPort = httpServer.address().port;
        log(`AeroLink server on ${host}:${actualPort}`);
        resolve({ port: actualPort, lanUrl: lanUrl(actualPort) });
      });
    });
  }

  function stop() {
    hub.stop();
    return new Promise((resolve) => httpServer.close(resolve));
  }

  return { httpServer, hub, store, listen, stop, pairingToken, hostToken, lanUrl };
}

module.exports = { createAeroServer };
