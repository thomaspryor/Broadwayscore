#!/usr/bin/env node
/**
 * replay-multishow-affected.js — read-only (BRO-7053).
 * Lists stored review files whose recorded rejection reason is the multi-show
 * junk-page check, and whether the current detector still flags their text.
 * Prints ids, outlets, lengths and the reason string (show titles only), never review text.
 * Usage: node scripts/replay-multishow-affected.js [--show=a,b] [--outcome]
 * --outcome (BRO-7055): instead of the affected list, print one row per file in the
 *   required --show shows (k=show/file, r=incompleteReason, d=first 40 chars of incompleteDetail, t=contentTier, len, s=scored), so a re-collect can be tallied.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { detectMultiShowContent } = require('./lib/content-quality');
const { listShowDirs } = require('./lib/list-show-dirs');
const { hasScore } = require('./lib/applied-fix-plan-rows');
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const dir = path.join(__dirname, '..', 'data', 'review-texts');
const only = (process.argv.find((a) => a.startsWith('--show=')) || '').slice(7).split(',').filter(Boolean);
const outcome = process.argv.includes('--outcome');
const rows = [];
if (outcome && !only.length) { console.error('--outcome needs --show=a,b (it prints a row per file)'); process.exit(2); }
for (const show of listShowDirs(dir, { silent: true }).sort()) {
  if (only.length && !only.includes(show)) continue;
  for (const f of fs.readdirSync(path.join(dir, show)).sort()) {
    if (!isReviewTextFile(f)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, show, f), 'utf8')); } catch { continue; }
    if (outcome) {
      const t = typeof j.fullText === 'string' ? j.fullText : '';
      rows.push({ k: show + '/' + f, r: j.incompleteReason || null, d: typeof j.incompleteDetail === 'string' ? j.incompleteDetail.slice(0, 40) : null, t: j.contentTier || null, len: t.length, s: hasScore(j) });
      continue;
    }
    const hit = Object.entries(j).find(([, v]) => typeof v === 'string' && v.includes('Multiple shows mentioned') && v.length < 400);
    if (!hit) continue;
    const text = typeof j.fullText === 'string' ? j.fullText : '';
    rows.push({ show, file: f, outlet: j.outletId || j.outlet || null, field: hit[0], reason: hit[1], incompleteReason: j.incompleteReason || null, len: text.length, scored: !!(j.assignedScore != null || j.llmScore || j.ensembleScore), stillFlagged: text ? detectMultiShowContent(text, show).detected : null, wasFlagged: text ? detectMultiShowContent(text, show, { subjectNames: false }).detected : null });
  }
}
console.log(JSON.stringify({ count: rows.length, rows }, null, 1));
