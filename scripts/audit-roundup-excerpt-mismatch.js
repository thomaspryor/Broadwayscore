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
const { listShowDirs } = require('./lib/list-show-dirs');
const fs = require('fs');
const path = require('path');
const { bwwExcerptContradictsText } = require('./lib/wrong-production-autoclear');

const { hasHelpFlag } = require('./lib/cli-help.js');
const USAGE = 'audit-roundup-excerpt-mismatch.js [--autocleared-only] [--dir=PATH]  read-only scan, metadata only';
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const args = process.argv.slice(2);
const dirArg = (args.find((a) => a.startsWith('--dir=')) || '').slice(6);
const root = dirArg || path.join(__dirname, '..', 'data', 'review-texts');
const autoOnly = args.includes('--autocleared-only');
const rows = [];
let scanned = 0;
let titles = {};
try { for (const sh of JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8')).shows || []) titles[sh.id] = sh.title; } catch (_) { /* titles optional */ }
// True when the (normalized) show title, or every 4+ letter word of it, appears in the text.
function titleIn(show, text) {
  const t = titles[show]; if (!t) return null;
  const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const body = ' ' + norm(text) + ' ', ti = norm(t);
  if (!ti) return null;
  return body.includes(' ' + ti + ' ');
}
const words = (t) => String(t || '').toLowerCase().replace(/&#?[a-z0-9]+;/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
// Metadata-only similarity: share of the excerpt's 4+ letter words that appear in the stored text.
// Low overlap = a different article (real cousin); high overlap = a trimmed or reworded excerpt (benign).
function overlap(d) {
  const ex = words(d.bwwExcerpt); if (!ex.length) return null;
  const have = new Set(words(d.fullText));
  return Math.round((100 * ex.filter((w) => have.has(w)).length) / ex.length);
}
for (const show of fs.existsSync(root) ? listShowDirs(root, { silent: true }) : []) {
  const dir = path.join(root, show);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    scanned++;
    if (!bwwExcerptContradictsText(d)) continue;
    if (autoOnly && !d.wrongProductionAutoCleared) continue;
    rows.push({ show, file: f, overlapPct: overlap(d), titleInText: titleIn(show, d.fullText), titleInExcerpt: titleIn(show, d.bwwExcerpt), textChars: String(d.fullText || '').length, url: d.url || null, publishDate: d.publishDate || null, wrongProduction: !!d.wrongProduction,
      autoCleared: d.wrongProductionAutoCleared ? String(d.wrongProductionAutoCleared).slice(0, 70) : null });
  }
}
console.log(JSON.stringify({ scanned, count: rows.length, rows }, null, 1));
