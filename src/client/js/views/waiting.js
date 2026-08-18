// Host pairing scene: QR code, typed URL, USB status line.
import { $ } from '../util.js';

const USB_HINTS = {
  absent: '🔌 Install Android platform-tools (adb) for cable pairing — Wi-Fi works either way.',
  'no-device': '🔌 Plug your phone in with a USB cable.',
  unauthorized: '📱 Tap “Allow USB debugging” on your phone.',
  ready: '✅ Cable linked — opening AeroLink on your phone…',
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
    if (line) line.textContent = msg.hint || USB_HINTS[msg.adb] || USB_HINTS.absent;
  }

  return { onUsbStatus };
}
