/**
 * outlet-url-attribution.test.mjs — outletId must agree with the review URL.
 *
 * Generalises timeout-london-attribution.test.mjs (which only compares the
 * timeout / timeout-london pair) after 2026-09-29:
 *   - sweep-we-aggregators.js re-created my-neighbour-totoro-west-end-2025/
 *     timeout--andrzej-lukowski.json as outletId "timeout" for a
 *     timeout.com/london URL (name-derived outletId, URL ignored);
 *   - just-in-time-2025 had a timeout.com/newyork review filed as "nytimes"
 *     — a T1 weight on another outlet's review. The pair-only check could
 *     never see that: its outletId was neither timeout id.
 *
 * Two corpus checks:
 *   1. Path-split edition hosts (review-normalization PATH_SPLIT_EDITION_HOSTS,
 *      via resolveOutletFromUrlIfPathInformed): ANY file on such a host whose
 *      outletId disagrees with the URL's edition, whatever that outletId is,
 *      excluded or not — rebuild's outlet-mismatch pass rewrites these, so a
 *      surviving one means a writer or that pass regressed.
 *   2. T1 outlets on another registered outlet's domain (isCrossOutletUrl,
 *      which already exempts wire services, the outlet's own domainAliases
 *      and undeclared shared domains), not an aggregator. Limited to files
 *      that are NOT exclusion-flagged: that is where a wrong outletId moves a
 *      score. Measured 2026-09-29 on the full corpus: 12 T1 files have this
 *      shape and all 12 are already excluded (wrong production, roundup,
 *      duplicate), so the live count is 0 with no allow-list. Syndication
 *      relays (AOL/MSN/Yahoo republish Guardian/Telegraph reviews verbatim)
 *      are genuine and allow-listed by host below.
 *
 * Plus unit coverage of resolveUrlEditionOutletId (outlet-canonicalize.js),
 * the helper the bespoke writers now call.
 *
 * Corpus layers use the same presence contract as
 * timeout-london-attribution.test.mjs: skipped without a corpus, hard-failed
 * under REQUIRE_REVIEW_CORPUS=1.
 *
 * Run: node --test scripts/lib/outlet-url-attribution.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  resolveOutletFromUrl,
  resolveOutletFromUrlIfPathInformed,
  isCrossOutletUrl,
  getOutletTier,
  normalizeOutlet,
} = require_('./review-normalization.js');
const { resolveUrlEditionOutletId } = require_('./outlet-canonicalize.js');
const { AGGREGATOR_OUTLET_IDS } = require_('./aggregator-domains.js');
const { isExclusionFlagged } = require_('./merge-review-fields.js');
const { resolveReviewTextsDir } = require_('./review-texts-dir.js');

// Hosts that republish other outlets' reviews verbatim. A T1 review whose URL
// is one of these is the T1 outlet's own review, not a misattribution.
const SYNDICATION_RELAY_HOSTS = new Set([
  'aol.com', 'aol.co.uk', // the-smile-of-her-off-west-end-2026 Guardian/Arifa Akbar via aol.co.uk
  'msn.com', 'yahoo.com', 'news.yahoo.com', 'uk.news.yahoo.com',
]);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

function* corpusFiles(reviewTextsDir) {
  if (!fs.existsSync(reviewTextsDir)) return;
  for (const showDir of fs.readdirSync(reviewTextsDir)) {
    if (showDir.startsWith('_') || showDir.startsWith('.')) continue;
    const showPath = path.join(reviewTextsDir, showDir);
    let stat;
    try { stat = fs.statSync(showPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const file of fs.readdirSync(showPath)) {
      if (!file.endsWith('.json')) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(showPath, file), 'utf8')); } catch { continue; }
      if (data && typeof data.url === 'string' && data.url && data.outletId) yield { file: `${showDir}/${file}`, data };
    }
  }
}

/** Check 1: any outletId on a path-split edition host that disagrees with the URL. */
function findPathSplitEditionMisattributions(reviewTextsDir) {
  const out = [];
  for (const { file, data } of corpusFiles(reviewTextsDir)) {
    const resolved = resolveOutletFromUrlIfPathInformed(data.url);
    if (resolved && resolved.outletId !== normalizeOutlet(data.outletId)) {
      out.push({ file, outletId: data.outletId, url: data.url, expected: resolved.outletId });
    }
  }
  return out;
}

