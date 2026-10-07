/**
 * TLD parity fence for AGGREGATOR_DOMAINS (task #1194).
 *
 * INCIDENT: AGGREGATOR_DOMAINS carried westendtheatre.co.uk while the live West End
 * aggregator — and every one of its ~28+ corpus files — used westendtheatre.com. The
 * guard was silently vacuous for the largest aggregator in the corpus: 66+ real-outlet
 * files on that domain went completely unchecked by the aggregator_url_mismatch gate.
 *
 * PART 1 (static, always runs): pins the domains actually observed in the corpus per
 * aggregator outletId, measured 2026-08-12 via a full scan of broadway-review-texts
 * (see task #1194 card for the scan command/counts). AGGREGATOR_DOMAINS must carry
 * every one of them — this is the class of gap that made the WET domain vacuous.
 *
 * PART 2 (dynamic, skips if data/review-texts isn't checked out — it isn't in the
 * unit-tests job that runs this glob): re-derives the same table live from whatever
 * corpus IS present (a local dev run, or a future CI job that adds the checkout), so
 * a brand-new TLD drift is caught without waiting for someone to notice and re-pin.
 *
 * PART 3: the score carve-out this TLD fix depends on — a real-outlet star-stub
 * carrying aggregatorStars/originalScore on an aggregator domain must NOT be
 * aggregator_url_mismatch (it is the documented star-stub shape, 2026-06-22 WET
 * false-positive incident), while the same URL/outlet with no score MUST be.
 *
 * Run: node --test scripts/lib/aggregator-domain-tld-parity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AGGREGATOR_DOMAINS, AGGREGATOR_OUTLET_IDS } = require('./aggregator-domains.js');
const { hasAggregatorUrlMismatch } = require('./aggregator-url-latent.js');

// ---------------------------------------------------------- Part 1: pinned snapshot

// Domains actually seen in the corpus for each aggregator outletId, measured
// 2026-08-12 (42,409 review-text files scanned). Update this table (and re-measure)
// if an aggregator legitimately moves domains; do NOT delete an entry to make a
// missing domain pass — that is exactly the silent-gap failure mode this pins against.
const OBSERVED_DOMAINS_BY_OUTLET = {
  'london-box-office': ['londonboxoffice.co.uk'],
  'dtli': ['didtheylikeit.com'],
  'theatre-reviews-limited': ['theatrereviews.com'],
  'westendtheatre': ['westendtheatre.com'],
  'show-score': ['show-score.com'],
};

test('AGGREGATOR_DOMAINS carries every domain observed in the corpus for each aggregator outlet', () => {
  for (const [outletId, domains] of Object.entries(OBSERVED_DOMAINS_BY_OUTLET)) {
    assert.ok(AGGREGATOR_OUTLET_IDS.has(outletId), `${outletId} must itself be a known aggregator outlet id`);
    for (const domain of domains) {
      assert.ok(
        AGGREGATOR_DOMAINS.has(domain),
        `AGGREGATOR_DOMAINS is missing "${domain}" (observed in the corpus for outletId "${outletId}") — `
        + 'this is the westendtheatre.co.uk vs .com class of gap (#1194): the guard goes silently vacuous '
        + 'for every real-outlet file on that domain.',
      );
    }
  }
});

// ------------------------------------------------------- Part 2: live corpus re-scan

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.join(__dirname, '..', '..');
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(REPO_ROOT, 'data', 'review-texts');
// This layer only means something with the corpus checked out (unit-tests job does
// NOT check it out — see .github/workflows/test.yml comment on checkout-review-texts).
// A silent t.skip() there would make "the TLD fence is green" mean "it never ran" —
// exactly the failure class this test exists to prevent (task #1194, echoing #902's
// review-guards.explain.test.mjs). CI sets REQUIRE_REVIEW_CORPUS=1 on the ONE job that
// checks review-texts out (Data Validation), turning a missing corpus into a hard
// failure there instead of a silent pass.
const REQUIRE_CORPUS = process.env.REQUIRE_REVIEW_CORPUS === '1';

test('live corpus scan: no aggregator-outlet domain is missing from AGGREGATOR_DOMAINS', (t) => {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but no corpus at ${REVIEW_TEXTS_DIR} — the review-texts checkout did not land, so this scan would have silently skipped. Fix the checkout rather than unsetting the flag.`,
    );
    t.skip(`no corpus at ${REVIEW_TEXTS_DIR} (run ./scripts/setup-local-data.sh, or set REVIEW_TEXTS_DIR)`);
    return;
  }

  const missing = new Map(); // domain -> outletId (first offender)
  let scanned = 0;

  for (const showId of fs.readdirSync(REVIEW_TEXTS_DIR)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let stat;
    try { stat = fs.lstatSync(showDir); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;

    let files;
    try { files = fs.readdirSync(showDir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8')); } catch { continue; }
      if (!data.url || !data.outletId || !AGGREGATOR_OUTLET_IDS.has(data.outletId)) continue;
      let hostname;
      try { hostname = new URL(data.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { continue; }
      scanned++;
      if (!AGGREGATOR_DOMAINS.has(hostname) && !missing.has(hostname)) {
        missing.set(hostname, data.outletId);
      }
    }
  }

  // A near-zero scan means the checkout is missing/truncated, not that the corpus
  // is clean — don't let a blind scan report a false pass.
  if (scanned < 10) {
    assert.ok(
      !REQUIRE_CORPUS,
      `REQUIRE_REVIEW_CORPUS=1 but only ${scanned} aggregator-outlet files found at ${REVIEW_TEXTS_DIR} — the checkout looks empty or truncated, so this scan would have been vacuous. Fix the checkout rather than unsetting the flag.`,
    );
    t.skip(`only ${scanned} aggregator-outlet files found at ${REVIEW_TEXTS_DIR} — checkout looks empty/truncated`);
    return;
  }

  assert.deepEqual(
    [...missing.entries()],
    [],
    `AGGREGATOR_DOMAINS is missing domain(s) actually in use by known aggregator outlets: ${JSON.stringify([...missing.entries()])}`,
  );
});

// ---------------------------------------------------------- Part 3: the score carve-out

test('a scored real-outlet star-stub on an aggregator domain is NOT aggregator_url_mismatch', () => {
  const starStub = {
    outletId: 'telegraph',
    url: 'https://westendtheatre.com/some-roundup/',
    aggregatorStars: '4/5',
  };
  assert.equal(hasAggregatorUrlMismatch(starStub), false);

  const scoredStub = {
    outletId: 'guardian',
    url: 'https://theatrereviews.com/some-roundup/',
    originalScore: '3/5 stars',
  };
  assert.equal(hasAggregatorUrlMismatch(scoredStub), false);
});

test('an UNSCORED real-outlet URL on an aggregator domain IS aggregator_url_mismatch', () => {
  // The exact shape from the #1194 card: 2 files with no score to preserve.
  const unscored = {
    outletId: 'telegraph',
    url: 'https://www.westendtheatre.com/reviews-roundup/dracula-reviews/',
  };
  assert.equal(hasAggregatorUrlMismatch(unscored), true);

  const unscoredTr = {
    outletId: 'nottingham-confidential',
    url: 'https://westendtheatre.com/reviews-roundup/totoro-reviews/',
    aggregatorStars: null,
    originalScore: null,
  };
  assert.equal(hasAggregatorUrlMismatch(unscoredTr), true);
});

test('an aggregator outlet carrying its own domain is never a mismatch, scored or not', () => {
  assert.equal(hasAggregatorUrlMismatch({ outletId: 'westendtheatre', url: 'https://westendtheatre.com/reviews-roundup/x/' }), false);
  assert.equal(hasAggregatorUrlMismatch({ outletId: 'theatre-reviews-limited', url: 'https://theatrereviews.com/review/x/', originalScore: '4/5' }), false);
});

test('a real outlet on its own (non-aggregator) domain is never a mismatch', () => {
  assert.equal(hasAggregatorUrlMismatch({ outletId: 'telegraph', url: 'https://www.telegraph.co.uk/theatre/2026/dracula-review/' }), false);
});
