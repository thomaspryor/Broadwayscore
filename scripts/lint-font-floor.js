#!/usr/bin/env node
'use strict';
/**
 * lint-font-floor.js (BRO-6567): advisory web font-size floor.
 * The iOS app enforces a 12pt floor (npm run lint:design). The web has text-[9px]/[10px]/[11px]
 * with no floor. This counts them, lists them per file, and exits 0 (advisory, CLAUDE.md §19).
 * Raising them is a visual change that needs per-section visual QA, so it is done section by section.
 *
 * Usage: node scripts/lint-font-floor.js [--json] [--list] [--root=DIR]
 * Exempt a decorative use with `font-floor-ok: <reason>` on the same line (or the line above).
 */
const path = require('path');
const { run, FLOOR_PX } = require('./lib/font-floor');

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootArg = args.find(a => a.startsWith('--root='));
  const root = rootArg ? rootArg.slice(7) : path.resolve(__dirname, '..');
  const res = run(root);
  if (args.includes('--json')) { console.log(JSON.stringify(res, null, 2)); process.exit(0); }
  const px = Object.keys(res.byPx).sort((a, b) => a - b).map(k => `${k}px: ${res.byPx[k]}`).join(', ');
  console.log(`ADVISORY font floor (${FLOOR_PX}px): ${res.total} sub-floor use(s) in ${Object.keys(res.byFile).length} file(s)${px ? ` (${px})` : ''}`);
  const files = Object.entries(res.byFile).sort((a, b) => b[1].length - a[1].length);
  for (const [f, v] of (args.includes('--list') ? files : files.slice(0, 15))) {
    console.log(`  ${f}: ${v.length}${args.includes('--list') ? ' @ line ' + v.map(x => x.line).join(',') : ''}`);
  }
  process.exit(0);
}

