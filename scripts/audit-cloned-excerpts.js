#!/usr/bin/env node
'use strict';

/**
 * audit-cloned-excerpts.js — BRO-4406. Finds same-show, same-outlet review
 * files that carry an IDENTICAL aggregator excerpt while BOTH are live in
 * reviews.json (double-counted phantom/duplicate reviews), classifies each
 * pair, and (with --apply) repairs it. Decision logic: lib/cloned-excerpt-guard.js.
 *
 * Usage:
 *   node scripts/audit-cloned-excerpts.js --live-only            # exit 1 if any live pair
 *   node scripts/audit-cloned-excerpts.js --live-only --json     # machine output
 *   node scripts/audit-cloned-excerpts.js --live-only --apply    # repair (review-texts clone, then push it + let CI rebuild)
 *   node scripts/audit-cloned-excerpts.js --show=ID              # one show
 *
 * "Live" = the file has a matching entry (show + outlet + critic) in
 * data/reviews.json AND carries no exclusion flag / duplicateOf. Keying on
 * show|url alone (the first scan's approach) marks BOTH files of a same-URL
 * pair live when reviews.json holds one row, overstating the problem ~5x.
 *
 * Repairs (only classes the evidence decides; unresolved pairs are reported):
 *   same-review  -> keep chooseCanonicalForRebuild's winner, fold the loser's
 *                   missing aggregator fields into it, delete the loser
 *                   (no flag-and-keep tombstone; see memory
 *                   feedback_outlet_merge_no_flag_and_keep).
 *   phantom      -> delete the web-search phantom.
 *   excerpt-copy -> null the copied excerpt fields on the non-owner and queue
 *                   a rescore from its own text.
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { EXCERPT_FIELDS } = require('./lib/excerpt-fields');
const guard = require('./lib/cloned-excerpt-guard');

const USAGE = `audit-cloned-excerpts.js — same-outlet cloned-excerpt (phantom/duplicate) review audit (BRO-4406).

Usage:
  node scripts/audit-cloned-excerpts.js [--live-only] [--apply] [--json] [--show=ID] [--review-texts-dir=PATH]

  --live-only   only pairs where BOTH files are live in reviews.json (exit 1 if any)
  --apply       repair same-review / phantom / excerpt-copy pairs (default: report only)
  --json        print the report as JSON
  --show=ID     restrict to one show directory
  --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');
const REVIEWS_JSON = path.join(ROOT, 'data', 'reviews.json');

function arg(args, name) {
  const m = args.find((a) => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : null;
}

function liveKey(showId, outletId, critic) {
  return `${showId}|${outletId}|${guard.normCritic(critic)}`;
}

function buildLiveIndex(reviews) {
  const idx = new Set();
  for (const r of reviews) idx.add(liveKey(r.showId, r.outletId, r.criticName));
  return idx;
}

function loadRecords(showDir) {
  const out = [];
  for (const f of fs.readdirSync(showDir)) {
    if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
    try {
      out.push({ file: f, data: JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')) });
    } catch { /* unreadable: not ours to judge */ }
  }
  return out;
}

/** Pairs in one show dir, with liveness and classification. */
function scanShow(showId, records, liveIdx, showDir) {
  const pairs = guard.findClonedPairs(records);
  return pairs.map(({ a, b, shared }) => {
    const live = (r) => !guard.isFileExcluded(r.data)
      && liveIdx.has(liveKey(showId, r.data.outletId || r.file.split('--')[0], r.data.criticName));
    const c = guard.classifyPair(a, b);
    if (c.cls === 'same-review') {
      const recMap = new Map([[a.file, a.data], [b.file, b.data]]);
      c.keep = pickCanonical({ a: a.file, b: b.file }, showDir, recMap).canonical;
    }
    return {
      showId, outlet: a.data.outletId || a.file.split('--')[0],
      a: a.file, b: b.file, live: live(a) && live(b), shared: shared[0].slice(0, 70), ...c,
    };
  });
}

function pickCanonical(p, showDir, recMap) {
  const other = (f) => (f === p.a ? p.b : p.a);
  // Attested beats guessed: a web-search record's byline is an LLM guess
  // (Isherwood at Variety, Stasio on a Suskin review); an aggregator-sourced
  // sibling carries the outlet's own byline. Then prefer the file whose name
  // prefix is its own outletId over a legacy alias-prefixed one.
  const ws = (f) => recMap.get(f).source === 'web-search';
  if (ws(p.a) !== ws(p.b)) { const c = ws(p.a) ? p.b : p.a; return { canonical: c, loser: other(c) }; }
  const home = (f) => f.split('--')[0] === recMap.get(f).outletId;
  if (home(p.a) !== home(p.b)) { const c = home(p.a) ? p.a : p.b; return { canonical: c, loser: other(c) }; }
  const { chooseCanonicalForRebuild } = require('./fix-circular-duplicate-pairs');
  const c = chooseCanonicalForRebuild(p.a, recMap.get(p.a), p.b, recMap.get(p.b), showDir);
  return c.canonical ? { canonical: c.canonical, loser: c.canonical === p.a ? p.b : p.a }
    : { canonical: c.keep || p.a, loser: (c.keep || p.a) === p.a ? p.b : p.a };
}