/** Check 2: a non-excluded T1 file whose URL is another registered outlet's. */
function findT1CrossOutletMisattributions(reviewTextsDir) {
  const out = [];
  for (const { file, data } of corpusFiles(reviewTextsDir)) {
    if (isExclusionFlagged(data)) continue;
    const id = normalizeOutlet(data.outletId);
    if (getOutletTier(id) !== 1) continue;
    if (resolveOutletFromUrlIfPathInformed(data.url)) continue; // check 1's job
    if (SYNDICATION_RELAY_HOSTS.has(hostOf(data.url))) continue;
    if (!isCrossOutletUrl(id, data.url)) continue;
    const resolved = resolveOutletFromUrl(data.url);
    if (!resolved || AGGREGATOR_OUTLET_IDS.has(resolved.outletId)) continue;
    out.push({ file, outletId: data.outletId, url: data.url, urlOutlet: resolved.outletId });
  }
  return out;
}

// ── the Time Out path split itself ──────────────────────────────────────────

test('Time Out editions: /newyork (and non-city paths) -> timeout; /london, /uk, timeout.co.uk -> timeout-london; other cities -> unresolved', () => {
  const id = (u) => resolveOutletFromUrl(u)?.outletId ?? null;
  assert.equal(id('https://www.timeout.com/newyork/theater/x'), 'timeout');
  assert.equal(id('https://www.timeout.com/theater-reviews/x'), 'timeout'); // long-standing NY convention
  assert.equal(id('https://www.timeout.com/london/theatre/x'), 'timeout-london');
  assert.equal(id('https://www.timeout.com/uk/theatre/x'), 'timeout-london');
  assert.equal(id('https://www.timeout.co.uk/anything'), 'timeout-london');
  // Neither registered outlet: never T1 Time Out New York.
  for (const city of ['chicago', 'sydney', 'melbourne', 'edinburgh', 'australia', 'los-angeles']) {
    assert.equal(id(`https://www.timeout.com/${city}/theater/x`), null, city);
    assert.equal(resolveOutletFromUrlIfPathInformed(`https://www.timeout.com/${city}/theater/x`), null, city);
  }
  // …so a name-derived id stands for them.
  assert.equal(resolveUrlEditionOutletId({ outletName: 'Time Out Chicago', url: 'https://www.timeout.com/chicago/theater/x' }).source, 'name');
});

// ── resolveUrlEditionOutletId (the writers' helper) ─────────────────────────

test('resolveUrlEditionOutletId: the URL edition beats a name-derived id, both directions', () => {
  const london = 'https://www.timeout.com/london/theatre/my-neighbour-totoro-review';
  const newyork = 'https://www.timeout.com/newyork/theater/just-in-time-review';
  assert.deepEqual(
    resolveUrlEditionOutletId({ outletName: 'Time Out', url: london }),
    { outletId: 'timeout-london', displayName: 'Time Out London', source: 'url-edition' },
  );
  assert.equal(resolveUrlEditionOutletId({ outletId: 'timeout', url: london }).outletId, 'timeout-london');
  assert.equal(resolveUrlEditionOutletId({ outletId: 'nytimes', url: newyork }).outletId, 'timeout');
  assert.equal(resolveUrlEditionOutletId({ outletId: 'timeout-london', url: newyork }).outletId, 'timeout');
});

test('resolveUrlEditionOutletId: the name stands off the edition hosts and without a URL', () => {
  const byName = (o) => resolveUrlEditionOutletId(o).source;
  assert.equal(byName({ outletId: 'timeout-london', url: 'https://www.timeout.com/london/theatre/x' }), 'name');
  assert.equal(byName({ outletName: 'Time Out' }), 'name');
  // Cross-domain is deliberately NOT rewritten by writers: the Observer (UK)
  // publishes on theguardian.com, and T1 reviews syndicate to aol/msn.
  assert.equal(resolveUrlEditionOutletId({ outletId: 'observer', url: 'https://www.theguardian.com/stage/x' }).outletId, 'observer');
  assert.equal(resolveUrlEditionOutletId({ outletId: 'guardian', url: 'https://www.aol.co.uk/articles/x' }).outletId, 'guardian');
  assert.equal(resolveUrlEditionOutletId({ outletId: 'sunday-telegraph', url: 'https://www.telegraph.co.uk/theatre/x' }).outletId, 'sunday-telegraph');
  assert.equal(resolveUrlEditionOutletId({ outletName: 'The Guardian', url: 'https://www.theguardian.com/stage/x' }).outletId, 'guardian');
});

// ── corpus helpers against a fixture ────────────────────────────────────────

