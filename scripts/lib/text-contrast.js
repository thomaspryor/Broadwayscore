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

/**
 * BRO-6567: OS "Increase Contrast". globals.css must lift muted text to >= 10:1 on every
 * surface inside @media (prefers-contrast: more), and cover every component class that
 * `@apply`s text-fg-muted (those compile to a literal color the .text-fg-muted override misses).
 */
const HC_MIN = 10;
function checkHighContrast(root = ROOT, cssText) {
  const css = cssText ?? fs.readFileSync(path.join(root, 'src', 'app', 'globals.css'), 'utf8');
  const failures = [];
  const blocks = [];
  const re = /@media\s*\(prefers-contrast:\s*more\)[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1; let i = re.lastIndex;
    while (i < css.length && depth) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    blocks.push(css.slice(re.lastIndex, i - 1));
  }
  if (!blocks.length) return { failures: ['no @media (prefers-contrast: more) block in globals.css'] };
  const rules = [];
  for (const b of blocks) for (const r of b.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selectors: r[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((x) => x.trim()).filter(Boolean), body: r[2] });
  }
  const colorFor = (sel) => rules.find((r) => r.selectors.includes(sel))?.body.match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1];
  const needed = ['.text-fg-muted'];
  for (const a of css.matchAll(/^\s*(\.[\w-]+)\s*\{[^{}]*@apply[^;{}]*\btext-fg-muted\b/gm)) needed.push(a[1]);
  for (const sel of needed) {
    const c = colorFor(sel);
    if (!c) { failures.push(`${sel} has no high-contrast color in @media (prefers-contrast: more)`); continue; }
    for (const [n, s] of Object.entries(SURFACES)) {
      const r = ratio(c, s);
      if (r < HC_MIN) failures.push(`${sel} ${c} on surface.${n} = ${r.toFixed(2)}:1 (< ${HC_MIN})`);
    }
  }
  return { failures, covered: needed };
}

module.exports = { ratio, checkToken, findLeftovers, checkHighContrast, SURFACES, AA, HC_MIN };
