// AeroLink client — role detection, state machine, transformation, routing.
import { $, toast } from './util.js';
import { icon } from './icons.js';
import { createWsClient } from './ws-client.js';
import { initWaiting } from './views/waiting.js';
import { initMenu } from './views/menu.js';
import { initFiles } from './views/files.js';
import { initClipboard } from './views/clipboard.js';
import { initDeviceInfo } from './views/deviceinfo.js';
import { initRemote } from './views/remote.js';

const params = new URLSearchParams(location.search);

// ---- role & token ----
const isElectron = Boolean(window.aeroHost?.isElectronHost);
const hostToken = params.get('hostToken') || '';
const isHost = isElectron || (params.get('role') === 'host' && hostToken);
const role = isHost ? 'mac-host' : 'phone-client';

let token = isHost ? hostToken : params.get('token') || '';
if (!isHost) {
  if (token) localStorage.setItem('aerolink-token', token);
  else token = localStorage.getItem('aerolink-token') || '';
}

document.body.dataset.role = role;
$('#brand-icon').innerHTML = icon('drop', 'aqua', 30);

// ---- tiny store ----
export const store = {
  role,
  token,
  state: 'boot',
  phones: [],
  files: [],
  deviceInfo: new Map(), // clientId -> info
  listeners: new Set(),
  emit() { for (const fn of this.listeners) fn(this); },
  on(fn) { this.listeners.add(fn); },
};

export function api(path, opts = {}) {
  const headers = { 'X-Aero-Token': token, ...(opts.headers || {}) };
  return fetch(path, { ...opts, headers });
}

