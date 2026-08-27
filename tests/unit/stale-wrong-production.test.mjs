/**
 * BRO-53 — Tier 2 stale wrongProduction recovery.
 *
 * getWrongProductionReasonFromUrl correctly excludes review files whose
 * stored URL is from an old archive (SERP matched a prior production /
 * tour leg / pre-transfer run against the current show). This tier picks up
 * where that guard leaves off: for a file flagged that way, with a named
 * critic + outlet, find the CURRENT review by the same critic+outlet and
 * relink to it — instead of leaving the show permanently missing that
 * outlet's coverage.
 *
 * Run: node --test tests/unit/stale-wrong-production.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isEligibleForStaleWrongProductionRecovery,
  resolveStaleWrongProductionRecovery,
  shouldRetryUrlDiscovery,
  recordSerpAttempt,
} = require('../../scripts/lib/review-guards.js');

// Mirrors the BRO-53 problem statement: USA Today reviewed an earlier
// (2014) revival of a show that reopened in 2026. SERP matched that old
// archive URL; getWrongProductionReasonFromUrl correctly flagged it.
const show2026 = {
  id: 'chicago-2026',
  title: 'Chicago',
  category: 'broadway',
  previewsStartDate: '2026-01-10',
  openingDate: '2026-02-01',
};

const staleFile = () => ({
  showId: 'chicago-2026',
  outletId: 'usatoday',
  outlet: 'USA Today',
  criticName: 'Elysa Gardner',
  url: 'https://www.usatoday.com/story/life/theater/2014/03/12/chicago-review/6297123/',
  wrongProduction: true,
  wrongProductionReason: 'Auto-flagged: URL date 2014-03-12 is 4345 days before show earliest date 2026-01-10. Likely prior/different production.',
  fullText: 'A 2014 review of a prior Chicago revival at the Ambassador Theatre...',
});

describe('isEligibleForStaleWrongProductionRecovery', () => {
  it('is eligible: named critic, outlet, and the stored URL still fails the date guard', () => {
    assert.equal(isEligibleForStaleWrongProductionRecovery(staleFile(), show2026), true);
  });

  it('is eligible regardless of which field/text carries the reason — re-derives from the URL, not the reason string', () => {
    // Simulates the field-duality across the ~15 producer scripts: some
    // write wrongProductionNote, some wrongProductionReason, with different
    // wording each time. Eligibility must not depend on parsing any of them.
    const f = staleFile();
    delete f.wrongProductionReason;
    f.wrongProductionNote = 'Some other producer script wrote a completely different sentence here';
    assert.equal(isEligibleForStaleWrongProductionRecovery(f, show2026), true);
  });

  it('is eligible even with no reason text captured at all', () => {
    const f = staleFile();
    delete f.wrongProductionReason;
    assert.equal(isEligibleForStaleWrongProductionRecovery(f, show2026), true);
  });

  it('rejects when wrongProduction is not set', () => {
    assert.equal(isEligibleForStaleWrongProductionRecovery({ ...staleFile(), wrongProduction: false }, show2026), false);
  });

  it('rejects when the stored URL is actually IN the show window (not a date-guard case)', () => {
    // wrongProduction true for some OTHER reason (venue mismatch, ensemble
    // rejection) — the URL itself is not from the wrong calendar window, so
    // this isn't a Tier 2 "find the current review" case.
    const f = { ...staleFile(), url: 'https://www.usatoday.com/story/life/theater/2026/02/02/chicago-review/1/', wrongProductionReason: 'Ensemble rejected: wrong_production' };
    assert.equal(isEligibleForStaleWrongProductionRecovery(f, show2026), false);
  });

  it('rejects Unknown byline — no "same critic" search target', () => {
    assert.equal(isEligibleForStaleWrongProductionRecovery({ ...staleFile(), criticName: 'Unknown' }, show2026), false);
    assert.equal(isEligibleForStaleWrongProductionRecovery({ ...staleFile(), criticName: 'Staff' }, show2026), false);
    assert.equal(isEligibleForStaleWrongProductionRecovery({ ...staleFile(), criticName: '' }, show2026), false);
  });

  it('rejects when a human already adjudicated the file', () => {
    assert.equal(isEligibleForStaleWrongProductionRecovery({ ...staleFile(), wrongProductionManualClear: true }, show2026), false);
    assert.equal(isEligibleForStaleWrongProductionRecovery({ ...staleFile(), wrongProductionOverride: true }, show2026), false);
    assert.equal(isEligibleForStaleWrongProductionRecovery({ ...staleFile(), humanReviewedWrongProduction: false }, show2026), false);
  });

  it('rejects when recovery already ran (found or abandoned) — no infinite loop', () => {
    assert.equal(isEligibleForStaleWrongProductionRecovery({ ...staleFile(), staleWrongProductionRecovered: true }, show2026), false);
    assert.equal(isEligibleForStaleWrongProductionRecovery({ ...staleFile(), staleWrongProductionRecoveryAbandoned: true }, show2026), false);
  });

  it('rejects with no outlet info at all', () => {
    const f = staleFile();
    delete f.outletId;
    delete f.outlet;
    assert.equal(isEligibleForStaleWrongProductionRecovery(f, show2026), false);
  });

  it('rejects with no show', () => {
    assert.equal(isEligibleForStaleWrongProductionRecovery(staleFile(), null), false);
  });

  it('rejects null data', () => {
    assert.equal(isEligibleForStaleWrongProductionRecovery(null, show2026), false);
  });
});

describe('resolveStaleWrongProductionRecovery — identifies the current review to link (validation only, no write patch)', () => {
  it('accepts a newly-discovered URL that lands inside the show window (the core BRO-53 case)', () => {
    const currentUrl = 'https://www.usatoday.com/story/life/theater/2026/02/03/chicago-review/999/';
    const decision = resolveStaleWrongProductionRecovery(staleFile(), currentUrl, show2026);
    assert.ok(decision, 'should return a recovery decision');
    assert.equal(decision.url, currentUrl);
    assert.equal(decision.oldUrl, staleFile().url);
  });

  it('rejects a re-discovery of the SAME stale URL', () => {
    const decision = resolveStaleWrongProductionRecovery(staleFile(), staleFile().url, show2026);
    assert.equal(decision, null);
  });

  it('rejects a second out-of-window URL (a different prior production, not the current one)', () => {
    const anotherStaleUrl = 'https://www.usatoday.com/story/life/theater/2018/05/20/chicago-review/2/';
    const decision = resolveStaleWrongProductionRecovery(staleFile(), anotherStaleUrl, show2026);
    assert.equal(decision, null);
  });

  it('rejects a candidate URL on a different domain than the outlet (defense in depth)', () => {
    // Same date-window pass, but the host doesn't belong to usa-today's
    // registered domain — a mismatched candidate must not be trusted even if
    // discoverCorrectUrl's own host-check somehow let it through.
    const wrongHostUrl = 'https://www.nytimes.com/2026/02/03/theater/chicago-review.html';
    const decision = resolveStaleWrongProductionRecovery(staleFile(), wrongHostUrl, show2026);
    assert.equal(decision, null);
  });

  it('rejects null/empty discovered URL', () => {
    assert.equal(resolveStaleWrongProductionRecovery(staleFile(), null, show2026), null);
    assert.equal(resolveStaleWrongProductionRecovery(staleFile(), '', show2026), null);
  });

  it('rejects when the file was not eligible in the first place', () => {
    const ineligible = { ...staleFile(), criticName: 'Unknown' };
    const currentUrl = 'https://www.usatoday.com/story/life/theater/2026/02/03/chicago-review/999/';
    assert.equal(resolveStaleWrongProductionRecovery(ineligible, currentUrl, show2026), null);
  });
});

describe('recordSerpAttempt/resolveStaleWrongProductionRecovery ordering — a hit on the LAST retry must not be discarded', () => {
  // scripts/retry-stale-wrong-production.js's own regression: recordSerpAttempt
  // sets staleWrongProductionRecoveryAbandoned:true on the attempt that hits
  // MAX_RETRIES_WRONG_CONTENT. If the caller applies+writes that update to
  // `data` BEFORE calling resolveStaleWrongProductionRecovery, the very next
  // eligibility check rejects the file (data.staleWrongProductionRecoveryAbandoned
  // === true) even though `result` is a perfectly valid, in-window URL — the
  // successful hit on the exhausting attempt is silently thrown away and the
  // file becomes permanently ineligible (Codex adversarial review, round 2).
  const openWindowShow = { id: 'chicago-2026', title: 'Chicago', category: 'broadway', status: 'open', previewsStartDate: '2026-01-10', openingDate: '2026-02-01' };
  const currentUrl = 'https://www.usatoday.com/story/life/theater/2026/02/03/chicago-review/999/';

  it('resolve-THEN-record (correct order): a hit on the exhausting attempt is still accepted', () => {
    const data = { ...staleFile(), staleWpRetryCount: 2 }; // next attempt hits openWindow's max of 3
    const recovery = resolveStaleWrongProductionRecovery(data, currentUrl, openWindowShow);
    assert.ok(recovery, 'resolve must succeed BEFORE the abandoned flag is applied');
    assert.equal(recovery.url, currentUrl);
    // Only now would the caller record the attempt — but it shouldn't, since recovery succeeded.
  });

  it('record-THEN-resolve (the bug): the same hit is silently discarded and the file locks out forever', () => {
    const data = { ...staleFile(), staleWpRetryCount: 2 };
    const attemptUpdates = recordSerpAttempt(openWindowShow, { ...data, incompleteReason: 'stale_wrong_production' });
    assert.equal(attemptUpdates.staleWrongProductionRecoveryAbandoned, true, 'sanity: this IS the exhausting attempt');
    Object.assign(data, attemptUpdates); // the bug: applying abandonment before resolving
    const recovery = resolveStaleWrongProductionRecovery(data, currentUrl, openWindowShow);
    assert.equal(recovery, null, 'demonstrates the bug: a valid hit is rejected once abandoned is set first');
    // And the file is now permanently ineligible regardless of any future URL:
    assert.equal(isEligibleForStaleWrongProductionRecovery(data, openWindowShow), false);
  });
});

describe('shouldRetryUrlDiscovery / recordSerpAttempt — stale_wrong_production reuses the retry/cooldown SHAPE under its OWN namespaced fields', () => {
  const openWindowShow = { id: 'x', category: 'broadway', status: 'open', openingDate: new Date().toISOString().slice(0, 10) };

  it('allows the first attempt', () => {
    const gate = shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'stale_wrong_production' });
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'stale_wrong_production_retry');
  });

  it('advances staleWpRetryCount on attempt — NOT the shared serpRetryCount', () => {
    const updates = recordSerpAttempt(openWindowShow, { incompleteReason: 'stale_wrong_production' });
    assert.equal(updates.staleWpRetryCount, 1);
    assert.ok(updates.staleWpRetryAfter);
    assert.equal(updates.serpRetryCount, undefined);
    assert.equal(updates.serpRetryAfter, undefined);
  });

  it('enforces the cooldown between attempts via staleWpRetryAfter', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const gate = shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'stale_wrong_production', staleWpRetryCount: 1, staleWpRetryAfter: future });
    assert.equal(gate.shouldRetry, false);
    assert.equal(gate.reason, 'cooldown');
  });

  it('abandons after max retries for the lifecycle (openWindow = 3), writing staleWrongProductionRecoveryAbandoned', () => {
    const gate = shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'stale_wrong_production', staleWpRetryCount: 3 });
    assert.equal(gate.shouldRetry, false);
    assert.equal(gate.reason, 'max_retries_reached');
    assert.equal(gate.updates.staleWrongProductionRecoveryAbandoned, true);
    assert.equal(gate.updates.serpDiscoveryAbandoned, undefined);
  });

  it('the written staleWrongProductionRecoveryAbandoned flag is exactly what isEligibleForStaleWrongProductionRecovery reads — not dead state', () => {
    const recordUpdates = recordSerpAttempt(openWindowShow, { incompleteReason: 'stale_wrong_production', staleWpRetryCount: 2 });
    assert.equal(recordUpdates.staleWrongProductionRecoveryAbandoned, true);
    const f = { ...staleFile(), ...recordUpdates };
    assert.equal(isEligibleForStaleWrongProductionRecovery(f, show2026), false);
  });

  it('honors the permanent abandoned gate', () => {
    const gate = shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'stale_wrong_production', staleWrongProductionRecoveryAbandoned: true });
    assert.equal(gate.shouldRetry, false);
    assert.equal(gate.reason, 'abandoned');
  });

  it('does not cross-contaminate with unrelated no_url/wrong_content exhaustion on the same file', () => {
    // A file that previously exhausted no_url/wrong_content retries (serpDiscoveryAbandoned)
    // must still be able to attempt Tier 2 recovery — different failure class, different state.
    const gate = shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'stale_wrong_production', serpDiscoveryAbandoned: true });
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'stale_wrong_production_retry');
  });

  it('a Tier 2 abandonment does not block a later no_url/wrong_content retry on the same file', () => {
    const gate = shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'wrong_content', staleWrongProductionRecoveryAbandoned: true });
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'wrong_content_retry');
  });

  it('does not affect existing no_url/wrong_content behavior (purely additive)', () => {
    const gate = shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'wrong_content' });
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'wrong_content_retry');
    const updates = recordSerpAttempt(openWindowShow, { incompleteReason: 'wrong_content' });
    assert.equal(updates.serpRetryCount, 1);
    assert.equal(updates.staleWpRetryCount, undefined);
  });

  it('leaves unrelated files ungated', () => {
    const gate = shouldRetryUrlDiscovery(openWindowShow, { incompleteReason: 'complete' });
    assert.equal(gate.shouldRetry, true);
    assert.equal(gate.reason, 'not_gated');
  });
});
