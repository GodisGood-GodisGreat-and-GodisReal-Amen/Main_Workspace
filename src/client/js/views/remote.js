// Remote control — two ways to drive the Mac from the phone:
//  • Launcher: gel app icons on a white Frutiger Aero sheet; a tap opens the
//    app on the Mac (`apps-get` list + `launch` input).
//  • Full screen: a live stream of the whole display (`screen-frame`), tap to
//    click right there, hold for right-click, with the trackpad / keyboard /
//    media controls underneath as the precision fallback.
import { $, el, toast, throttle, escapeHtml } from '../util.js';
import { appIcon } from '../icons.js';

export function initRemote({ store, send, isHost }) {
  const note = $('#remote-note');
  const pad = $('#trackpad');
  const stage = $('#screen-stage');
  const img = $('#screen-img');
  const hint = $('#screen-hint');
  const grid = $('#launcher-grid');
  const emptyNote = $('#launcher-empty');
  const search = $('#launcher-search');

  let mode = 'screen'; // 'apps' | 'screen'
  let visible = false; // is the remote view the active view?
  let streaming = false; // we hold a screen-start subscription
  let apps = null; // null until the first apps-list arrives

  if (isHost) {
    $('#remote-phone-ui').style.display = 'none';
    $('#remote-host-hint').style.display = 'block';
  }

  // ---- segmented mode switch ----
  const segButtons = [...document.querySelectorAll('#remote-seg .seg-btn')];
  segButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  function setMode(next) {
    mode = next === 'apps' ? 'apps' : 'screen';
    segButtons.forEach((b) => {
      const active = b.dataset.mode === mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    $('#remote-mode-apps').classList.toggle('active', mode === 'apps');
    $('#remote-mode-screen').classList.toggle('active', mode === 'screen');
    if (mode === 'apps' && visible && !isHost && apps === null) requestApps();
    // keep the hash truthful so reload / share lands on the same mode,
    // without stacking history entries per toggle
    const wantHash = mode === 'apps' ? '#apps' : '#remote';
    if (visible && !isHost && location.hash !== wantHash) {
      history.replaceState(null, '', wantHash);
    }
    syncStream();
  }

  // called by app.js when the view is routed to / away from
  function show(initialMode) {
    visible = true;
    setMode(initialMode || mode);
  }
  function hide() {
    visible = false;
    syncStream();
  }
  // after a WS reconnect the server forgot our screen subscription — re-arm
  function resync() {
    if (streaming) {
      streaming = false;
      syncStream();
    }
  }

  // ---- full-screen mode: live frames + tap-to-click ----
  // Every rendered frame is acked so the server can pace the stream to the
  // link (next frame only once this one arrived) — that's what keeps the
  // full-screen mode usable on slow connections.
  const qualityLabel = $('#stream-quality');
  const ecoBtn = $('#eco-toggle');
  const PROFILE_NAMES = { hd: 'HD', balanced: 'Balanced', eco: 'Eco' };
  let ecoMode = localStorage.getItem('aerolink-eco') === '1';

  function paintEco() {
    ecoBtn.classList.toggle('active', ecoMode);
    ecoBtn.setAttribute('aria-pressed', String(ecoMode));
  }
  paintEco();

  ecoBtn.addEventListener('click', () => {
    ecoMode = !ecoMode;
    localStorage.setItem('aerolink-eco', ecoMode ? '1' : '0');
    paintEco();
    if (streaming) send({ type: 'screen-profile', mode: ecoMode ? 'eco' : 'auto' });
  });

  function syncStream() {
    const want = visible && mode === 'screen' && !isHost && !document.hidden;
    if (want && !streaming) {
      streaming = true;
      img.classList.remove('live');
      hint.textContent = 'Connecting to the Mac’s screen…';
      hint.style.display = 'grid';
      send({ type: 'screen-start' });
      if (ecoMode) send({ type: 'screen-profile', mode: 'eco' });
    } else if (!want && streaming) {
      streaming = false;
      send({ type: 'screen-stop' });
    }
  }
  document.addEventListener('visibilitychange', syncStream);

  function onFrame(msg) {
    if (!streaming || !msg.dataUrl) return;
    img.src = msg.dataUrl;
    if (msg.seq) send({ type: 'screen-ack', seq: msg.seq });
    if (msg.profile && PROFILE_NAMES[msg.profile]) {
      qualityLabel.textContent = PROFILE_NAMES[msg.profile];
      qualityLabel.hidden = false;
      qualityLabel.dataset.profile = msg.profile;
    }
    if (!img.classList.contains('live')) {
      img.classList.add('live');
      hint.style.display = 'none';
    }
  }

  function onScreenError(msg) {
    if (mode !== 'screen' || !visible) return;
    img.classList.remove('live');
    hint.style.display = 'grid';
    hint.textContent = msg.message || 'Screen preview is not available — the trackpad below still works.';
  }

  // tap = click at that exact spot; hold still = right-click; the pointer
  // ripple confirms where the tap landed.
  let tapStart = null;
  let holdTimer = null;

  function ripple(clientX, clientY, isRight) {
    const rect = stage.getBoundingClientRect();
    const r = el('span', {
      class: `tap-ripple${isRight ? ' right' : ''}`,
      style: `left:${clientX - rect.left}px;top:${clientY - rect.top}px`,
    });
    stage.appendChild(r);
    setTimeout(() => r.remove(), 500);
  }

  function clickAt(clientX, clientY, button) {
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const ny = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    send({ type: 'input', kind: 'click-at', nx, ny, button });
    ripple(clientX, clientY, button === 'right');
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!img.classList.contains('live')) return;
    tapStart = { x: e.clientX, y: e.clientY, at: Date.now() };
    holdTimer = setTimeout(() => {
      if (!tapStart) return;
      clickAt(tapStart.x, tapStart.y, 'right');
      if (navigator.vibrate) navigator.vibrate(25);
      tapStart = null;
    }, 550);
  });
  stage.addEventListener('pointermove', (e) => {
    if (tapStart && Math.abs(e.clientX - tapStart.x) + Math.abs(e.clientY - tapStart.y) > 12) {
      clearTimeout(holdTimer);
      tapStart = null;
    }
  });
  stage.addEventListener('pointerup', (e) => {
    clearTimeout(holdTimer);
    if (tapStart && Date.now() - tapStart.at < 550) clickAt(e.clientX, e.clientY, 'left');
    tapStart = null;
  });
  stage.addEventListener('pointercancel', () => {
    clearTimeout(holdTimer);
    tapStart = null;
  });

  // ---- launcher mode: gel icons on white, tap to open on the Mac ----
  function requestApps() {
    emptyNote.style.display = 'block';
    emptyNote.textContent = 'Loading the Mac’s apps…';
    send({ type: 'apps-get' });
  }
  $('#launcher-refresh').addEventListener('click', requestApps);
  search.addEventListener('input', renderApps);

  function onApps(msg) {
    apps = Array.isArray(msg.apps) ? msg.apps : [];
    renderApps();
  }

  function renderApps() {
    if (apps === null) return;
    const q = search.value.trim().toLowerCase();
    const list = apps.filter((a) => a.name.toLowerCase().includes(q));
    grid.innerHTML = '';
    emptyNote.style.display = list.length ? 'none' : 'block';
    emptyNote.textContent = apps.length
      ? 'No app matches your search.'
      : 'The Mac reported no apps — is the host app running on macOS?';
    list.forEach((a, i) => {
      const chip = el('button', {
        class: 'app-chip',
        type: 'button',
        role: 'listitem',
        title: `Open ${a.name} on the Mac`,
        style: `--i:${Math.min(i, 24)}`,
      });
      chip.innerHTML = `${appIcon(a.name, 58)}<span class="app-name">${escapeHtml(a.name)}</span>`;
      chip.addEventListener('click', () => {
        send({ type: 'input', kind: 'launch', app: a.id });
        toast(`Opening “${a.name}” on the Mac…`);
      });
      grid.appendChild(chip);
    });
  }

  // ---- trackpad: one finger moves, tap clicks, two fingers scroll ----
  // Deltas are accumulated between flushes so fast swipes lose no distance —
  // a plain throttle would silently drop every event inside the window.
  let accX = 0;
  let accY = 0;
  let accScroll = 0;
  const flushMove = throttle(() => {
    const dx = Math.round(accX);
    const dy = Math.round(accY);
    accX -= dx;
    accY -= dy;
    if (dx || dy) send({ type: 'input', kind: 'move', dx, dy });
  }, 33);
  const flushScroll = throttle(() => {
    const dy = Math.round(accScroll);
    accScroll -= dy;
    if (dy) send({ type: 'input', kind: 'scroll', dy });
  }, 66);
  const sendMove = (dx, dy) => { accX += dx; accY += dy; flushMove(); };
  const sendScroll = (dy) => { accScroll += dy; flushScroll(); };

  let last = null;
  let startAt = 0;
  let moved = 0;
  let fingers = 0;

  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    fingers++;
    last = { x: e.clientX, y: e.clientY };
    startAt = Date.now();
    moved = 0;
  });
  pad.addEventListener('pointermove', (e) => {
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    moved += Math.abs(dx) + Math.abs(dy);
    last = { x: e.clientX, y: e.clientY };
    if (fingers >= 2) sendScroll(dy);
    else sendMove(dx * 1.6, dy * 1.6);
  });
  const end = () => {
    if (fingers === 1 && moved < 8 && Date.now() - startAt < 260) {
      send({ type: 'input', kind: 'click', button: 'left' });
    }
    fingers = Math.max(0, fingers - 1);
    if (!fingers) last = null;
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', () => { fingers = 0; last = null; });

  // ---- keys / media / volume buttons ----
  document.querySelectorAll('[data-key]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'input', kind: 'key', key: b.dataset.key })));
  document.querySelectorAll('[data-media]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'input', kind: 'media', action: b.dataset.media })));
  document.querySelectorAll('[data-volume]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'input', kind: 'volume', action: b.dataset.volume })));

  // ---- text ----
  const textInput = $('#remote-text');
  const sendText = () => {
    if (!textInput.value) return;
    send({ type: 'input', kind: 'text', text: textInput.value });
    textInput.value = '';
  };
  $('#remote-send-text').addEventListener('click', sendText);
  textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });

  let lastNoteAt = 0;
  function onResult(msg) {
    if (msg.ok) {
      note.classList.remove('show'); // things work again — retire the warning
      return;
    }
    // pointer moves stream at 30 Hz — surface a failure once, not per event
    if (Date.now() - lastNoteAt < 4000) return;
    lastNoteAt = Date.now();
    note.textContent = msg.message || 'That did not reach the Mac.';
    note.classList.add('show');
    if (!['move', 'scroll', 'click-at'].includes(msg.kind)) toast(msg.message || 'Not available', true);
  }

  setMode('screen');
  return { onResult, onApps, onFrame, onScreenError, show, hide, resync, setMode };
}
