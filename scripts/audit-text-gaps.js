#!/usr/bin/env node
/**
 * Text-gap metric: how many review-text files are not complete, and why.
 * READ-ONLY on the corpus. Classes: scripts/lib/text-gap-classify.js.
 *
 * Usage:
 *   node scripts/audit-text-gaps.js --summary                         # totals + class split
 *   node scripts/audit-text-gaps.js --summary --by=outlet,class       # also per-outlet tables
 *   node scripts/audit-text-gaps.js --summary --recent                # only shows opened within 730 days
 *   node scripts/audit-text-gaps.js --summary --outlet=guardian,standard
 *   node scripts/audit-text-gaps.js --summary --show=hamilton-2015
 *   node scripts/audit-text-gaps.js --summary --retier                # count each file at the tier the next rebuild would store
 *   node scripts/audit-text-gaps.js --summary --now=2026-11-08        # fix "today" (recency window) for repeatable numbers
 *   node scripts/audit-text-gaps.js --dir=/path/to/review-texts --out=/tmp/m.json
 *
 * Writes data/audit/text-gap-metric.json on an unfiltered run (no --outlet,
 * --show, --recent, --retier); a filtered run writes only with --out=PATH.
 * --no-write never writes. Nothing is ever written inside the corpus.
 *
 * Why --retier: the stored tier lags the classifier until rebuild-all-reviews.js
 * runs. Without it the FALSE_TRUNCATION_SUSPECT class shows the files a rebuild
 * is about to upgrade; with it they are already COMPLETE. Run both with
 * TRAILER_FIXES_DISABLED=true and without to see what the trailer fix changes.
 */

'use strict';

require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { scanCorpus, buildMetric, GAP_CLASSES } = require('./lib/text-gap-metric');

function arg(name, def = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

const ROOT = path.join(__dirname, '..');
const dir = arg('dir') || resolveReviewTextsDir();
const by = (arg('by') || '').split(',').filter(Boolean);
const recentOnly = flag('recent');
const outletFilter = arg('outlet') ? new Set(arg('outlet').split(',').filter(Boolean)) : null;
const showFilter = arg('show');
const retier = flag('retier');
const nowArg = arg('now');
const nowMs = nowArg ? Date.parse(`${nowArg}T00:00:00Z`) : Date.now();
const outPath = arg('out');

if (!Number.isFinite(nowMs)) { console.error(`bad --now=${nowArg}`); process.exit(2); }
if (!fs.existsSync(dir)) { console.error(`review-texts dir not found: ${dir}`); process.exit(2); }

function readJson(p, what) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    console.error(`cannot read ${what} (${p}): ${e.message}`);
    process.exit(2);
  }
}
const showsRaw = readJson(path.join(ROOT, 'data', 'shows.json'), 'shows.json');
const shows = new Map((Array.isArray(showsRaw) ? showsRaw : showsRaw.shows || []).filter((s) => s && s.id).map((s) => [s.id, s]));
const outletsRaw = readJson(path.join(ROOT, 'data', 'outlet-registry.json'), 'outlet-registry.json');
const outlets = outletsRaw.outlets || outletsRaw;

let tierOf = null;
if (retier) {
  const { classifyTierWriteBack } = require('./lib/content-tier-reason-sync');
  tierOf = (review) => classifyTierWriteBack(review).tierResult.contentTier;
}

const scan = scanCorpus({ dir, shows, outlets, nowMs, outletFilter, showFilter, tierOf });
const metric = buildMetric(scan.rows, { recentOnly });
const out = {
  generatedAt: new Date().toISOString(),
  now: new Date(nowMs).toISOString().slice(0, 10),
  reviewTextsDir: dir,
  filters: { recent: recentOnly, outlets: outletFilter ? [...outletFilter] : null, show: showFilter, retier },
  trailerFixesEnabled: process.env.TRAILER_FIXES_DISABLED !== 'true',
  filesRead: scan.filesRead,
  unreadable: scan.unreadable,
  excludedSidecars: scan.excludedSidecars,
  ...metric,
};

const num = (n) => Number(n || 0).toLocaleString('en-US');
const scope = recentOnly ? ' (recent shows only)' : '';
console.log(`review-texts: ${dir}`);
console.log(`today: ${out.now}   filters: ${JSON.stringify(out.filters)}   trailer fixes: ${out.trailerFixesEnabled ? 'on' : 'off'}`);
console.log(`files read: ${num(out.filesRead)}   excludedSidecars: ${out.excludedSidecars}   unreadable: ${out.unreadable}`);
console.log(`excluded (duplicate/wrong show/production/roundup): ${num(out.excluded)}   complete: ${num(out.complete)}   terminal: ${num(out.terminal)}`);
console.log(`OPEN${scope}: ${num(out.open)}   of which recent (opened within 730 days): ${num(out.openRecent)}   (recent shows with no date: ${num(out.recentDateUnknown)} files)`);
console.log(`incomplete files flagged isNonReview (excluded above; the plan's 8,365 baseline counted them): ${num(out.nonReviewIncomplete)}, recent ${num(out.nonReviewIncompleteRecent)}   => open on the plan-baseline definition: ${num(out.open + out.nonReviewIncomplete)}, recent ${num(out.openRecent + out.nonReviewIncompleteRecent)}`);
console.log(`pollutedReasonCount (incompleteReason outside the enum): ${num(out.pollutedReasonCount)}\n`);

console.log('class'.padEnd(26) + 'open'.padStart(8) + 'recent'.padStart(8));
for (const c of GAP_CLASSES) {
  if (!out.byClass[c]) continue;
  console.log(c.padEnd(26) + num(out.byClass[c]).padStart(8) + num(out.byClassRecent[c] || 0).padStart(8));
}
const subs = Object.entries(out.subclasses).sort((a, b) => b[1] - a[1]);
if (subs.length) {
  console.log('\nsubclasses: ' + subs.map(([k, v]) => `${k}=${v}`).join('  '));
}

if (by.includes('outlet') || by.includes('class')) {
  const rows = Object.entries(out.byOutlet).sort((a, b) => b[1].open - a[1].open).slice(0, 30);
  console.log('\n' + 'outlet'.padEnd(28) + 'open'.padStart(7) + 'recent'.padStart(8) + (by.includes('class') ? '  classes' : ''));
  for (const [o, v] of rows) {
    const cls = by.includes('class')
      ? '  ' + Object.entries(out.byOutletClass[o]).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')
      : '';
    console.log(o.padEnd(28) + num(v.open).padStart(7) + num(v.openRecent).padStart(8) + cls);
  }
}

const filtered = recentOnly || outletFilter || showFilter || retier;
let target = outPath;
if (!target && !filtered && !flag('no-write')) target = path.join(ROOT, 'data', 'audit', 'text-gap-metric.json');
if (flag('no-write')) target = null;
if (target) {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    console.error('refusing to write inside the review-texts corpus');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${target}`);
}