export function withToken(url) {
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

// ---- scene state machine ----
let graceTimer = null;

function setState(next) {
  const prev = store.state;
  if (prev === next) return;
  store.state = next;

  // The signature move: waiting -> menu inflates the pairing scene away and
  // pops the menu tiles in, staggered.
  if (isHost && prev === 'waiting' && next === 'menu') {
    document.body.classList.add('transforming');
    document.body.dataset.state = 'menu';
    setTimeout(() => document.body.classList.remove('transforming'), 1400);
  } else if (next === 'menu' && (prev === 'boot' || prev === 'connecting')) {
    document.body.classList.add('entering');
    document.body.dataset.state = 'menu';
    setTimeout(() => document.body.classList.remove('entering'), 1400);
  } else {
    document.body.dataset.state = next;
  }
  store.emit();
}

function setConnPill(online, label) {
  $('#conn-pill').classList.toggle('online', online);
  $('#conn-label').textContent = label;
}

// ---- hash routing (menu <-> feature views) ----
// '#apps' and '#remote' are two modes of the same remote-control view:
// the launcher (gel app icons) and the full-screen live view.
const VIEWS = ['files', 'clipboard', 'device', 'remote', 'apps'];
const VIEW_ELEMENTS = ['files', 'clipboard', 'device', 'remote'];
let onViewRouted = null; // set in boot(): (viewName|null, rawHash) => {}

function applyHash() {
  const raw = location.hash.replace('#', '');
  const target = raw === 'apps' ? 'remote' : raw;
  if (VIEWS.includes(raw) && (store.state === 'menu' || store.state === 'view')) {
    for (const v of VIEW_ELEMENTS) $(`#view-${v}`).classList.toggle('active', v === target);
    setState('view');
    if (onViewRouted) onViewRouted(target, raw);
  } else {
    if (store.state === 'view') setState('menu');
    if (onViewRouted) onViewRouted(null, raw);
  }
}
window.addEventListener('hashchange', applyHash);
$('#back-btn').addEventListener('click', () => { location.hash = ''; });

export function openView(name) { location.hash = name; }

// ---- boot ----
if (!token) {
  setState('unauthorized');
  setConnPill(false, 'Not paired');
} else {
  boot();
}

function boot() {
  setState(isHost ? 'waiting' : 'connecting');
  setConnPill(false, 'Connecting…');

  const views = {
    waiting: initWaiting({ store, api, isHost }),
    menu: initMenu({ store, isHost, openView }),
    files: initFiles({ store, api, withToken }),
    clipboard: initClipboard({ store, send: (m) => ws.send(m), isHost }),
    device: initDeviceInfo({ store, isHost }),
    remote: initRemote({ store, send: (m) => ws.send(m), isHost }),
  };

  // the remote view manages a live screen stream — tell it when it is routed
  // to (and in which mode) or away, so frames only flow while it's on screen
  onViewRouted = (view, raw) => {
    if (view === 'remote') views.remote.show(raw === 'apps' ? 'apps' : 'screen');
    else views.remote.hide();
  };

  const ws = createWsClient({
    role,
    token,
    device: {
      name: isHost ? 'Mac' : deviceName(),
      ua: navigator.userAgent,
      platform: navigator.platform,
    },
    onMessage(msg) {
      switch (msg.type) {
        case 'hello-ack':
          setConnPill(true, isHost ? 'Ready' : 'Linked to Mac');
          if (!isHost) {
            setState(location.hash ? 'view' : 'menu');
            applyHash();
            views.device.startReporting((m) => ws.send(m));
          }
          views.remote.resync(); // a reconnect drops the screen subscription
          refreshFiles();
          break;
        case 'presence': {
          store.phones = msg.phones || [];
          if (isHost) {
            if (store.phones.length > 0) {
              clearTimeout(graceTimer);
              graceTimer = null;
              if (store.state === 'waiting') setState('menu');
              setConnPill(true, `${store.phones.length} device${store.phones.length > 1 ? 's' : ''} linked`);
            } else if (store.state !== 'waiting' && !graceTimer) {
              setConnPill(true, 'Device left');
              // grace period absorbs phone-side reconnects
              graceTimer = setTimeout(() => {
                graceTimer = null;
                if (store.phones.length === 0) {
                  location.hash = '';
                  setState('waiting');
                  setConnPill(true, 'Ready');
                }
              }, 3000);
            }
          }
          store.emit();
          break;
        }
        case 'clipboard-update':
          views.clipboard.onUpdate(msg);
          break;
        case 'device-info-update':
          store.deviceInfo.set(msg.clientId, msg.info);
          store.emit();
          break;
        case 'input-result':
          views.remote.onResult(msg);
          break;
        case 'apps-list':
          views.remote.onApps(msg);
          break;
        case 'screen-frame':
          views.remote.onFrame(msg);
          break;
        case 'file-added': {
          store.files = [msg.file, ...store.files.filter((f) => f.id !== msg.file.id)];
          store.emit();
          // the uploader already saw a "Sent" toast — only announce arrivals
          const fromMe = (msg.file.from === 'mac') === isHost;
          if (!fromMe) toast(`Received “${msg.file.name}”`);
          break;
        }
        case 'file-removed':
          store.files = store.files.filter((f) => f.id !== msg.id);
          store.emit();
          break;
        case 'usb-status':
          views.waiting.onUsbStatus(msg);
          break;
        case 'error':
          if (msg.code === 'bad-token') {
            localStorage.removeItem('aerolink-token');
            setState('unauthorized');
            setConnPill(false, 'Not paired');
          } else if (msg.code === 'not-supported' || msg.code === 'screen-failed') {
            views.remote.onScreenError(msg);
          } else {
            toast(msg.message || 'Something went wrong', true);
          }
          break;
      }
    },
    onClose() {
      if (store.state !== 'unauthorized') setConnPill(false, 'Reconnecting…');
    },
  });

  async function refreshFiles() {
    try {
      const res = await api('/api/state');
      if (!res.ok) return;
      const data = await res.json();
      store.files = data.files || [];
      store.emit();
    } catch { /* server will push updates once ws is up */ }
  }
}

function deviceName() {
  const ua = navigator.userAgent;
  const m = ua.match(/Android [\d.]+; ([^);]+)/);
  if (m) return m[1].trim();
  if (/Android/.test(ua)) return 'Android device';
  if (/iPhone|iPad/.test(ua)) return 'iOS device';
  return 'Companion device';
}

// PWA service worker (best effort; requires a secure or localhost origin)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