test('corpus checks: flag both shapes, skip clean / excluded / relay / aggregator files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlet-url-attribution-'));
  try {
    const show = path.join(tmpDir, 'show-a');
    fs.mkdirSync(show);
    const w = (f, d) => fs.writeFileSync(path.join(show, f), JSON.stringify(d));
    // Check 1 violations, including an outletId that is neither timeout id.
    w('timeout--one.json', { outletId: 'timeout', url: 'https://www.timeout.com/london/theatre/a' });
    w('nytimes--two.json', { outletId: 'nytimes', url: 'https://www.timeout.com/newyork/theater/b' });
    // Check 1 applies even when excluded (the rebuild pass rewrites these).
    w('the-answer-is--three.json', { outletId: 'the-answer-is', url: 'https://www.timeout.com/newyork/blog/c', rejectionReason: 'garbage' });
    // Clean edition files.
    w('timeout-london--four.json', { outletId: 'timeout-london', url: 'https://www.timeout.com/london/theatre/d' });
    // Check 2 violation: live T1 on another registered outlet's domain.
    w('vulture--five.json', { outletId: 'vulture', url: 'https://www.nbcnewyork.com/entertainment/the-scene/e.html' });
    // Check 2 skips: excluded, syndication relay, aggregator URL, own domain, non-T1.
    w('vulture--six.json', { outletId: 'vulture', url: 'https://www.nbcnewyork.com/f.html', wrongProduction: true });
    w('guardian--seven.json', { outletId: 'guardian', url: 'https://www.aol.co.uk/articles/g' });
    w('guardian--eight.json', { outletId: 'guardian', url: 'https://www.westendtheatre.com/123/news/reviews/h' });
    w('nytimes--nine.json', { outletId: 'nytimes', url: 'https://www.nytimes.com/2026/01/01/theater/i.html' });
    w('observer--ten.json', { outletId: 'observer', url: 'https://www.theguardian.com/stage/j' });
    // Another city edition resolves to nothing, so check 1 has no opinion.
    w('timeout--twelve.json', { outletId: 'timeout', url: 'https://www.timeout.com/chicago/theater/l' });
    // Stale previousUrl never counts.
    w('timeout--eleven.json', { outletId: 'timeout', url: 'https://www.timeout.com/newyork/theater/k', previousUrl: 'https://www.timeout.com/london/theatre/old' });

    assert.deepEqual(
      findPathSplitEditionMisattributions(tmpDir).map(v => v.file).sort(),
      ['show-a/nytimes--two.json', 'show-a/the-answer-is--three.json', 'show-a/timeout--one.json'],
    );
    assert.deepEqual(findT1CrossOutletMisattributions(tmpDir).map(v => v.file), ['show-a/vulture--five.json']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('corpus checks: a missing directory is not an error', () => {
  assert.deepEqual(findPathSplitEditionMisattributions('/nonexistent/for/sure'), []);
  assert.deepEqual(findT1CrossOutletMisattributions('/nonexistent/for/sure'), []);
});

// ── Real corpus ─────────────────────────────────────────────────────────────

const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
const MIN_CORPUS_ENTRIES = 10;

function corpusUsable() {
  const ok = fs.existsSync(REVIEW_TEXTS_DIR) && fs.readdirSync(REVIEW_TEXTS_DIR).length > MIN_CORPUS_ENTRIES;
  if (REQUIRE_CORPUS) {
    assert.ok(ok, `REQUIRE_REVIEW_CORPUS=1 but ${REVIEW_TEXTS_DIR} isn't a real corpus (>${MIN_CORPUS_ENTRIES} entries expected)`);
    return true;
  }
  return ok;
}
const SKIP = !corpusUsable() && `no usable corpus at ${REVIEW_TEXTS_DIR} (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)`;

test('real corpus: zero path-split edition misattributions (any outletId)', { skip: SKIP }, () => {
  const v = findPathSplitEditionMisattributions(REVIEW_TEXTS_DIR);
  assert.deepEqual(v, [], `found ${v.length} (fix: node scripts/heal-outlet-mismatch.js --apply): ${JSON.stringify(v, null, 2)}`);
});

test('real corpus: zero live T1 reviews on another registered outlet\'s URL', { skip: SKIP }, () => {
  const v = findT1CrossOutletMisattributions(REVIEW_TEXTS_DIR);
  assert.deepEqual(v, [], `found ${v.length}: ${JSON.stringify(v, null, 2)}`);
});
