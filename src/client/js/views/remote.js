// Remote control: trackpad surface + keyboard + media/volume, all sent as
// `input` messages. Results come back as toasts / the amber note.
import { $, toast, throttle } from '../util.js';

export function initRemote({ store, send, isHost }) {
  const pad = $('#trackpad');
  const note = $('#remote-note');

  if (isHost) {
    $('#remote-phone-ui').style.display = 'none';
    $('#remote-host-hint').style.display = 'block';
  }

  // --- trackpad: one finger moves, tap clicks, two fingers scroll ---
  const sendMove = throttle((dx, dy) => send({ type: 'input', kind: 'move', dx, dy }), 33);
  const sendScroll = throttle((dy) => send({ type: 'input', kind: 'scroll', dy }), 66);

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
    if (fingers >= 2) sendScroll(Math.round(dy));
    else sendMove(Math.round(dx * 1.6), Math.round(dy * 1.6));
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

  // --- keys / media / volume buttons ---
  document.querySelectorAll('[data-key]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'input', kind: 'key', key: b.dataset.key })));
  document.querySelectorAll('[data-media]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'input', kind: 'media', action: b.dataset.media })));
  document.querySelectorAll('[data-volume]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'input', kind: 'volume', action: b.dataset.volume })));

  // --- text ---
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
    if (msg.ok) return;
    // pointer moves stream at 30 Hz — surface a failure once, not per event
    if (Date.now() - lastNoteAt < 4000) return;
    lastNoteAt = Date.now();
    note.textContent = msg.message || 'That did not reach the Mac.';
    note.classList.add('show');
    if (msg.kind !== 'move' && msg.kind !== 'scroll') toast(msg.message || 'Not available', true);
  }

  return { onResult };
}
