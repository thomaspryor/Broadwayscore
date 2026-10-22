/**
 * BRO-5906: booking/deal marketing copy stored as a review.
 *
 * jeeves-takes-charge-west-end-2026/staybook--staybook.json was a staybook.in
 * activity-booking page ("Get your booking confirmed instantly", "Grab great
 * deals before they are gone") ingested via submit-review-form and LLM-scored
 * 78. Two layers now cover it: staybook.in is a blocked ticket domain (refused
 * before fetch, dropped at rebuild), and detectPromoBookingCopy recognises the
 * page itself for booking hosts no list knows yet.
 *
 * Per CLAUDE.md §15: require() the real functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectPromoBookingCopy, PROMO_BOOKING_COPY_PATTERNS } = require('../../scripts/lib/content-quality.js');
const { isBlockedReviewUrl, isBlockedReviewRecord } = require('../../scripts/lib/domain-filters.js');
const { auditShowFiles } = require('../../scripts/audit-promo-booking-copy.js');

const STAYBOOK_URL = 'https://staybook.in/activities/jeeves-takes-charge';
const PROMO = 'Jeeves Takes Charge. Get your booking confirmed instantly. '
  + 'Starring Sam Harrison in a delightful one-man comedy at the theatre. '
  + 'Grab great deals before they are gone! Select a date and check availability.';

// Real-review shape: long, theatre-heavy, one ticket line at the very end.
const REVIEW = Array.from({ length: 12 }, (_, i) =>
  `The production's staging and the cast's performance in act ${i} make this revival a sharp evening of theatre; the director keeps the play moving.`,
).join(' ') + ' Tickets: book now at the box office, free cancellation available.';

test('BRO-5906: staybook.in is a blocked booking domain at ingest and at rebuild', () => {
  assert.equal(isBlockedReviewUrl(STAYBOOK_URL), true);
  assert.equal(isBlockedReviewUrl('https://www.staybook.in/activities/x'), true);
  assert.equal(isBlockedReviewRecord({ url: STAYBOOK_URL, outletId: 'staybook' }), true);
});

test('BRO-5906: the staybook booking copy is detected', () => {
  const r = detectPromoBookingCopy(PROMO);
  assert.equal(r.detected, true);
  assert.ok(r.matches.length >= 2, r.matches.join(' | '));
});

test('a single booking phrase is not enough', () => {
  assert.equal(detectPromoBookingCopy('A fine revival. Check availability at the box office.').detected, false);
});

test('a real review ending in a ticket footer is not flagged', () => {
  const r = detectPromoBookingCopy(REVIEW);
  assert.equal(r.detected, false, r.matches.join(' | '));
});

test('review prose using ordinary words ("before they are gone") is not flagged', () => {
  const t = 'Catch these performances before they are gone: the cast is extraordinary and the staging inventive.';
  assert.equal(detectPromoBookingCopy(t).detected, false);
});

test('plain-English weak phrases alone are not flagged (ship-check FP)', () => {
  const prose = 'In the second act the lovers choose a date for the wedding, and the townsfolk race to see the fireworks before they are all gone.';
  assert.equal(detectPromoBookingCopy(prose).detected, false);
  const capsule = 'Skip the line at TKTS, choose a date midweek and catch this revival before they are gone.';
  const r = detectPromoBookingCopy(capsule);
  assert.equal(r.strongHits, 0);
  assert.equal(r.detected, false);
});

test('a phrase repeated in the body and the footer is not excused as footer text', () => {
  const body = 'Get your booking confirmed instantly. Grab great deals today. ';
  const t = body + REVIEW + ' ' + body;
  assert.equal(detectPromoBookingCopy(t).detected, true);
});

test('non-string input is safe', () => {
  assert.equal(detectPromoBookingCopy(null).detected, false);
  assert.equal(detectPromoBookingCopy(undefined).detected, false);
});

test('patterns carry no stray control characters', () => {
  for (const p of PROMO_BOOKING_COPY_PATTERNS) assert.ok(!/[\x00-\x08]/.test(p.source), p.source);
});

test('sweep: reports promo, blocked, show-hub and live same-URL twins', () => {
  const show = 'jeeves-takes-charge-west-end-2026';
  const files = [
    { file: 'staybook--staybook.json', data: { outletId: 'staybook', url: STAYBOOK_URL, source: 'submit-review-form', contentTier: 'truncated', fullText: PROMO } },
    { file: 'dtli--unknown.json', data: { outletId: 'dtli', url: 'https://didtheylikeit.com/shows/jeeves-takes-charge/', contentTier: 'complete', fullText: REVIEW } },
    { file: 'people--dave-quinn.json', data: { outletId: 'people', url: 'https://people.com/review-1', contentTier: 'complete', fullText: REVIEW } },
    { file: 'people--unknown.json', data: { outletId: 'people', url: 'https://www.people.com/review-1/', contentTier: 'complete', fullText: REVIEW } },
    { file: 'old--unknown.json', data: { outletId: 'old', url: 'https://people.com/review-1', contentTier: 'invalid', fullText: REVIEW } },
    { file: 'nullfile.json', data: null },
    { file: 'q1--unknown.json', data: { outletId: 'q', url: 'https://example.com/review?p=1', contentTier: 'complete', fullText: REVIEW } },
    { file: 'q2--unknown.json', data: { outletId: 'q', url: 'https://example.com/review?p=2&utm_source=x', contentTier: 'complete', fullText: REVIEW } },
  ];
  const r = auditShowFiles(show, files);
  assert.deepEqual(r.promo.map(x => x.id), [`${show}/staybook--staybook.json`]);
  assert.equal(r.promo[0].live, true);
  assert.deepEqual(r.blocked.map(x => x.id), [`${show}/staybook--staybook.json`]);
  assert.deepEqual(r.showHub.map(x => x.id), [`${show}/dtli--unknown.json`]);
  assert.deepEqual(r.twins, [[`${show}/people--dave-quinn.json`, `${show}/people--unknown.json`]]);
});
