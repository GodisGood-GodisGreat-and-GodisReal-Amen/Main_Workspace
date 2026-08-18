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
  // monitor: screen (coming soon)
  screen: `
    <rect x="26" y="30" width="50" height="34" rx="5"/>
    <path class="cut" d="M44 72h14M51 64v8"/>
    <path d="M40 70h22v6H40z"/>`,
  // droplet logo
  drop: `
    <path d="M51 24c10 14 19 23 19 34a19 19 0 1 1-38 0c0-11 9-20 19-34z"/>
    <path class="cut" d="M42 58a10.5 10.5 0 0 0 7 9.5" style="stroke-width:4.4"/>`,
};

let uid = 0;

export function icon(name, variant = 'aqua', size = 96) {
  const [hi, lite, base, deep] = VARIANTS[variant] || VARIANTS.aqua;
  const g = GLYPHS[name] || GLYPHS.drop;
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
