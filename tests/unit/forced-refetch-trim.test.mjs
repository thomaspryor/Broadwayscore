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
  const base = { forcedRefetch: true, outletId: 'variety', siblingOutletId: 'vulture', hostMatches: true };
  assert.equal(skipCrossOutletSelfDemote(base), true);
  assert.equal(skipCrossOutletSelfDemote({ ...base, forcedRefetch: false }), false, 'routine fetch keeps the old dedupe');
  assert.equal(skipCrossOutletSelfDemote({ ...base, siblingOutletId: 'variety' }), false, 'same-outlet copies still dedupe');
  assert.equal(skipCrossOutletSelfDemote({ ...base, hostMatches: false }), false, 'off-domain url proves nothing');
  assert.equal(skipCrossOutletSelfDemote({ ...base, hostMatches: null }), false, 'unknown domain keeps the old dedupe');
});

test('skipCrossOutletSelfDemote: real registry says variety.com is Variety', () => {
  const { hostMatchesOutletDomain } = require('../../scripts/lib/outlet-domain-validation.js');
  const reg = JSON.parse(readFileSync(new URL('../../data/outlet-registry.json', import.meta.url), 'utf8'));
  assert.equal(hostMatchesOutletDomain('https://variety.com/1997/legit/reviews/the-lion-king-new-amsterdam-theater-1117339958/', 'variety', reg), true);
});

// BRO-5348: a forced refetch that restored the row's own text clears a
// crossOutletDuplicate flag set while it held another outlet's text.
test('staleCrossOutletFlagAfterRefetch: cleared only when the refetched text no longer matches the primary', () => {
  const { staleCrossOutletFlagAfterRefetch } = require('../../scripts/lib/review-filter.js');
  const base = { forcedReplacement: true, crossOutletDuplicate: true, crossOutletMethod: 'fingerprint', newFingerprint: 'aaa', primaryFingerprint: 'bbb' };
  assert.equal(staleCrossOutletFlagAfterRefetch(base), true);
  assert.equal(staleCrossOutletFlagAfterRefetch({ ...base, primaryFingerprint: 'aaa' }), false, 'still the same text');
  assert.equal(staleCrossOutletFlagAfterRefetch({ ...base, forcedReplacement: false }), false, 'routine fetch leaves the flag');
  assert.equal(staleCrossOutletFlagAfterRefetch({ ...base, primaryFingerprint: null }), false, 'unreadable primary keeps the flag');
  assert.equal(staleCrossOutletFlagAfterRefetch({ ...base, crossOutletDuplicate: false }), false);
  assert.equal(staleCrossOutletFlagAfterRefetch({ ...base, crossOutletMethod: 'similarity' }), false, 'a similarity flag differs by fingerprint already');
});

// 1C loop wiring (BRO-5254 review): the helpers in the order the loop calls them.
test('cross-outlet skip then a same-outlet match: pointer set, clear note dropped', () => {
  const { applyCrossOutletSkip, setDuplicateTextOf } = require('../../scripts/lib/review-filter.js');
  const opts = { forcedRefetch: true, hostMatches: true };
  const data = { outletId: 'variety', duplicateTextOf: 'vulture--john-simon.json' };
  assert.equal(applyCrossOutletSkip(data, 'vulture--john-simon.json', { outletId: 'vulture' }, opts), true);
  assert.equal(data.duplicateTextOf, undefined);
  assert.match(data.duplicateClearReason, /^forced refetch from own domain;/);
  assert.equal(applyCrossOutletSkip(data, 'variety--other.json', { outletId: 'variety' }, opts), false, 'same outlet is not skipped');
  setDuplicateTextOf(data, 'variety--other.json');
  assert.equal(data.duplicateTextOf, 'variety--other.json');
  assert.equal(data.duplicateClearReason, null, 'a stale clear note must not sit beside a live pointer');
});

test('alias outlet ids count as one outlet; a duplicateOf file gets no clear note', () => {
  const { applyCrossOutletSkip, setDuplicateTextOf } = require('../../scripts/lib/review-filter.js');
  const opts = { forcedRefetch: true, hostMatches: true };
  assert.equal(applyCrossOutletSkip({ outletId: 'vulture' }, 'nymag--x.json', { outletId: 'nymag' }, opts), false);
  const d = { outletId: 'variety', duplicateOf: 'variety--a.json', duplicateTextOf: 'vulture--b.json' };
  assert.equal(applyCrossOutletSkip(d, 'vulture--b.json', { outletId: 'vulture' }, opts), true);
  assert.equal(d.duplicateClearReason, undefined, 'the note would also license dropping duplicateOf');
  const keep = { duplicateClearReason: 'manual: owner cleared (BRO-1)' };
  setDuplicateTextOf(keep, 'x.json');
  assert.equal(keep.duplicateClearReason, 'manual: owner cleared (BRO-1)', 'only this guard\'s own note is dropped');
});

// BRO-5348: overrides read from text a forced refetch replaced.
test('staleScoreOverridesAfterRefetch: a locked pin turns provisional, an unverified rating is set aside', () => {
  const { staleScoreOverridesAfterRefetch } = require('../../scripts/lib/review-filter.js');
  // days-of-wine-and-roses-2024 amNY: pin 78 set against Vulture's text.
  assert.deepEqual(staleScoreOverridesAfterRefetch({ forcedReplacement: true, humanReviewScore: 78 }), { humanPin: true, originalScore: false });
  // mother-play-2024 Queerty: "D" read from Theater Pizzazz's text.
  assert.deepEqual(staleScoreOverridesAfterRefetch({ forcedReplacement: true, originalScore: 'D' }), { humanPin: false, originalScore: true });
  assert.equal(staleScoreOverridesAfterRefetch({ forcedReplacement: true, originalScore: '4/5', humanVerifiedRating: true }).originalScore, false, 'a human-verified rating is never touched');
  assert.equal(staleScoreOverridesAfterRefetch({ forcedReplacement: true, humanReviewScore: 78, humanReviewScoreProvisional: true }).humanPin, false, 'already provisional');
  assert.deepEqual(staleScoreOverridesAfterRefetch({ forcedReplacement: false, humanReviewScore: 78, originalScore: 'D' }), { humanPin: false, originalScore: false }, 'routine fetch changes nothing');
});