function foldAggregatorFields(canon, loser) {
  const fields = [...EXCERPT_FIELDS, 'dtliThumb', 'dtliUrl', 'bwwThumb', 'bwwRoundupUrl', 'showScoreUrl', 'playbillVerdictUrl'];
  for (const f of fields) {
    if ((canon[f] === undefined || canon[f] === null || canon[f] === '') && loser[f]) canon[f] = loser[f];
  }
  const srcs = new Set([...(canon.sources || [canon.source]), ...(loser.sources || [loser.source])].filter(Boolean));
  if (srcs.size > 1) canon.sources = [...srcs];
}

function apply(p, showDir) {
  const { safeWriteReview, safeUnlinkReview } = require('./lib/review-write-guard');
  const recMap = new Map(loadRecords(showDir).map((r) => [r.file, r.data]));
  if (!recMap.has(p.a) || !recMap.has(p.b)) return 'skipped: file already gone';
  if (p.cls === 'same-review') {
    const { canonical, loser } = pickCanonical(p, showDir, recMap);
    const canon = { ...recMap.get(canonical) };
    foldAggregatorFields(canon, recMap.get(loser));
    safeWriteReview(path.join(showDir, canonical), canon, { force: true });
    const r = safeUnlinkReview(path.join(showDir, loser), { force: true });
    return `same-review: kept ${canonical}, removed ${loser}${r.wrote === false && r.skipped ? ` (${r.skipped})` : ''}`;
  }
  if (p.cls === 'phantom') {
    const r = safeUnlinkReview(path.join(showDir, p.phantom), { force: true });
    return `phantom: removed ${p.phantom}${r.wrote === false && r.skipped ? ` (${r.skipped})` : ''}`;
  }
  if (p.cls === 'excerpt-copy') {
    const d = { ...recMap.get(p.stripFrom) };
    const shared = guard.sharedExcerpts(recMap.get(p.a), recMap.get(p.b));
    const fields = guard.fieldsHoldingExcerpts(d, shared);
    for (const f of fields) d[f] = null;
    // Its score may have been read off the copied excerpt: rescore from its own text.
    d.needsRescore = true;
    d.rescoreReason = 'BRO-4406-cloned-excerpt-stripped';
    safeWriteReview(path.join(showDir, p.stripFrom), d, { force: true });
    return `excerpt-copy: stripped ${fields.join(',')} from ${p.stripFrom} (owner ${p.owner})`;
  }
  return 'skipped: unresolved';
}

function run(argv) {
  const dir = arg(argv, 'review-texts-dir') || process.env.REVIEW_TEXTS_DIR || resolveReviewTextsDir();
  const only = arg(argv, 'show');
  const liveOnly = argv.includes('--live-only');
  const doApply = argv.includes('--apply');
  const liveIdx = buildLiveIndex(JSON.parse(fs.readFileSync(REVIEWS_JSON, 'utf8')).reviews);
  const report = [];
  for (const showId of listShowDirs(dir)) {
    if (only && showId !== only) continue;
    const showDir = path.join(dir, showId);
    let pairs = scanShow(showId, loadRecords(showDir), liveIdx, showDir);
    if (liveOnly) pairs = pairs.filter((p) => p.live);
    for (const p of pairs) {
      if (doApply && p.live) p.applied = apply(p, showDir);
      report.push(p);
    }
  }
  return { dir, report };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { process.stdout.write(USAGE); return 0; }
  const { dir, report } = run(argv);
  const live = report.filter((p) => p.live);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ dir, live: live.length, total: report.length, report }, null, 2));
  } else {
    console.error(`[audit-cloned-excerpts] review-texts: ${dir}`);
    for (const p of report) {
      console.log(`${p.live ? 'LIVE ' : 'other'} ${p.cls.padEnd(12)} ${p.showId} ${p.a} ~ ${p.b} — ${p.reason}${p.keep ? ` [keep ${p.keep}]` : ''}${p.applied ? ` => ${p.applied}` : ''}`);
    }
    const by = {};
    for (const p of live) by[p.cls] = (by[p.cls] || 0) + 1;
    console.log(`\nlive cloned pairs: ${live.length} ${JSON.stringify(by)} (all pairs scanned: ${report.length})`);
  }
  // With --apply the remaining state is unknown until reviews.json rebuilds; re-run to gate.
  return live.length && !argv.includes('--apply') ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { buildLiveIndex, scanShow, liveKey, run };
