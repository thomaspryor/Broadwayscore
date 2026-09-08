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
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOW = 'the-addams-family-2010';
const SHOW_DIR = path.join(REPO, 'data', 'review-texts', SHOW);
const RESURRECTED = 'wsj--unknown.json';

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
  //    by more than one review file. This is the exact rule validate-data.js
  //    errors on, asserted at the corpus level so it fails BEFORE a rebuild
  //    promotes it into a red trunk.
  const byUrl = new Map();
  for (const f of fs.readdirSync(SHOW_DIR)) {
    if (!f.endsWith('.json') || f === 'failed-fetches.json') continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(SHOW_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    const key = sameUrlKey(data && data.url);
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(f);
  }

  const dupes = [...byUrl.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(
    dupes.map(([url, files]) => `${url} -> ${files.join(', ')}`), [],
    `${SHOW} has review files sharing a URL — one URL at one outlet for one show is one review`,
  );
});
