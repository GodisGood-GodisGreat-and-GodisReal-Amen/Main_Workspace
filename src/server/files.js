'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INDEX_NAME = '.aerolink-index.json';
const MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

function sanitizeFilename(raw) {
  let name = path.basename(String(raw || ''));
  // strip control chars and path-hostile characters
  name = name.replace(/[\x00-\x1f\\/:*?"<>|]/g, '').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  return name;
}

// Manages the shared-files folder: streamed writes, listing, downloads.
// Metadata (id, origin, timestamp) lives in a JSON sidecar so original
// filenames stay intact on disk.
function createFileStore(storageDir) {
  fs.mkdirSync(storageDir, { recursive: true });
  const indexPath = path.join(storageDir, INDEX_NAME);
  let index = {};
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    index = {};
  }
  // drop index entries whose file vanished; adopt untracked files
  for (const [id, meta] of Object.entries(index)) {
    if (!fs.existsSync(path.join(storageDir, meta.name))) delete index[id];
  }
  for (const entry of fs.readdirSync(storageDir)) {
    if (entry === INDEX_NAME) continue;
    const full = path.join(storageDir, entry);
    if (!fs.statSync(full).isFile()) continue;
    if (!Object.values(index).some((m) => m.name === entry)) {
      const id = crypto.randomBytes(4).toString('hex');
      index[id] = {
        name: entry,
        size: fs.statSync(full).size,
        from: 'mac',
        ts: fs.statSync(full).mtimeMs,
      };
    }
  }
  persist();

  function persist() {
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }

  function resolveSafe(name) {
    const full = path.resolve(storageDir, name);
    if (!full.startsWith(path.resolve(storageDir) + path.sep)) {
      throw new Error('path escapes storage dir');
    }
    return full;
  }

  function uniqueName(name) {
    if (!fs.existsSync(resolveSafe(name))) return name;
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 1; ; i++) {
      const candidate = `${base} (${i})${ext}`;
      if (!fs.existsSync(resolveSafe(candidate))) return candidate;
    }
  }

  function list() {
    return Object.entries(index)
      .map(([id, meta]) => ({ id, ...meta }))
      .sort((a, b) => b.ts - a.ts);
  }

  // Streams an incoming request body to disk; resolves with the file record.
  function saveStream(stream, rawName, from) {
    return new Promise((resolve, reject) => {
      const name = uniqueName(sanitizeFilename(rawName));
      const full = resolveSafe(name);
      const out = fs.createWriteStream(full);
      let size = 0;
      let failed = false;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_SIZE && !failed) {
          failed = true;
          out.destroy();
          fs.rm(full, { force: true }, () => {});
          reject(new Error('file too large'));
          stream.destroy();
        }
      });
      stream.pipe(out);
      out.on('finish', () => {
        if (failed) return;
        const id = crypto.randomBytes(4).toString('hex');
        index[id] = { name, size, from, ts: Date.now() };
        persist();
        resolve({ id, ...index[id] });
      });
      out.on('error', (err) => {
        if (!failed) reject(err);
      });
      stream.on('error', (err) => {
        out.destroy();
        if (!failed) reject(err);
      });
    });
  }

  function get(id) {
    const meta = index[id];
    return meta ? { id, ...meta, path: resolveSafe(meta.name) } : null;
  }

  function remove(id) {
    const meta = index[id];
    if (!meta) return false;
    fs.rmSync(resolveSafe(meta.name), { force: true });
    delete index[id];
    persist();
    return true;
  }

  return { list, saveStream, get, remove, sanitizeFilename, storageDir };
}

module.exports = { createFileStore, sanitizeFilename, MAX_SIZE };
