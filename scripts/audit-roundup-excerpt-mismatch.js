#!/usr/bin/env node
'use strict';
/**
 * BRO-7293 cousin scan: review files whose BWW roundup excerpt is absent from the stored
 * text (the excerpt was attached to a different article, usually an earlier production's
 * review by the same critic). Prints metadata only, never text. Read-only.
 *   node scripts/audit-roundup-excerpt-mismatch.js [--autocleared-only] [--dir=data/review-texts]
 * Default: every file with a bwwExcerpt that contradicts its text. --autocleared-only: only those
 * whose wrongProduction flag was script-cleared (wrongProductionAutoCleared set).
 */
const fs = require('fs');
const path = require('path');
const { bwwExcerptContradictsText } = require('./lib/wrong-production-autoclear');

const args = process.argv.slice(2);
const dirArg = (args.find((a) => a.startsWith('--dir=')) || '').slice(6);
const root = dirArg || path.join(__dirname, '..', 'data', 'review-texts');
const autoOnly = args.includes('--autocleared-only');
const rows = [];
let scanned = 0;
for (const show of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  const dir = path.join(root, show);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    scanned++;
    if (!bwwExcerptContradictsText(d)) continue;
    if (autoOnly && !d.wrongProductionAutoCleared) continue;
    rows.push({ show, file: f, url: d.url || null, publishDate: d.publishDate || null, wrongProduction: !!d.wrongProduction,
      autoCleared: d.wrongProductionAutoCleared ? String(d.wrongProductionAutoCleared).slice(0, 70) : null });
  }
}
console.log(JSON.stringify({ scanned, count: rows.length, rows }, null, 1));
