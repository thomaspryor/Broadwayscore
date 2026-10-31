/**
 * BRO-6553: readable text must clear WCAG AA (4.5:1) on every dark surface.
 * text-gray-500 (3.6:1 on surface.raised) and text-gray-600 (2.3:1) fail; use text-fg-muted.
 * Empty-star / icon SVGs may keep gray-600 (decorative, non-text).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SURFACES = { DEFAULT: '#0f0f14', raised: '#1a1a24', overlay: '#2a2a38', elevated: '#32323f' };
const AA = 4.5;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lum = (h) => { const [r, g, b] = hex(h).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Reads the fg-muted token from tailwind.config.ts. Returns { token, failures[] }. */
function checkToken(root = ROOT, cfgText) {
  const cfg = cfgText ?? fs.readFileSync(path.join(root, 'tailwind.config.ts'), 'utf8');
  const token = /'fg-muted':\s*'(#[0-9a-fA-F]{6})'/.exec(cfg)?.[1];
  const failures = [];
  if (!token) return { token, failures: ['fg-muted token missing from tailwind.config.ts'] };
  for (const [n, s] of Object.entries(SURFACES)) {
    const r = ratio(token, s);
    if (r < AA) failures.push(`fg-muted ${token} on surface.${n} = ${r.toFixed(2)}:1 (< ${AA})`);
  }
  return { token, failures };
}

const LEFTOVER = /(?:text|placeholder)-gray-(500|600)/;
// SVG <text> labels (chart axes) take their color from fill-*, not text-*.
const FILL_LEFTOVER = /fill-gray-(500|600)/;
const DECORATIVE = /<svg|<path|starClass|stars\.push/;

/** Finds text-/placeholder-gray-500/600 left in src (line-level; class tokens never span lines). */
function findLeftovers(root = ROOT) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(tsx|ts|jsx|js|css)$/.test(e.name) ? [path.join(d, e.name)] : []);
  const hits = [];
  for (const f of walk(path.join(root, 'src'))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (LEFTOVER.test(line) && !DECORATIVE.test(line)) hits.push(`${path.relative(root, f)}:${i + 1} uses ${LEFTOVER.exec(line)[0]}`);
      else if (FILL_LEFTOVER.test(line) && line.includes('<text')) hits.push(`${path.relative(root, f)}:${i + 1} uses ${FILL_LEFTOVER.exec(line)[0]} on SVG <text>`);
    });
  }
  return hits;
}

module.exports = { ratio, checkToken, findLeftovers, SURFACES, AA };
