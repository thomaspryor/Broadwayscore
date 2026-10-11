/**
 * verify-image.test.mjs (BRO-5022)
 *
 * The Google Images tier for closed shows took same-title non-theatre art and
 * other companies' posters: endgame-west-end-2020 (Beckett, Old Vic) got the
 * Avengers: Endgame film poster; noises-off-west-end-2019 a university
 * staging's poster; the-greatest-play-...-west-end-2019 a Philadelphia
 * company's art. The prompt had no non-theatre rule, no authors and gave
 * benefit of the doubt on production. These tests require the REAL prompt
 * builders and verdict function.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildVerificationPrompt, buildUserPrompt, applyStrictVerdict, creativesForVerify, formatCreatives, parseResponse,
} = require('./verify-image.js');

const BECKETT = [{ name: 'Samuel Beckett', role: 'Playwright' }];

test('prompt rejects same-title film/TV/book/game art (non_theatre_work)', () => {
  const p = buildVerificationPrompt({ market: 'west-end', venue: 'Old Vic' });
  assert.match(p, /FILM, TV series, book cover, video game, album/);
  assert.match(p, /Avengers: Endgame/);
  assert.match(p, /non_theatre_work/);
});

test('prompt rejects school and university productions', () => {
  const p = buildVerificationPrompt({ market: 'west-end' });
  assert.match(p, /school, college or university production/i);
});

test('prompt carries the creatives line and the different-author rule', () => {
  const p = buildVerificationPrompt({ market: 'west-end', venue: 'Old Vic', creatives: BECKETT });
  assert.match(p, /THE WORK: the stage work by Samuel Beckett \(playwright\)/);
  assert.match(p, /credits a DIFFERENT playwright, author or composer/);
  assert.match(p, /Our list is incomplete/);
  // A director alone is no author, so nothing to conflict with: the AMAZE
  // poster says "Jamie Allan's AMAZE" while the row lists only its director.
  const GOODWIN = [{ name: 'Jonathan Goodwin', role: 'Director' }];
  assert.doesNotMatch(buildVerificationPrompt({ market: 'off-broadway', creatives: GOODWIN }), /THE WORK:/);
  assert.doesNotMatch(buildUserPrompt('AMAZE Magic', { market: 'off-broadway', creatives: GOODWIN }), /Creative team/);
  // Strict mode keeps the director as production evidence, still with no author rule.
  const dirStrict = buildVerificationPrompt({ market: 'west-end', creatives: GOODWIN, strict: true });
  assert.match(dirStrict, /THE WORK: the stage work by Jonathan Goodwin \(director\)/);
  assert.doesNotMatch(dirStrict, /credits a DIFFERENT playwright/);
  assert.match(buildUserPrompt('AMAZE Magic', { market: 'west-end', creatives: GOODWIN, strict: true }), /Creative team: Jonathan Goodwin/);
  // No creatives -> no empty line.
  assert.doesNotMatch(buildVerificationPrompt({ market: 'west-end' }), /THE WORK:/);
});

test('strict mode drops benefit of the doubt and asks for evidence fields; default does not', () => {
  const strict = buildVerificationPrompt({ market: 'west-end', strict: true });
  assert.match(strict, /STRICT MODE/);
  assert.match(strict, /"workConfirmed"/);
  assert.match(strict, /"productionMatch"/);
  assert.match(strict, /A title alone is NOT confirmation/);
  assert.doesNotMatch(buildVerificationPrompt({ market: 'west-end' }), /STRICT MODE/);
});

test('user prompt names creatives, run and the source page', () => {
  const u = buildUserPrompt('Endgame', {
    openingDate: '2020-02-05', closingDate: '2020-03-14', market: 'west-end', venue: 'Old Vic',
    creatives: BECKETT, pageDomain: 'ladygeeksmedia.com', pageTitle: 'Avengers: Endgame encore',
  });
  assert.match(u, /"Endgame" \(2020\) at Old Vic/);
  assert.match(u, /Creative team: Samuel Beckett \(playwright\)\./);
  assert.match(u, /ran from 2020-02-05 to 2020-03-14/);
  assert.match(u, /found on: ladygeeksmedia\.com — "Avengers: Endgame encore"/);
  assert.match(u, /specific 2020 West End production\?$/);
  // The page path names whose page it is; the query string is dropped.
  const fb = buildUserPrompt('Bagdad Cafe', {
    openingDate: '2021-07-19', market: 'west-end', pageDomain: 'm.facebook.com',
    pageUrl: 'https://m.facebook.com/OldVicTheatre/videos/studio-audience-for-bagdad-cafe/4152114311539640/?locale=en_GB',
  });
  assert.match(fb, /found on: m\.facebook\.com\/OldVicTheatre\/videos\/studio-audience-for-bagdad-cafe\/4152114311539640\/\. /);
});

test('user prompt without extras keeps the legacy shape', () => {
  const u = buildUserPrompt('Hamlet', { year: '2009', market: 'broadway' });
  assert.doesNotMatch(u, /Creative team|found on|ran from/);
  assert.match(u, /Is this image correct promotional art for this specific 2009 Broadway production\?$/);
});

test('creativesForVerify keeps authors and director, drops cast/designers', () => {
  const out = creativesForVerify({ creativeTeam: [
    { name: 'Michael Frayn', role: 'Playwright' },
    { name: 'Jeremy Herrin', role: 'Director' },
    { name: 'Max Jones', role: 'Set Designer' },
    { name: 'Felicity Kendal', role: 'Cast' },
    { name: 'Stephen Sondheim', role: 'Music & Lyrics' },
  ] });
  assert.deepEqual(out.map(c => c.name), ['Michael Frayn', 'Jeremy Herrin', 'Stephen Sondheim']);
  assert.equal(creativesForVerify({}).length, 0);
  assert.equal(formatCreatives(['A', 'A', null, { role: 'x' }]), 'the stage work by A');
});

test('strict verdict: accepts only confirmed work with no other-production evidence', () => {
  const ok = { match: true, confidence: 'high', issues: [], workConfirmed: true, productionMatch: 'this' };
  assert.equal(applyStrictVerdict(ok, { strict: true }).accept, true);
  assert.equal(applyStrictVerdict({ ...ok, productionMatch: 'unknown' }, { strict: true }).accept, true);
  // The Endgame film poster: title matches, work not confirmed.
  assert.deepEqual(applyStrictVerdict({ ...ok, workConfirmed: false, productionMatch: 'unknown' }, { strict: true }),
    { accept: false, errored: false, reason: 'work-not-confirmed' });
  // The 2023 Garrick art on the 2019 row.
  assert.equal(applyStrictVerdict({ ...ok, productionMatch: 'other' }, { strict: true }).reason, 'other-production');
  assert.equal(applyStrictVerdict({ ...ok, confidence: 'low' }, { strict: true }).accept, false);
  // Low-confidence rejections no longer fail open.
  assert.equal(applyStrictVerdict({ match: false, confidence: 'low', issues: [] }, { strict: true }).accept, false);
});

test('strict verdict: verifier errors are errors, not rejections (never mark no-art on an outage)', () => {
  for (const r of [
    { match: true, confidence: 'low', issues: ['api_error'] },
    { match: true, confidence: 'low', issues: ['download_error'] },
    { match: null, confidence: 'error', issues: ['parse_error'] },
    { match: true, confidence: 'low', issues: [], skipped: true },
  ]) {
    const v = applyStrictVerdict(r, { strict: true });
    assert.equal(v.accept, false);
    assert.equal(v.errored, true, JSON.stringify(r));
  }
});

test('strict verdict: a match without the strict fields is an error, not a rejection', () => {
  // A truncated or schema-drifted reply must never mark a row noReliableArt.
  const noFields = parseResponse('{"match": true, "confidence": "high", "issues": []}');
  assert.deepEqual(applyStrictVerdict(noFields, { strict: true }), { accept: false, errored: true, reason: 'strict-fields-missing' });
  const truncated = parseResponse('{"match": true, "confidence": "high", "description": "poster"');
  assert.equal(applyStrictVerdict(truncated, { strict: true }).errored, true);
  const full = parseResponse('{"match": true, "confidence": "high", "issues": [], "workConfirmed": true, "productionMatch": "this"}');
  assert.equal(applyStrictVerdict(full, { strict: true }).accept, true);
  // A plain rejection stays a rejection even without the fields.
  const no = parseResponse('{"match": false, "confidence": "high", "issues": ["non_theatre_work"]}');
  assert.deepEqual(applyStrictVerdict(no, { strict: true }), { accept: false, errored: false, reason: 'rejected' });
  // Non-strict callers are unaffected.
  assert.equal(applyStrictVerdict(noFields).accept, true);
});

test('non-strict verdict keeps legacy fail-open behaviour', () => {
  assert.equal(applyStrictVerdict({ match: true, confidence: 'high', issues: [] }).accept, true);
  assert.equal(applyStrictVerdict({ match: false, confidence: 'high', issues: [] }).accept, false);
  assert.equal(applyStrictVerdict({ match: false, confidence: 'medium', issues: [] }).accept, false);
  assert.equal(applyStrictVerdict({ match: false, confidence: 'low', issues: [] }).accept, true);
  assert.equal(applyStrictVerdict({ match: true, confidence: 'low', issues: ['api_error'] }).accept, true);
});
