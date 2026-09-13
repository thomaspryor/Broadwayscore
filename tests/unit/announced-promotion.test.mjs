import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideAnnouncedPromotion, blockAnnouncedCatchUp, ANNOUNCED_PROMOTE_MAX_STALE_DAYS } = require('../../scripts/lib/announced-promotion.js');

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

// --- blockAnnouncedCatchUp: the Check 2d gate for 'announced' shows ---------
// BRO-3091 added 'announced' to opening-signal.js's PRE_OPEN_STATUSES so the
// review-driven catch-up could unstick the date-less discovery class. These
// tests pin the two holes that opened up, both found in ship-check review.

const dayBefore = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

test('gate ignores every non-announced status (previews/upcoming behaviour unchanged)', () => {
  for (const status of ['previews', 'upcoming', 'open', 'closed']) {
    // Even with a zombie-shaped decision and an ancient press night, a
    // non-announced show is not this gate's business.
    assert.equal(
      blockAnnouncedCatchUp({ status }, { action: 'triage', reason: 'x' }, '2019-01-01', NOW),
      null,
      `${status} must be unaffected`
    );
  }
});

test('the real BRO-3091 case is ALLOWED: date-less announced, fresh press night', () => {
  // night-city-off-west-end-2026 on 2026-09-13: both dates null, Check 2e
  // returns 'none', reviews published the day before.
  const show = { id: 'night-city-off-west-end-2026', status: 'announced', openingDate: null, previewsStartDate: null };
  const decision = decideAnnouncedPromotion(show, NOW);
  assert.deepEqual(decision, { action: 'none' }, 'precondition: 2e declines, so 2d is what acts');
  assert.equal(blockAnnouncedCatchUp(show, decision, dayBefore(1), NOW), null);
});

test('zombie bypass is closed: a triage entry is never caught up to open', () => {
  // Check 2e deliberately only LOGS zombies so they never reach "Now Playing",
  // but triage sets no changes.status, so Check 2d used to run next and promote
  // the very entries the 45-day rule protects.
  const show = { id: 'age-is-a-feeling-off-broadway-2024', status: 'announced', openingDate: null, previewsStartDate: '2024-09-11' };
  const decision = decideAnnouncedPromotion(show, NOW);
  assert.equal(decision.action, 'triage', 'precondition: this is a zombie entry');
  const blocked = blockAnnouncedCatchUp(show, decision, dayBefore(1), NOW);
  assert.ok(blocked, 'a zombie must be blocked even with a fresh-looking press night');
  assert.match(blocked.reason, /zombie entry/);
});

test('no temporal floor is closed: dateless reviews cannot flip an announced show', () => {
  // isStuckInPreviews (the score-threshold arm) counts reviews and consults no
  // date at all, so without this a pile of dateless reviews was enough.
  const show = { id: 'x', status: 'announced', openingDate: null, previewsStartDate: null };
  const blocked = blockAnnouncedCatchUp(show, { action: 'none' }, null, NOW);
  assert.ok(blocked);
  assert.match(blocked.reason, /no press night is derivable/);
});

test("prior-production reviews cannot stamp a stale press night as this run's opening", () => {
  // A returning production with declared priorRuns keeps its prior-run reviews
  // in reviews.json (review-guards.js), and openSignalFromReviews' lower bound
  // is inert when previewsStartDate is null — exactly this class.
  const show = { id: 'x', status: 'announced', openingDate: null, previewsStartDate: null };
  const blocked = blockAnnouncedCatchUp(show, { action: 'none' }, '2019-04-01', NOW);
  assert.ok(blocked);
  assert.match(blocked.reason, /is \d+d old/);
});

test('recency boundary reuses ANNOUNCED_PROMOTE_MAX_STALE_DAYS (one horizon, not two)', () => {
  const show = { id: 'x', status: 'announced', openingDate: null, previewsStartDate: null };
  // Exactly at the horizon is still allowed; one day past it is blocked.
  assert.equal(blockAnnouncedCatchUp(show, { action: 'none' }, dayBefore(ANNOUNCED_PROMOTE_MAX_STALE_DAYS), NOW), null);
  const blocked = blockAnnouncedCatchUp(show, { action: 'none' }, dayBefore(ANNOUNCED_PROMOTE_MAX_STALE_DAYS + 1), NOW);
  assert.ok(blocked);
  assert.match(blocked.reason, /prior production/);
});

test('a future press night is not blocked here (isDateReached already gates it upstream)', () => {
  // Negative age = future. The signal functions refuse unreached press nights
  // before this gate is consulted, so this gate must not double-guess them.
  const show = { id: 'x', status: 'announced', openingDate: null, previewsStartDate: null };
  assert.equal(blockAnnouncedCatchUp(show, { action: 'none' }, '2026-12-25', NOW), null);
});

test('update-show-status.js Check 2d actually calls the gate', () => {
  // Wiring guard: the gate is only worth anything if the pipeline consults it.
  // Mirrors tests/unit/stale-announced-evidence.test.mjs' source-text check.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'update-show-status.js'), 'utf8');
  assert.ok(/blockAnnouncedCatchUp/.test(src), 'update-show-status.js must import and call blockAnnouncedCatchUp');
  assert.ok(
    /if \(!announcedBlock && \(scoreThreshold \|\| openSignal \|\| discoverySignal\)\)/.test(src),
    'the Check 2d flip must be gated on announcedBlock'
  );
});
