'use strict';
/**
 * lint-font-floor.js (BRO-6567): advisory web font-size floor.
 * The iOS app enforces a 12pt floor (npm run lint:design). The web has text-[9px]/[10px]/[11px]
 * with no floor. This counts them, lists them per file, and exits 0 (advisory, CLAUDE.md §19).
 * Raising them is a visual change that needs per-section visual QA, so it is done section by section.
 *
 * Library for scripts/lint-font-floor.js
 * Exempt a decorative use with `font-floor-ok: <reason>` on the same line (or the line above).
 */
const fs = require('fs');
const path = require('path');

const FLOOR_RE = /text-\[(\d+(?:\.\d+)?)px\]/g;
const EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.css']);
const FLOOR_PX = 12;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

/** Pure: returns [{line, px, text}] for sub-floor uses in `source`, skipping exempt lines. */
function findViolations(source) {
  const lines = source.split('\n');
  const found = [];
  lines.forEach((text, i) => {
    const exempt = /font-floor-ok:/.test(text) || (i > 0 && /font-floor-ok:/.test(lines[i - 1]));
    if (exempt) return;
    for (const m of text.matchAll(FLOOR_RE)) {
      const px = Number(m[1]);
      if (px < FLOOR_PX) found.push({ line: i + 1, px, text: text.trim().slice(0, 120) });
    }
  });
  return found;
}

function run(root) {
  const srcDir = path.join(root, 'src');
  const files = fs.existsSync(srcDir) ? walk(srcDir, []) : [];
  const byFile = {};
  const byPx = {};
  let total = 0;
  for (const f of files) {
    const v = findViolations(fs.readFileSync(f, 'utf8'));
    if (!v.length) continue;
    byFile[path.relative(root, f)] = v;
    for (const x of v) { byPx[x.px] = (byPx[x.px] || 0) + 1; total++; }
  }
  return { total, byPx, byFile };
}

module.exports = { findViolations, run, FLOOR_PX };
