/**
 * Domain filters — NYTG unblock regression test.
 *
 * Bucket A (discovery misses): NYTG (newyorktheatreguide.com) was in
 * AGGREGATOR_DOMAINS and silently blocked by isBlockedReviewUrl at
 * rebuild-all-reviews.js:1868, dropping every NYTG original review despite
 * passing all other guards. Becky Shaw opening night 2026-04-07 took 7 hours
 * of debugging to find.
 *
 * Both the UK spelling (theatre) and the US spelling (theater) must stay
 * unblocked — the US spelling was briefly kept blocked on the theory that
 * it redirects to UK, but isBlockedReviewUrl operates on the literal URL
 * before any redirect is followed. See memory/feedback_blocked_url_silent_exclusion.md.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = join(import.meta.dirname, '..', '..');
const { isBlockedReviewUrl } = require(join(ROOT, 'scripts/lib/domain-filters.js'));
const { resolveOutletFromUrl } = require(join(ROOT, 'scripts/lib/review-normalization.js'));

const NYTG_URLS = [
  'https://www.newyorktheatreguide.com/reviews/becky-shaw-broadway-review',
  'https://newyorktheatreguide.com/reviews/becky-shaw-broadway-review',
  'https://www.newyorktheaterguide.com/reviews/some-review',
  'https://newyorktheaterguide.com/reviews/some-review',
];

for (const url of NYTG_URLS) {
  test(`NYTG review URL must not be blocked: ${url}`, () => {
    assert.strictEqual(
      isBlockedReviewUrl(url),
      false,
      `NYTG URL got blocked — Bucket A regression. If you re-added NYTG to ` +
        `AGGREGATOR_DOMAINS, revert: NYTG publishes original reviews (Kyle Turner, ` +
        `Allison Considine, etc.) and blocking it silently drops them from rebuild.`
    );
  });
}

// End-to-end completeness: domain-filter unblock alone is insufficient if
// resolveOutletFromUrl can't map the URL to an outletId. The initial Fix 9
// shipped with the domain unblocked but no US-spelling domain alias on nytg,
// so every US-spelling URL past the filter resolved to null downstream and
// lost its outlet attribution. Assert both spellings resolve to nytg.
for (const url of NYTG_URLS) {
  test(`NYTG review URL must resolve to outletId=nytg: ${url}`, () => {
    const resolved = resolveOutletFromUrl(url);
    assert.ok(
      resolved,
      `resolveOutletFromUrl returned null for NYTG URL. The domain alias is ` +
        `missing from outlet-registry.json. Add the hostname to nytg.domainAliases.`
    );
    assert.strictEqual(
      resolved.outletId,
      'nytg',
      `Expected outletId=nytg, got ${resolved.outletId}. NYTG domain alias is wrong.`
    );
  });
}

test('Domain filter still blocks a known aggregator (control)', () => {
  // Sanity: we didn't accidentally disable the whole filter.
  assert.strictEqual(
    isBlockedReviewUrl('https://www.show-score.com/show/some-show'),
    true,
    'show-score.com should still be blocked — the filter itself must work.'
  );
});

test('listing/press hosts that recur through submit-review-form stay blocked', () => {
  // These three reddened audit-outlet-registry.js --strict on 2026-09-02, all
  // via source:'submit-review-form' with criticName 'Unknown' and no score.
  // Blocked at the domain rather than baselined per outletId: a baseline
  // silences one id, while the next listing page from the same host (or the
  // next university announcing an alum's show) simply arrives under a new one.
  // A previous cycle baselined `nyu` and wrote "do NOT register these if they
  // recur" — it recurred, which is what made the domain the right level.
  //
  // thelondoner.com is the one that mattered most: its page was ingested at
  // contentTier:'complete' with 3790 chars of well-formed prose, so it was a
  // live scoring candidate held back only by not having been scored yet. Same
  // shape as the BRO-2712 southbankcentre finding.
  for (const url of [
    'https://www.thelondoner.com/exclusive-offers/a-month-in-the-country',
    'https://vocaleyes.co.uk/events/electra-persona-2/',
    'https://tisch.nyu.edu/performance-studies/news/lukas-t--woodyard',
    'https://nyu.edu/anything', // whole domain, not just the tisch subdomain
  ]) {
    assert.strictEqual(isBlockedReviewUrl(url), true, `${url} must be blocked`);
  }
});

test('the new blocks do not catch real review outlets', () => {
  // The parity run behind this: 37,076 review URLs in the corpus, exactly 3
  // verdicts changed (the three files above), 0 of them scored. These four are
  // the regression guard for that result.
  for (const url of [
    'https://www.thestage.co.uk/reviews/some-show',
    'https://www.nytimes.com/2026/01/01/theater/review-some-show.html',
    'https://www.londontheatre.co.uk/reviews/some-show',
    'https://www.theguardian.com/stage/2026/jan/01/some-show',
  ]) {
    assert.strictEqual(isBlockedReviewUrl(url), false, `${url} must NOT be blocked`);
  }
});
