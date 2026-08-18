// Glossy Frutiger Aero SVG icon factory. One chassis (gradient gel square +
// gloss ellipse + inner light stroke) with white glyphs. No external assets.

const VARIANTS = {
  aqua: ['#eafaff', '#8fd0f7', '#2f8fd9', '#1266a8'],
  green: ['#f0ffdf', '#abe07a', '#7ec850', '#4d9a2e'],
  sun: ['#fff7e0', '#ffdc7e', '#f7c548', '#c99417'],
  deep: ['#e4f2ff', '#7fb6e0', '#3b7ab0', '#0d4b7a'],
};

const GLYPHS = {
  // folder with sync arrows
  files: `
    <path d="M26 36c0-3 2.4-5.4 5.4-5.4h13l5.4 6h24.8c3 0 5.4 2.4 5.4 5.4v27.6c0 3-2.4 5.4-5.4 5.4H31.4c-3 0-5.4-2.4-5.4-5.4V36z"/>
    <path class="cut" d="M40 55h14m0 0-4.4-4.4M54 55l-4.4 4.4M62 63H48m0 0 4.4 4.4M48 63l4.4-4.4" />`,
  // twin clipboards
  clipboard: `
    <rect x="28" y="30" width="32" height="42" rx="5"/>
    <rect class="cut" x="36" y="26" width="16" height="8" rx="3"/>
    <path class="cut" d="M35 44h18M35 52h18M35 60h12"/>
    <rect x="52" y="42" width="22" height="30" rx="5" style="opacity:.85"/>`,
  // phone with heartbeat
  device: `
    <rect x="36" y="24" width="30" height="52" rx="7"/>
    <path class="cut" d="M40 62h22M48 70h6"/>
    <path class="cut" d="M40 46h6l3-7 5 13 3-6h8"/>`,
  // cursor + spark: remote control
  remote: `
    <path d="M34 28l30 13-13 4.6L46.4 59 34 28z"/>
    <path d="M52 52l14 14" style="stroke:#fff;stroke-width:7;stroke-linecap:round;fill:none"/>
    <circle class="cut" cx="70" cy="34" r="3.4"/>
    <circle class="cut" cx="30" cy="66" r="3"/>`,
  // monitor with pointer: full-screen remote
  screen: `
    <rect x="26" y="30" width="50" height="34" rx="5"/>
    <path class="cut" d="M44 72h14M51 64v8"/>
    <path d="M40 70h22v6H40z"/>
    <path class="cut" d="M46 40l14 6-6.4 2.2L51 55 46 40z"/>`,
  // grid of gel squares: the app launcher
  apps: `
    <rect x="27" y="27" width="20" height="20" rx="6"/>
    <rect x="53" y="27" width="20" height="20" rx="6" style="opacity:.92"/>
    <rect x="27" y="53" width="20" height="20" rx="6" style="opacity:.92"/>
    <rect class="cut" x="53" y="53" width="20" height="20" rx="6"/>`,
  // droplet logo
  drop: `
    <path d="M51 24c10 14 19 23 19 34a19 19 0 1 1-38 0c0-11 9-20 19-34z"/>
    <path class="cut" d="M42 58a10.5 10.5 0 0 0 7 9.5" style="stroke-width:4.4"/>`,
};

