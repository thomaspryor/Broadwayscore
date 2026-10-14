/**
 * BRO-5254: a forced refetch that returns shorter (correct) text was put back
 * to the old longer copy by the push restore, because nothing on the record
 * said the shrink was deliberate. All 10 Variety refetches were lost this way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { forcedRefetchTrim } = require('../../scripts/lib/review-filter.js');
const { reconcileProtectedFields } = require('../../scripts/lib/restore-protected-fields.js');
const { isIntentionalClear } = require('../../scripts/lib/review-write-guard.js');

const OLD = 'Old body with Related Stories chrome and another headline. '.repeat(20);
const NEW = 'The real review, fetched again from the right page. '.repeat(15);

test('breadcrumb only when the refetch shrank the text', () => {
  const t = forcedRefetchTrim(OLD, NEW, '2026-10-14T00:00:00Z');
  assert.deepEqual([t.fromLength, t.toLength], [OLD.length, NEW.length]);
  assert.equal(forcedRefetchTrim(NEW, OLD), null);
  assert.equal(forcedRefetchTrim(OLD, ''), null);
  assert.equal(forcedRefetchTrim(OLD, null), null);
});

test('stale-checkout restore keeps the refetched text when the breadcrumb is set', () => {
  const remote = { fullText: OLD, textWordCount: 200, contentTier: 'complete' };
  const local = { fullText: NEW, textWordCount: 150, contentTier: 'complete', fullTextTrimmed: forcedRefetchTrim(OLD, NEW) };
  reconcileProtectedFields(local, remote, { ...remote }, { staleCheckoutGuard: true });
  assert.equal(local.fullText, NEW);
  assert.equal(isIntentionalClear('fullText', local, remote), true);
});

test('without the breadcrumb the old text comes back (the bug)', () => {
  const remote = { fullText: OLD, textWordCount: 200, contentTier: 'complete' };
  const local = { fullText: NEW, textWordCount: 150, contentTier: 'complete' };
  reconcileProtectedFields(local, remote, { ...remote }, { staleCheckoutGuard: true });
  assert.equal(local.fullText, OLD);
});

test('a later fetch that changes the text again is not covered by the old breadcrumb', () => {
  const local = { fullText: NEW + ' more', fullTextTrimmed: forcedRefetchTrim(OLD, NEW) };
  assert.equal(isIntentionalClear('fullText', local, { fullText: OLD }), false);
});

test('a page-bleed trim records the cut too, so the push restore keeps it', () => {
  const { applyBleedTrim } = require('../../scripts/lib/page-bleed-repair.js');
  const committed = { fullText: OLD, textWordCount: 200 };
  const local = applyBleedTrim(committed, NEW, { at: '2026-10-14T00:00:00Z' });
  reconcileProtectedFields(local, committed, { ...committed }, { staleCheckoutGuard: true });
  assert.equal(local.fullText, NEW);
});

// BRO-5254: a forced refetch from the file's own outlet domain does not mark
// itself duplicateTextOf a different outlet's file with the same text.
test('skipCrossOutletSelfDemote: only a forced, own-domain, cross-outlet match is skipped', () => {
  const { skipCrossOutletSelfDemote } = require('../../scripts/lib/review-filter.js');
  const base = { forcedReplacement: true, outletId: 'variety', siblingOutletId: 'vulture', hostMatches: true };
  assert.equal(skipCrossOutletSelfDemote(base), true);
  assert.equal(skipCrossOutletSelfDemote({ ...base, forcedReplacement: false }), false, 'routine fetch keeps the old dedupe');
  assert.equal(skipCrossOutletSelfDemote({ ...base, siblingOutletId: 'variety' }), false, 'same-outlet copies still dedupe');
  assert.equal(skipCrossOutletSelfDemote({ ...base, hostMatches: false }), false, 'off-domain url proves nothing');
  assert.equal(skipCrossOutletSelfDemote({ ...base, hostMatches: null }), false, 'unknown domain keeps the old dedupe');
});

test('skipCrossOutletSelfDemote: real registry says variety.com is Variety', () => {
  const { hostMatchesOutletDomain } = require('../../scripts/lib/outlet-domain-validation.js');
  const reg = JSON.parse(readFileSync(new URL('../../data/outlet-registry.json', import.meta.url), 'utf8'));
  assert.equal(hostMatchesOutletDomain('https://variety.com/1997/legit/reviews/the-lion-king-new-amsterdam-theater-1117339958/', 'variety', reg), true);
});
