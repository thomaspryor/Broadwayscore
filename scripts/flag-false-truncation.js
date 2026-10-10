#!/usr/bin/env node
'use strict';
/**
 * BRO-4804 past-inventory repair. Flags scored reviews whose complete-tier
 * fullText the scorer called TRUNCATED only because of a page footer, so the
 * rescore drain (llm-ensemble-score.yml --needs-rescore) can re-score them with
 * the fixed text-quality.js. Predicate: isFalseTruncationScore() in
 * scripts/lib/rescore-flagging.js (assessFullText without vs with trustedComplete).
 *
 * Sets needsRescore=true, rescoreReason='false-truncation-warning', clears
 * rescoreCompletedAt. Newest shows first by opening date.
 *
 * Usage: node scripts/flag-false-truncation.js [--apply] [--within-days=N]
 *          [--sample=N] [--limit=N] [--show=ID] [--json=PATH]
 *   --within-days  only shows opened within N days (30 / 90 / 365 waves)
 *   --sample       deterministic spread of N files (the section-13 A/B sample)
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { isFalseTruncationScore } = require('./lib/rescore-flagging');
const { safeWriteReview } = require('./lib/review-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `flag-false-truncation.js — flag scored reviews that a page footer made the scorer call truncated.

Usage:
  node scripts/flag-false-truncation.js [--apply] [--within-days=N] [--sample=N] [--limit=N] [--show=ID] [--json=PATH]
  node scripts/flag-false-truncation.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const args = process.argv.slice(2);
const arg = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const APPLY = args.includes('--apply');
const WITHIN = arg('within-days') ? parseInt(arg('within-days'), 10) : 0;
const SAMPLE = arg('sample') ? parseInt(arg('sample'), 10) : 0;
const LIMIT = arg('limit') ? parseInt(arg('limit'), 10) : 0;
const ONLY = arg('show');
const JSON_OUT = arg('json');
const ROOT = path.join(__dirname, '..');
const REASON = 'false-truncation-warning';

const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const shows = (Array.isArray(showsRaw) ? showsRaw : showsRaw.shows || []).filter(s => s && s.id);
const showById = new Map(shows.map(s => [s.id, s]));
const openedMs = (s) => { const t = Date.parse((s && (s.openingDate || s.previewsStartDate)) || ''); return Number.isFinite(t) ? t : 0; };
const cutoff = WITHIN ? Date.now() - WITHIN * 86400000 : 0;

const hits = [];
let scanned = 0;
for (const f of glob.sync(path.join(ROOT, 'data', 'review-texts', ONLY || '*', '*.json'))) {
  const showId = path.basename(path.dirname(f));
  const show = showById.get(showId);
  if (cutoff && openedMs(show) < cutoff) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  scanned++;
  if (!isFalseTruncationScore(d, show, f)) continue;
  hits.push({ f, showId, d, opened: openedMs(show) });
}
hits.sort((a, b) => b.opened - a.opened || a.f.localeCompare(b.f));

let picked = hits;
if (SAMPLE && hits.length > SAMPLE) {
  const step = hits.length / SAMPLE;
  picked = Array.from({ length: SAMPLE }, (_, i) => hits[Math.floor(i * step)]);
}
if (LIMIT) picked = picked.slice(0, LIMIT);

const byShow = {};
for (const h of picked) {
  byShow[h.showId] = (byShow[h.showId] || 0) + 1;
  if (APPLY) {
    h.d.needsRescore = true;
    h.d.rescoreReason = REASON;
    h.d.rescoreFlaggedAt = new Date().toISOString();
    delete h.d.rescoreCompletedAt;
    safeWriteReview(h.f, h.d, { force: true });
  }
}
console.log(`${APPLY ? 'Flagged' : 'Would flag'} ${picked.length} of ${hits.length} false-truncation scores (scanned ${scanned} files) across ${Object.keys(byShow).length} shows, reason=${REASON}`);
for (const [s, n] of Object.entries(byShow).slice(0, 15)) console.log(`  ${n}  ${s}`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(picked.map(h => ({ file: path.relative(ROOT, h.f), showId: h.showId, score: h.d.assignedScore })), null, 1));
if (!APPLY) for (const h of picked.slice(0, 15)) console.log(`  file ${path.relative(ROOT, h.f)} status=${h.d.llmMetadata.textSource.status} scoredAt=${h.d.llmMetadata.scoredAt} src=${h.d.scoreSource}`);
if (!APPLY) console.log('\n(dry run, pass --apply to write needsRescore flags)');