// Small UI glyphs: crisp stroke icons on a 24px grid that inherit the text
// color, so every control renders the same on Android, macOS, and desktop
// browsers instead of falling back to platform emoji.
const UI_GLYPHS = {
  'chevron-left': '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
  'chevron-right': '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  wifi: `
    <path d="M2.8 9.6a14 14 0 0 1 18.4 0"/>
    <path d="M6 13a9.4 9.4 0 0 1 12 0"/>
    <path d="M9.3 16.4a4.8 4.8 0 0 1 5.4 0"/>
    <circle cx="12" cy="19.6" r="1.4" fill="currentColor" stroke="none"/>`,
  usb: `
    <rect x="8" y="3" width="8" height="9.5" rx="1.6"/>
    <path d="M10.6 6v2.2M13.4 6v2.2M12 12.5V17a3.4 3.4 0 0 1-3.4 3.4H7"/>`,
  phone: `
    <rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/>
    <path d="M10.6 17.8h2.8"/>`,
  check: '<path d="m4.5 12.8 4.8 4.7L19.5 6.5"/>',
  sparkle: `
    <path d="M12 3.2c.9 4.5 2.4 6 6.8 8.8-4.4 2.8-5.9 4.3-6.8 8.8-.9-4.5-2.4-6-6.8-8.8 4.4-2.8 5.9-4.3 6.8-8.8z"
      fill="currentColor" stroke="currentColor" stroke-width="1.2"/>`,
  monitor: `
    <rect x="3" y="4.4" width="18" height="12.6" rx="2"/>
    <path d="M9.4 20.6h5.2M12 17v3.6"/>`,
  refresh: `
    <path d="M19.6 12a7.6 7.6 0 1 1-2.2-5.4"/>
    <path d="M19.8 3.2v4.4h-4.4"/>`,
  backspace: `
    <path d="M9 4.8h9.2a2 2 0 0 1 2 2v10.4a2 2 0 0 1-2 2H9L2.8 12z"/>
    <path d="m10.8 9.4 5.2 5.2m0-5.2-5.2 5.2"/>`,
  'arrow-left': '<path d="M20 12H4m6-6-6 6 6 6"/>',
  'arrow-up': '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  'arrow-down': '<path d="M12 4v16m-6-6 6 6 6-6"/>',
  'arrow-right': '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  'media-prev': `
    <path d="M6 5.2v13.6"/>
    <path d="M19 5.8 10 12l9 6.2z" fill="currentColor" stroke="currentColor" stroke-width="1.6"/>`,
  'media-play-pause': `
    <path d="M4.2 5.8 12 12l-7.8 6.2z" fill="currentColor" stroke="currentColor" stroke-width="1.6"/>
    <path d="M15.4 5.6v12.8M19.8 5.6v12.8"/>`,
  'media-next': `
    <path d="M18 5.2v13.6"/>
    <path d="M5 5.8 14 12l-9 6.2z" fill="currentColor" stroke="currentColor" stroke-width="1.6"/>`,
  close: '<path d="m6.2 6.2 11.6 11.6m0-11.6L6.2 17.8"/>',
  bolt: `
    <path d="M13.2 2.6 5.4 13.3h5L10.8 21.4l7.8-10.7h-5z"
      fill="currentColor" stroke="currentColor" stroke-width="1.4"/>`,
};

let uid = 0;

export function icon(name, variant = 'aqua', size = 96) {
  return chassis(GLYPHS[name] || GLYPHS.drop, variant, size);
}

export function glyph(name, size = 18) {
  const g = UI_GLYPHS[name] || UI_GLYPHS.sparkle;
  return `<svg class="glyph" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${g}</svg>`;
}

// Launcher icons: same gel chassis, the app's initials as the glyph. The
// variant is picked from the name so each app keeps a stable color.
export function appIcon(name, size = 56) {
  const clean = String(name || '?').trim();
  const words = clean.split(/[\s-]+/).filter(Boolean);
  const initials = (words.length > 1
    ? words[0][0] + words[1][0]
    : clean.slice(0, 2)
  ).toUpperCase().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const keys = Object.keys(VARIANTS);
  let hash = 0;
  for (const ch of clean) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const variant = keys[hash % keys.length];
  const glyph = `<text x="50" y="65" text-anchor="middle" font-family="'Lucida Grande','Segoe UI','Trebuchet MS',sans-serif" font-size="42" font-weight="700">${initials}</text>`;
  return chassis(glyph, variant, size);
}

function chassis(g, variant, size) {
  const [hi, lite, base, deep] = VARIANTS[variant] || VARIANTS.aqua;
  const id = `g${++uid}`;
  return `
<svg class="badge" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">
  <defs>
    <linearGradient id="${id}-gel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hi}"/>
      <stop offset=".45" stop-color="${lite}"/>
      <stop offset=".5" stop-color="${base}"/>
      <stop offset="1" stop-color="${lite}"/>
    </linearGradient>
    <linearGradient id="${id}-sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".95"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".05"/>
    </linearGradient>
    <filter id="${id}-soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-color="${deep}" flood-opacity=".55"/>
    </filter>
  </defs>
  <rect x="4" y="4" width="92" height="92" rx="24" fill="url(#${id}-gel)" stroke="${deep}" stroke-opacity=".55" stroke-width="1.6"/>
  <rect x="6.5" y="6.5" width="87" height="87" rx="21.5" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.6"/>
  <g fill="#fff" filter="url(#${id}-soft)" style="stroke-linejoin:round">
    <g>${g.replaceAll('class="cut"', `fill="none" stroke="${deep}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"`)}</g>
  </g>
  <ellipse cx="50" cy="22" rx="41" ry="17" fill="url(#${id}-sheen)"/>
</svg>`;
}
