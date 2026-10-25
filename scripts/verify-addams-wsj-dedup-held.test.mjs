/**
 * BRO-3092 acceptance recheck — did the deletion actually stay deleted?
 *
 * Reads the LIVE corpus, not a fixture (same shape as
 * scripts/verify-provider-spend-streak.test.mjs). This exists because the
 * first fix for BRO-3092 looked done and was not:
 *
 *   14:50Z  the-addams-family-2010/wsj--unknown.json deleted + pushed. Its
 *           6.6KB "fullText" is a WSJ registration interstitial, its byline is
 *           Unknown, and it held the same URL as the correctly-attributed
 *           wsj--terry-teachout.json — the same-URL duplicate validate-data.js
 *           errors on.
 *   15:19Z  enrich-reviews (which had stamped the file's classifiedAt at
 *           14:46Z and so held it dirty) pushed it straight back, byte-
 *           identical, via push-review-texts' `git pull --rebase --autostash`
 *           + `git add -A`.
 *
 * The producer-side fix is validate-added-review-ownership.js, which now drops
 * SAME-show URL re-creations at push time and not only cross-show ones. But
 * that fix only proves itself the next time a stale-checkout replay happens —
 * a later enrich-reviews cycle — so the claim cannot be verified at the moment
 * it is made. This test is the durable check that
 * scripts/autonomous-acceptance-recheck.js re-runs against fresh origin/main
 * once the RECHECK-AFTER date passes.
 *
 * Skips (rather than fails) when the review corpus is not checked out, so it
 * is inert in the unit-test job; set REQUIRE_REVIEW_CORPUS=1 to make a missing
 * corpus a hard failure the way the data-validation job does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// resolveReviewTextsDir(), NOT path.join(REPO, 'data', 'review-texts'):
// data/review-texts is gitignored and lives only in the main checkout, so a
// hardcoded repo-relative path resolves to nothing inside a git worktree —
// including the `git worktree add` sandbox acceptance-check-core.js's
// makeFreshCheckout() builds. The test would then skip, exit 0, and
// autonomous-acceptance-recheck.js would record PASS without ever reading the
// corpus: a false all-clear from the very mechanism that is supposed to make
// this claim durable. verify-frankie-2002-cleanup.test.mjs uses the resolver
// for exactly this reason.
const { resolveReviewTextsDir } = require('./lib/review-texts-dir.js');
const REVIEW_TEXTS_DIR = resolveReviewTextsDir();
const SHOW = 'the-addams-family-2010';
const SHOW_DIR = path.join(REVIEW_TEXTS_DIR, SHOW);
const RESURRECTED = 'wsj--unknown.json';
const BASELINE_PATH = path.resolve(
  path.dirname(REVIEW_TEXTS_DIR), 'audit', 'same-url-duplicate-baseline.json',
);

function sameUrlKey(url) {
  if (!url || typeof url !== 'string') return null;
  return url.toLowerCase().replace(/#.*$/, '').replace(/\/$/, '');
}

test('BRO-3092: the WSJ paywall-boilerplate record stays deleted, one URL one review', (t) => {
  if (!fs.existsSync(SHOW_DIR)) {
    if (process.env.REQUIRE_REVIEW_CORPUS === '1') {
      assert.fail(`${SHOW_DIR} missing but REQUIRE_REVIEW_CORPUS=1 — the corpus must be checked out`);
    }
    t.skip('review-texts corpus not checked out');
    return;
  }

  // 1. The specific junk record must not have come back.
  assert.equal(
    fs.existsSync(path.join(SHOW_DIR, RESURRECTED)), false,
    `${SHOW}/${RESURRECTED} is back — a writer re-created it and `
    + 'validate-added-review-ownership.js did not drop it at push time. '
    + 'Check whether the same-show branch of decideOwnershipDrops still runs, '
    + 'and whether the re-created file now carries a NAMED byline (which that '
    + 'gate deliberately refuses to delete).',
  );

  // 2. The general invariant it violated: within this show, no URL may be held
  //    by more than one review file — asserted at the corpus level so it fails
  //    BEFORE a rebuild promotes it into a red trunk.
  //
  //    Scoped to MIRROR validate-data.js, never to exceed it. That validator
  //    runs over reviews.json, from which isIncludableForRebuild has already
  //    removed flagged records, and it exempts pairs frozen in
  //    same-url-duplicate-baseline.json. A stricter rule here would red the
  //    data-validation job while validate-data.js stayed green — and it would
  //    do so the moment dedupe-same-url-bylines.js applies its own sanctioned
  //    remedy, which stamps duplicateOf on the loser and KEEPS the file with
  //    its url.
  let baseline = new Set();
  try {
    // `pairs` is a flat array of `showId|url` strings — built exactly as
    // validate-data.js builds it (`new Set(... .pairs || [])`), not keyed.
    baseline = new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).pairs || []);
  } catch { /* no baseline file — treat every pair as new, which is stricter only in its absence */ }

  const byUrl = new Map();
  for (const f of fs.readdirSync(SHOW_DIR)) {
    if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(SHOW_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    // Flagged records never reach reviews.json, so they cannot trip the
    // validator and must not trip this test either.
    if (data.duplicateOf || data.wrongShow === true || data.wrongProduction === true) continue;
    const key = sameUrlKey(data && data.url);
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(f);
  }

  const dupes = [...byUrl.entries()]
    .filter(([, files]) => files.length > 1)
    .filter(([url]) => !baseline.has(`${SHOW}|${url}`));
  assert.deepEqual(
    dupes.map(([url, files]) => `${url} -> ${files.join(', ')}`), [],
    `${SHOW} has unflagged, non-baselined review files sharing a URL — `
    + 'one URL at one outlet for one show is one review',
  );
});
