// Host pairing scene: QR code, typed URL, USB status line.
import { $, escapeHtml } from '../util.js';
import { glyph } from '../icons.js';

const USB_HINTS = {
  absent: { icon: 'usb', text: 'Install Android platform-tools (adb) for cable pairing — Wi-Fi works either way.' },
  'no-device': { icon: 'usb', text: 'Plug your phone in with a USB cable.' },
  unauthorized: { icon: 'phone', text: 'Tap “Allow USB debugging” on your phone.' },
  ready: { icon: 'check', text: 'Cable linked — opening AeroLink on your phone…' },
};

export function initWaiting({ api, isHost }) {
  if (isHost) loadQr();

  async function loadQr() {
    try {
      const res = await api('/api/qr');
      if (!res.ok) throw new Error(`qr ${res.status}`);
      const { dataUrl, url } = await res.json();
      $('#qr-img').src = dataUrl;
      $('#pair-url').textContent = url;
    } catch {
      $('#pair-url').textContent = 'QR unavailable — check the Mac app log';
      setTimeout(loadQr, 4000);
    }
  }

  function onUsbStatus(msg) {
    const line = $('#usb-line');
    if (!line) return;
    // server hints arrive as plain text — pair them with the cable glyph
    const hint = msg.hint ? { icon: 'usb', text: msg.hint } : USB_HINTS[msg.adb] || USB_HINTS.absent;
    line.innerHTML = `${glyph(hint.icon, 20)}<span>${escapeHtml(hint.text)}</span>`;
  }

  return { onUsbStatus };
}
