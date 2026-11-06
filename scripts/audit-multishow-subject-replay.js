#!/usr/bin/env node
/**
 * audit-multishow-subject-replay.js — read-only (BRO-7053).
 * Replays detectMultiShowContent over every stored review fullText with and
 * without the subject-name exemption and lists the files whose verdict flips.
 * Prints ids, outlets, lengths and counts only, never review text.
 * Usage: node scripts/audit-multishow-subject-replay.js [--show=a,b] [--shard=i/n] [--limit=N]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { detectMultiShowContent } = require('./lib/content-quality');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const only = val('show') ? val('show').split(',') : null;
const [si, sc] = val('shard') ? val('shard').split('/').map(Number) : [0, 1];
if (!(sc >= 1 && si >= 0 && si < sc)) { console.error('--shard must be i/n'); process.exit(2); }
const limit = Number(val('limit') || 100);
const dir = path.join(ROOT, 'data', 'review-texts');
const shows = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort().filter((_, i) => i % sc === si).filter((d) => !only || only.includes(d));
let scanned = 0, flaggedBefore = 0; const restored = [];
for (const show of shows) {
  for (const f of fs.readdirSync(path.join(dir, show))) {
    if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, show, f), 'utf8')); } catch { continue; }
    const text = j.fullText; if (!text || typeof text !== 'string') continue;
    scanned++;
    const before = detectMultiShowContent(text, show, { subjectNames: false });
    if (!before.detected) continue;
    flaggedBefore++;
    const after = detectMultiShowContent(text, show);
    if (!after.detected) restored.push({ show, file: f, outlet: j.outletId || j.outlet || null, len: text.length, before: before.showsFound.length, after: after.showsFound.length, incompleteReason: j.incompleteReason || null });
  }
}
console.log(JSON.stringify({ shard: `${si}/${sc}`, scanned, flaggedBefore, flippedToClean: restored.length, rows: restored.slice(0, limit) }, null, 1));
