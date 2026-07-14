import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideAnnouncedPromotion, ANNOUNCED_PROMOTE_MAX_STALE_DAYS } = require('../../scripts/lib/announced-promotion.js');

// Fixed clock so results don't drift: "today" is 2026-07-14.
const NOW = new Date('2026-07-14T12:00:00');

test('non-announced show → none', () => {
  const r = decideAnnouncedPromotion({ status: 'upcoming', previewsStartDate: '2026-08-01' }, NOW);
  assert.deepEqual(r, { action: 'none' });
});

test('announced with no dates → none (stays announced)', () => {
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: null, previewsStartDate: null }, NOW);
  assert.deepEqual(r, { action: 'none' });
});

test('announced with future previews date → promote to upcoming (Dolly class)', () => {
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: null, previewsStartDate: '2026-11-27' }, NOW);
  assert.deepEqual(r, { action: 'promote', to: 'upcoming' });
});

test('announced with future opening + future previews → upcoming', () => {
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: '2026-08-19', previewsStartDate: '2026-08-12' }, NOW);
  assert.deepEqual(r, { action: 'promote', to: 'upcoming' });
});

test('announced, previews started recently, opening in future → previews', () => {
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: '2026-07-22', previewsStartDate: '2026-07-10' }, NOW);
  assert.deepEqual(r, { action: 'promote', to: 'previews' });
});

test('announced, opening date reached recently → open (The Oresteia class)', () => {
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: '2026-07-14', previewsStartDate: '2026-07-02' }, NOW);
  assert.deepEqual(r, { action: 'promote', to: 'open' });
});

test('zombie: previews date months in the past → triage, never promoted (TodayTix Jan-1 placeholder)', () => {
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: null, previewsStartDate: '2026-01-01', title: 'Dolly', id: 'dolly-an-original-musical-2026' }, NOW);
  assert.equal(r.action, 'triage');
  assert.match(r.reason, /previewsStartDate 2026-01-01/);
});

test('zombie: opening date years in the past → triage (wanted-2022 class)', () => {
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: '2024-06-25', previewsStartDate: null }, NOW);
  assert.equal(r.action, 'triage');
});

test('stale placeholder openingDate + future previewsStartDate → promotes to upcoming, not triaged', () => {
  // Codex review 2026-07-14: openingDate-first precedence must not let a bad
  // placeholder openingDate permanently triage a show with a corrected
  // future previews date.
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: '2026-01-01', previewsStartDate: '2026-09-15' }, NOW);
  assert.deepEqual(r, { action: 'promote', to: 'upcoming' });
});

test('stale previewsStartDate + recent reached openingDate → promotes to open', () => {
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: '2026-07-10', previewsStartDate: '2026-01-01' }, NOW);
  assert.deepEqual(r, { action: 'promote', to: 'open' });
});

test('both dates stale → triage names both', () => {
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: '2024-06-25', previewsStartDate: '2024-02-14' }, NOW);
  assert.equal(r.action, 'triage');
  assert.match(r.reason, /openingDate 2024-06-25 and previewsStartDate 2024-02-14/);
});

test('boundary: date reached just inside the stale window still promotes', () => {
  const withinWindow = new Date(NOW.getTime() - (ANNOUNCED_PROMOTE_MAX_STALE_DAYS - 1) * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  const r = decideAnnouncedPromotion({ status: 'announced', openingDate: withinWindow, previewsStartDate: null }, NOW);
  assert.deepEqual(r, { action: 'promote', to: 'open' });
});
