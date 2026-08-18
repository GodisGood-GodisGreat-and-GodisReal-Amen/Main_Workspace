// The Frutiger Aero menu: glossy tile grid on the Mac, gel list on the phone.
import { $, el, escapeHtml } from '../util.js';
import { icon, glyph } from '../icons.js';

const TILES = [
  { id: 'files', icon: 'files', label: 'Files', hint: 'Beam files across', variant: 'aqua' },
  { id: 'clipboard', icon: 'clipboard', label: 'Clipboard', hint: 'Synced both ways, live', variant: 'green' },
  { id: 'device', icon: 'device', label: 'Devices', hint: 'Battery & connection', variant: 'sun' },
  { id: 'apps', icon: 'apps', label: 'Launcher', hint: 'Open Mac apps by icon', variant: 'aqua' },
  { id: 'remote', icon: 'screen', label: 'Full screen', hint: 'See & drive the whole Mac', variant: 'deep' },
];

export function initMenu({ store, isHost, openView }) {
  const grid = $('#menu-grid');
  grid.innerHTML = '';
  TILES.forEach((t, i) => {
    const tile = el('button', {
      class: 'tile',
      style: `--i:${i}`,
      type: 'button',
      'data-tile': t.id,
    });
    tile.innerHTML = `
      ${icon(t.icon, t.variant)}
      <span class="text">
        <span class="label">${escapeHtml(t.label)}</span>
        <span class="hint">${escapeHtml(t.hint)}</span>
      </span>
      <span class="chev">${glyph('chevron-right', 20)}</span>`;
    tile.addEventListener('click', () => openView(t.id));
    grid.appendChild(tile);
  });

  // decorate view headers with matching icons
  document.querySelectorAll('[data-icon]').forEach((slot) => {
    slot.innerHTML = icon(slot.dataset.icon, 'aqua', 40);
  });

  function render() {
    if (isHost) {
      const n = store.phones.length;
      const first = store.phones[0];
      $('#menu-title').textContent = n
        ? `${first.name}${n > 1 ? ` +${n - 1} more` : ''} is linked`
        : 'Connected';
      $('#menu-sub').textContent = first
        ? `Paired over ${first.transport === 'usb' ? 'USB cable' : 'Wi-Fi'} · pick a bubble to begin`
        : 'Pick a bubble to begin.';
    } else {
      $('#menu-title').textContent = 'Linked to your Mac';
      $('#menu-sub').textContent = 'Everything below happens on the big screen too.';
    }
  }
  store.on(render);
  render();

  return {};
}
