// Clipboard sync. navigator.clipboard needs a secure context (or localhost —
// which USB pairing gives us); the textarea is the universal fallback.
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
    note.textContent = `Updated from ${msg.from === 'mac' ? 'the Mac' : 'the phone'} at ${fmtTime(msg.ts)}.`;
  }

  return { onUpdate };
}
