// Clipboard sync — bidirectional. Phone -> Mac is a send (or "Paste & send");
// Mac -> phone happens by itself: the server watches the Mac clipboard and
// pushes every change here as a clipboard-update. navigator.clipboard needs a
// secure context (or localhost — which USB pairing gives us); the textarea is
// the universal fallback.
import { $, toast, fmtTime } from '../util.js';

export function initClipboard({ store, send, isHost }) {
  const text = $('#clip-text');
  const note = $('#clip-note');

  $('#clip-send').addEventListener('click', () => {
    send({ type: 'clipboard-set', text: text.value });
    toast(isHost ? 'Sent to phone' : 'Sent to the Mac clipboard');
  });

  $('#clip-fetch').addEventListener('click', () => {
    send({ type: 'clipboard-get' });
  });

  // one tap: read this device's clipboard and beam it to the other side
  $('#clip-paste').addEventListener('click', async () => {
    try {
      const value = await navigator.clipboard.readText();
      text.value = value;
      send({ type: 'clipboard-set', text: value });
      toast(isHost ? 'Mac clipboard sent to the phone' : 'Phone clipboard sent to the Mac');
    } catch {
      text.focus();
      toast('This browser blocks clipboard read on LAN pages — long-press the box, paste, then Send', true);
    }
  });

  $('#clip-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text.value);
      toast('Copied on this device');
    } catch {
      text.focus();
      text.select();
      const ok = document.execCommand && document.execCommand('copy');
      toast(ok ? 'Copied on this device' : 'Long-press the text to copy — this browser blocks auto-copy on LAN pages', !ok);
    }
  });

  function onUpdate(msg) {
    text.value = msg.text || '';
    text.classList.remove('clip-flash');
    void text.offsetWidth; // restart the glow animation
    text.classList.add('clip-flash');
    note.textContent = `Updated from ${msg.from === 'mac' ? 'the Mac' : 'the phone'} at ${fmtTime(msg.ts)} — live sync is on.`;
  }

  return { onUpdate };
}
