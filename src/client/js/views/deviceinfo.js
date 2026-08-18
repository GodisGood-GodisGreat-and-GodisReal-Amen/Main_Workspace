// Device dashboard: glossy widget cards. The phone reports its own vitals
// (battery, network, screen) over WS; the host renders one card set per phone.
import { $, el, escapeHtml } from '../util.js';
import { glyph } from '../icons.js';

export function initDeviceInfo({ store, isHost }) {
  const grid = $('#device-cards');

  async function collectInfo() {
    let battery = null;
    try {
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        battery = { level: b.level, charging: b.charging };
      }
    } catch { /* Battery API is Chrome-only */ }
    const conn = navigator.connection || {};
    return {
      battery,
      network: conn.effectiveType ? { type: conn.effectiveType, downlink: conn.downlink } : null,
      screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
    };
  }

  let reportTimer = null;
  function startReporting(send) {
    const report = async () => send({ type: 'device-info', info: await collectInfo() });
    report();
    // called again after every WS reconnect — replace, never stack, the timer
    clearInterval(reportTimer);
    reportTimer = setInterval(report, 30000);
  }

  function card(k, v, s = '') {
    const c = el('div', { class: 'info-card' });
    c.innerHTML = `<div class="k">${escapeHtml(k)}</div><div class="v">${v}</div>${s ? `<div class="s">${escapeHtml(s)}</div>` : ''}`;
    return c;
  }

  function batteryCard(info) {
    const c = el('div', { class: 'info-card' });
    const pct = info?.battery ? Math.round(info.battery.level * 100) : null;
    c.innerHTML = `
      <div class="k">Battery</div>
      <div class="v">${pct === null ? '—' : `${pct}%${info.battery.charging ? ` ${glyph('bolt', 16)}` : ''}`}</div>
      <div class="battery-shell"><div class="battery-fill" style="width:${pct ?? 0}%"></div></div>`;
    return c;
  }

  function render() {
    grid.innerHTML = '';
    if (isHost) {
      if (!store.phones.length) {
        grid.appendChild(card('Status', 'No device linked', 'Waiting for your Android phone.'));
        return;
      }
      for (const phone of store.phones) {
        const info = store.deviceInfo.get(phone.clientId);
        grid.appendChild(card('Device', escapeHtml(phone.name), 'connected ' + new Date(phone.connectedAt).toLocaleTimeString()));
        grid.appendChild(card('Link', phone.transport === 'usb' ? 'USB cable' : 'Wi-Fi', phone.transport === 'usb' ? 'via adb reverse' : 'same network'));
        grid.appendChild(batteryCard(info));
        if (info?.network) grid.appendChild(card('Network', escapeHtml(info.network.type), info.network.downlink ? `${info.network.downlink} Mb/s` : ''));
        if (info?.screen) grid.appendChild(card('Screen', `${info.screen.w}×${info.screen.h}`, `@${info.screen.dpr}x`));
      }
    } else {
      grid.appendChild(card('This device', escapeHtml(navigator.platform || 'Android'), 'sharing vitals with the Mac'));
      collectInfo().then((info) => {
        grid.appendChild(batteryCard(info));
        if (info.network) grid.appendChild(card('Network', escapeHtml(info.network.type), info.network.downlink ? `${info.network.downlink} Mb/s` : ''));
        grid.appendChild(card('Screen', `${info.screen.w}×${info.screen.h}`, `@${info.screen.dpr}x`));
      });
    }
  }
  store.on(render);
  render();

  return { startReporting };
}
