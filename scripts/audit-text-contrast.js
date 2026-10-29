#!/usr/bin/env node
/**
 * BRO-6553: readable text must clear WCAG AA (4.5:1) on every dark surface.
 * text-gray-500 (3.6:1 on surface.raised) and text-gray-600 (2.3:1) fail; use text-fg-muted.
 * Empty-star / icon SVGs may keep gray-600 (decorative, non-text).
 * Usage: node scripts/audit-text-contrast.js [--strict]   (exit 1 on violations only with --strict)
 */
const fs = require('fs');
const path = require('path');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lum = (h) => { const [r, g, b] = hex(h).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
module.exports = { ratio };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const cfg = fs.readFileSync(path.join(root, 'tailwind.config.ts'), 'utf8');
  const muted = /'fg-muted':\s*'(#[0-9a-fA-F]{6})'/.exec(cfg)?.[1];
  const surfaces = { DEFAULT: '#0f0f14', raised: '#1a1a24', overlay: '#2a2a38', elevated: '#32323f' };
  let bad = 0;
  if (!muted) { console.log('FAIL: fg-muted token missing from tailwind.config.ts'); bad++; }
  else for (const [n, s] of Object.entries(surfaces)) {
    const r = ratio(muted, s);
    if (r < 4.5) { console.log(`FAIL: fg-muted ${muted} on surface.${n} = ${r.toFixed(2)}:1 (< 4.5)`); bad++; }
  }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(tsx|css)$/.test(e.name) ? [path.join(d, e.name)] : []);
  const re = /text-gray-(500|600)/;
  for (const f of walk(path.join(root, 'src'))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line) && !/<svg|<path|starClass|stars\.push/.test(line)) { console.log(`FAIL: ${path.relative(root, f)}:${i + 1} uses ${re.exec(line)[0]} (use text-fg-muted)`); bad++; }
    });
  }
  console.log(bad ? `${bad} violation(s)` : `OK: fg-muted ${muted} passes 4.5:1 on all surfaces; no text-gray-500/600 text`);
  process.exit(bad && process.argv.includes('--strict') ? 1 : 0);
}
