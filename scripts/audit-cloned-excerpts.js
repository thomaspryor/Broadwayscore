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
  return pairs.map(({ a, b, shared, via }) => {
    const live = (r) => !guard.isFileExcluded(r.data)
      && liveIdx.has(liveKey(showId, r.data.outletId || r.file.split('--')[0], r.data.criticName));
    const c = guard.classifyPair(a, b);
    if (c.cls === 'same-review') {
      const recMap = new Map([[a.file, a.data], [b.file, b.data]]);
      c.keep = pickCanonical({ a: a.file, b: b.file }, showDir, recMap).canonical;
    }
    return {
      showId, outlet: a.data.outletId || a.file.split('--')[0],
      a: a.file, b: b.file, live: live(a) && live(b), shared: shared.length ? shared[0].slice(0, 70) : (via || ''), ...c,
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
  // A web-search loser's excerpt fields are LLM-invented text (Feldman's
  // "timeless and urgently contemporary" blurb was in no aggregator); folding
  // them into the survivor would launder a hallucination into the real review.
  if (loser.source === 'web-search') return;
  const fields = [...EXCERPT_FIELDS, 'dtliThumb', 'dtliUrl', 'bwwThumb', 'bwwRoundupUrl', 'showScoreUrl', 'playbillVerdictUrl'];
  for (const f of fields) {
    if ((canon[f] === undefined || canon[f] === null || canon[f] === '') && loser[f]) canon[f] = loser[f];
  }
  const srcs = new Set([...(canon.sources || [canon.source]), ...(loser.sources || [loser.source])].filter(Boolean));
  if (srcs.size > 1) canon.sources = [...srcs];
}


/**
 * Files already marked duplicate of a file we are about to delete would be
 * cascade-cleared by safeUnlinkReview and come back LIVE (the-outsiders-2024:
 * a third byline pointed at the deleted twin and re-entered the composite).
 * Retarget them at the survivor when they are the same article (same
 * canonical url); delete text-less stubs (nothing to preserve); otherwise
 * leave them to the cascade and let the next audit run report them.
 */
function reparentDependents(showDir, recMap, removed, survivor) {
  const { safeWriteReview, safeUnlinkReview } = require('./lib/review-write-guard');
  const notes = [];
  const survivorUrl = guard.canonUrl(recMap.get(survivor).url);
  for (const [f, d] of recMap) {
    if (f === removed || f === survivor) continue;
    const field = d.duplicateOf === removed ? 'duplicateOf' : d.duplicateTextOf === removed ? 'duplicateTextOf' : null;
    if (!field) continue;
    const sameUrl = survivorUrl && guard.canonUrl(d.url) === survivorUrl;
    if (sameUrl || !d.url) {
      safeWriteReview(path.join(showDir, f), { ...d, [field]: survivor }, { force: true });
      notes.push(`${f} ${field}->${survivor}`);
    } else if (((d.fullText || '').length) < 100) {
      safeUnlinkReview(path.join(showDir, f), { force: true });
      notes.push(`${f} stub removed`);
    }
  }
  return notes;
}

function apply(p, showDir) {
  const { safeWriteReview, safeUnlinkReview, writeReviewOrThrow } = require('./lib/review-write-guard');
  const recMap = new Map(loadRecords(showDir).map((r) => [r.file, r.data]));
  if (!recMap.has(p.a) || !recMap.has(p.b)) return 'skipped: file already gone';
  // force:true below bypasses the write guard's lock; a locked file is an owner decision, not ours to delete/rewrite.
  if (recMap.get(p.a)._locked === true || recMap.get(p.b)._locked === true) return 'skipped: _locked file, needs owner review';
  if (p.cls === 'same-review') {
    const { canonical, loser } = pickCanonical(p, showDir, recMap);
    // Both live twins are web-search guesses, but an already-excluded sibling
    // that points at one of them is the attested record (aggregator-sourced,
    // real url): promote IT and delete the guesses (the-outsiders-2024: two
    // null-url web-search bylines live, the real show-score Variety review
    // suppressed as their duplicate).
    if (recMap.get(canonical).source === 'web-search') {
      const promo = [...recMap].find(([f, d]) => f !== p.a && f !== p.b
        && (d.duplicateOf === p.a || d.duplicateOf === p.b || d.duplicateOf === canonical || d.duplicateOf === loser)
        && d.source !== 'web-search' && d.url && guard.isSameReview(d, recMap.get(canonical)).same);
      if (promo) {
        const [pf, pd] = promo;
        const promoted = { ...pd, duplicateOf: null, duplicateReason: null, duplicateClearReason: 'BRO-4406: attested record promoted over web-search guesses' };
        foldAggregatorFields(promoted, recMap.get(canonical));
        foldAggregatorFields(promoted, recMap.get(loser));
        writeReviewOrThrow(path.join(showDir, pf), promoted, { force: true });
        for (const f of [canonical, loser]) safeUnlinkReview(path.join(showDir, f), { force: true });
        return `same-review: promoted ${pf} (attested), removed web-search ${canonical}, ${loser}`;
      }
    }
    const canon = { ...recMap.get(canonical) };
    foldAggregatorFields(canon, recMap.get(loser));
    // A canonical living in a `--unknown` file beside a named twin of the same
    // critic: keep the CONTENT but under the named filename, so the next
    // aggregator ingest (which writes `--<critic-slug>`) lands on this file
    // instead of re-creating the twin.
    const slug = (f) => f.replace(/\.json$/, '').split('--').slice(1).join('--');
    let survivor = canonical;
    let removed = loser;
    if (slug(canonical) === 'unknown' && slug(loser) !== 'unknown' && guard.sameCritic(recMap.get(canonical), recMap.get(loser))) {
      survivor = loser;
      removed = canonical;
    }
    writeReviewOrThrow(path.join(showDir, survivor), canon, { force: true });
    const moved = reparentDependents(showDir, recMap, removed, survivor);
    const r = safeUnlinkReview(path.join(showDir, removed), { force: true });
    return `${moved.length ? `[${moved.join('; ')}] ` : ''}same-review: kept ${survivor}${survivor !== canonical ? ` (content of ${canonical})` : ''}, removed ${removed}${r.wrote === false && r.skipped ? ` (${r.skipped})` : ''}`;
  }
  if (p.cls === 'phantom') {
    const keeper = p.phantom === p.a ? p.b : p.a;
    const moved = reparentDependents(showDir, recMap, p.phantom, keeper);
    const r = safeUnlinkReview(path.join(showDir, p.phantom), { force: true });
    return `${moved.length ? `[${moved.join('; ')}] ` : ''}phantom: removed ${p.phantom}${r.wrote === false && r.skipped ? ` (${r.skipped})` : ''}`;
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
      if (doApply && p.live) {
        try { p.applied = apply(p, showDir); } catch (e) { p.applied = `ERROR (pair left untouched or half-done, re-run audit): ${e.message}`; }
      }
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
