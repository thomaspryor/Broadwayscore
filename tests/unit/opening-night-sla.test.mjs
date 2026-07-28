import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { evaluateSlaForReviews, dispatchSlaAlerts, isTestShowId } = require('../../scripts/lib/opening-night-sla.js');

const MS_MIN = 60 * 1000;

function makeEntry(showId, reviewKey, stage, minsAgo, now) {
  return {
    showId,
    reviewKey,
    stage,
    at: new Date(now - minsAgo * MS_MIN).toISOString(),
  };
}

test('clean — no in-flight reviews produces empty warnings and pages', () => {
  const now = new Date('2026-04-15T22:00:00Z');
  const entries = [
    makeEntry('show-a', 'nytimes:brantley:https://x.com', 'review-first-seen', 45, now),
    makeEntry('show-a', 'nytimes:brantley:https://x.com', 'deployed-live', 10, now),
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { now });
  assert.equal(warnings.length, 0);
  assert.equal(pages.length, 0);
});

test('one-warn — review in-flight 35 min produces one warning', () => {
  const now = new Date('2026-04-15T22:00:00Z');
  const entries = [
    makeEntry('show-b', 'guardian:akbar:https://g.com', 'review-first-seen', 35, now),
    // no deployed-live
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(warnings.length, 1);
  assert.equal(pages.length, 0);
  assert.equal(warnings[0].showId, 'show-b');
  assert.equal(warnings[0].outletId, 'guardian');
  assert.equal(warnings[0].elapsedMin, 35);
});

test('one-page — review in-flight 70 min produces one page (not in warnings)', () => {
  const now = new Date('2026-04-15T22:00:00Z');
  const entries = [
    makeEntry('show-c', 'nypost:bloom:https://p.com', 'review-first-seen', 70, now),
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(warnings.length, 0);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].elapsedMin, 70);
});

test('one-of-each — mixed bag: clean, warn, page', () => {
  const now = new Date('2026-04-15T22:00:00Z');
  const entries = [
    // clean (per-key deployed-live)
    makeEntry('show-a', 'nytimes:brantley:https://x.com', 'review-first-seen', 50, now),
    makeEntry('show-a', 'nytimes:brantley:https://x.com', 'deployed-live', 5, now),
    // warning (35 min in-flight)
    makeEntry('show-a', 'guardian:akbar:https://g.com', 'review-first-seen', 35, now),
    // page (75 min in-flight)
    makeEntry('show-a', 'nypost:bloom:https://p.com', 'review-first-seen', 75, now),
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(warnings.length, 1, 'one warning');
  assert.equal(pages.length, 1, 'one page');
});

test('keyless entries do not create phantom review keys', () => {
  const now = new Date('2026-04-15T22:00:00Z');
  const entries = [
    // rebuilt summary — no reviewKey, and BEFORE the review's first-seen so it
    // does not clear it (a rebuild that predates a review can't include it).
    { showId: 'show-a', reviewKey: null, stage: 'rebuilt', at: new Date(now - 55 * MS_MIN).toISOString() },
    // deployed-live — no showId
    { showId: null, reviewKey: null, stage: 'deployed-live', at: new Date(now - 5 * MS_MIN).toISOString() },
    // valid in-flight review — should still be caught
    makeEntry('show-a', 'variety:jones:https://v.com', 'review-first-seen', 40, now),
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(warnings.length, 1);
  assert.equal(pages.length, 0);
});

// --- Regression coverage for the 2026-07-24 false-page storm ---

test('show-level rebuilt at/after first-seen clears the review (the core fix)', () => {
  // deployed-live/rebuilt are emitted per-SHOW without a reviewKey. The old
  // code only matched deployed-live PER reviewKey, so it never cleared and
  // every review paged forever. A show rebuild AFTER the review's first-seen
  // means the review was folded into the site.
  const now = new Date('2026-07-24T14:00:00Z');
  const entries = [
    makeEntry('trainspotting-the-musical-west-end-2026', 'theatre-weekly:greg-stewart:https://tw.com/r', 'review-first-seen', 90, now),
    // keyless show-level rebuild 30 min ago (after the 90-min-ago first-seen)
    { showId: 'trainspotting-the-musical-west-end-2026', reviewKey: null, stage: 'rebuilt', at: new Date(now - 30 * MS_MIN).toISOString() },
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(pages.length, 0, 'show-level rebuild clears a would-be page');
  assert.equal(warnings.length, 0);
});

test('activeShowIds scopes out test fixtures and historical backfills', () => {
  const now = new Date('2026-07-24T14:00:00Z');
  const entries = [
    // CI test fixture — never a real opening-night show
    makeEntry('guard-g-flag', 'variety:peter-marks:https://variety.com/fake-review-1', 'review-first-seen', 300, now),
    // historical backfill — real show, but not tonight's opening
    makeEntry('the-lion-king-1997', 'jasonraize:frank-scheck:http://old.net', 'review-first-seen', 275, now),
    // the actual opening we're shepherding — genuinely stuck
    makeEntry('trainspotting-the-musical-west-end-2026', 'theatre-weekly:greg:https://tw.com/r', 'review-first-seen', 70, now),
  ];
  const scoped = evaluateSlaForReviews(entries, { now, activeShowIds: ['trainspotting-the-musical-west-end-2026'] });
  assert.equal(scoped.pages.length, 1, 'only the active show pages');
  assert.equal(scoped.pages[0].showId, 'trainspotting-the-musical-west-end-2026');

  // Empty active list → nothing in scope → zero pages (safe failure mode).
  const none = evaluateSlaForReviews(entries, { now, activeShowIds: [] });
  assert.equal(none.pages.length, 0);
});

test('without activeShowIds, obvious test fixtures are still excluded', () => {
  const now = new Date('2026-07-24T14:00:00Z');
  const entries = [
    makeEntry('guard-g-flag', 'variety:pm:https://variety.com/fake-review-1', 'review-first-seen', 300, now),
    makeEntry('test-show-2026', 'variety:dd:https://variety.com/x', 'review-first-seen', 300, now),
    makeEntry('merge-show-2026', 'variety:jc:https://variety.com/y', 'review-first-seen', 300, now),
    makeEntry('fs-show', 'variety:nk:https://variety.com/z', 'review-first-seen', 300, now),
    // a real show with no terminal → still pages
    makeEntry('some-real-show-2026', 'nytimes:x:https://nyt.com/r', 'review-first-seen', 90, now),
  ];
  const { pages } = evaluateSlaForReviews(entries, { now });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].showId, 'some-real-show-2026');
});

test('isTestShowId recognizes CI fixture ids but not real shows', () => {
  assert.ok(isTestShowId('guard-g-flag'));
  assert.ok(isTestShowId('test-show-2026'));
  assert.ok(isTestShowId('merge-show-2026'));
  assert.ok(isTestShowId('fs-show'));
  assert.ok(isTestShowId('fsm-show'));
  assert.equal(isTestShowId('trainspotting-the-musical-west-end-2026'), false);
  assert.equal(isTestShowId('the-lion-king-1997'), false);
});

// --- dispatchSlaAlerts: router migration (dedup + growth re-notify + resolve) ---

function makeHarness() {
  const calls = { routed: [], resolved: [] };
  // Simulate the router ledger: one open incident per conditionKey; a
  // 'human' route emails once, then goes 'silent' until resolveCondition().
  const openIncidents = new Set();
  const route = async (opts) => {
    calls.routed.push(opts);
    if (opts.disposition === 'human') {
      if (openIncidents.has(opts.conditionKey)) return { action: 'silent', conditionKey: opts.conditionKey };
      openIncidents.add(opts.conditionKey);
      return { action: 'human', conditionKey: opts.conditionKey, delivered: true };
    }
    return { action: opts.disposition, conditionKey: opts.conditionKey };
  };
  const resolve = (key) => {
    calls.resolved.push(key);
    const had = openIncidents.has(key);
    openIncidents.delete(key);
    return had;
  };
  return { calls, route, resolve, openIncidents };
}

let stateCounter = 0;
function tmpStatePath() {
  return path.join(os.tmpdir(), `sla-state-${process.pid}-${stateCounter++}.json`);
}

test('pages email once, then dedup silently on a non-growing refire', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();
  const pages = [{ showId: 's', outletId: 'o', elapsedMin: 70 }];

  await dispatchSlaAlerts({ warnings: [], pages }, { route: h.route, resolve: h.resolve, statePath });
  await dispatchSlaAlerts({ warnings: [], pages }, { route: h.route, resolve: h.resolve, statePath });

  const humanRoutes = h.calls.routed.filter(r => r.disposition === 'human');
  assert.equal(humanRoutes.length, 2, 'routeAlert called both times');
  // Only ONE actually emailed — the second was a silent refire in the router.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.notifiedPageCount, 1);
  fs.rmSync(statePath, { force: true });
});

test('a growing count re-notifies once (resolve → re-open)', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();

  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 's1', outletId: 'o', elapsedMin: 70 }] }, { route: h.route, resolve: h.resolve, statePath });
  // grew 1 → 3
  await dispatchSlaAlerts({ warnings: [], pages: [
    { showId: 's1', outletId: 'o', elapsedMin: 70 },
    { showId: 's2', outletId: 'o', elapsedMin: 65 },
    { showId: 's3', outletId: 'o', elapsedMin: 61 },
  ] }, { route: h.route, resolve: h.resolve, statePath });

  // The growth path resolves the open incident so the router re-emails.
  assert.ok(h.calls.resolved.includes('opening-night-sla:pages-stuck'), 'resolved on growth');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.notifiedPageCount, 3, 'peak advanced to the grown count');
  fs.rmSync(statePath, { force: true });
});

test('draining to 0 resolves the incident so the next occurrence notifies fresh', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();

  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 's', outletId: 'o', elapsedMin: 70 }] }, { route: h.route, resolve: h.resolve, statePath });
  assert.ok(h.openIncidents.has('opening-night-sla:pages-stuck'));

  // drained
  await dispatchSlaAlerts({ warnings: [], pages: [] }, { route: h.route, resolve: h.resolve, statePath });
  assert.equal(h.openIncidents.has('opening-night-sla:pages-stuck'), false, 'incident resolved on drain');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.notifiedPageCount, 0);

  // reoccurs → emails again (fresh incident)
  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 's', outletId: 'o', elapsedMin: 62 }] }, { route: h.route, resolve: h.resolve, statePath });
  const humanRoutes = h.calls.routed.filter(r => r.disposition === 'human' && r.conditionKey === 'opening-night-sla:pages-stuck');
  assert.equal(humanRoutes.length, 2);
  fs.rmSync(statePath, { force: true });
});

test('warnings route to digest disposition (never their own email)', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();
  await dispatchSlaAlerts({ warnings: [{ showId: 's', outletId: 'o', elapsedMin: 40 }], pages: [] }, { route: h.route, resolve: h.resolve, statePath });
  const warnRoute = h.calls.routed.find(r => r.conditionKey === 'opening-night-sla:warnings-delayed');
  assert.ok(warnRoute, 'warning was routed');
  assert.equal(warnRoute.disposition, 'digest');
  fs.rmSync(statePath, { force: true });
});

test('empty warnings resolve the warn condition (so a fresh batch re-digests)', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();
  await dispatchSlaAlerts({ warnings: [], pages: [] }, { route: h.route, resolve: h.resolve, statePath });
  assert.ok(h.calls.resolved.includes('opening-night-sla:warnings-delayed'), 'warn condition resolved on empty');
  fs.rmSync(statePath, { force: true });
});

test('a failed page delivery does not advance the notified peak (retries next run)', async () => {
  const calls = { routed: [] };
  // Router path that returns action:'human' but delivered:false (Resend down) —
  // it does NOT record its ledger, so the incident stays fresh and retries.
  const route = async (opts) => { calls.routed.push(opts); return { action: 'human', delivered: false, conditionKey: opts.conditionKey }; };
  const resolve = () => false;
  const statePath = tmpStatePath();

  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 's', outletId: 'o', elapsedMin: 70 }] }, { route, resolve, statePath });
  // Peak must NOT advance to 1 — nobody received the page.
  const exists = fs.existsSync(statePath);
  const state = exists ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  assert.notEqual(state.notifiedPageCount, 1, 'peak not advanced on failed delivery');
  if (exists) fs.rmSync(statePath, { force: true });
});

test('a page-worthy-gate digest downgrade still advances the peak and re-fires on growth (card #616 follow-up)', async () => {
  // Simulates routeAlert() downgrading disposition:'human' to action:'digest'
  // (page-worthy gate, card #611) — the peak must still advance, or the
  // resolve-on-growth check below can never see prevNotified > 0 and the
  // condition goes silent under the router's own 30-day cooldown instead of
  // re-queuing a digest line on the next stuck-count check.
  const calls = { routed: [], resolved: [] };
  const openIncidents = new Set();
  const route = async (opts) => {
    calls.routed.push(opts);
    if (openIncidents.has(opts.conditionKey)) return { action: 'silent', conditionKey: opts.conditionKey };
    openIncidents.add(opts.conditionKey);
    return { action: 'digest', conditionKey: opts.conditionKey, requestedDisposition: opts.disposition };
  };
  const resolve = (key) => {
    calls.resolved.push(key);
    const had = openIncidents.has(key);
    openIncidents.delete(key);
    return had;
  };
  const statePath = tmpStatePath();

  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 's1', outletId: 'o', elapsedMin: 70 }] }, { route, resolve, statePath });
  let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.notifiedPageCount, 1, 'peak advances on a digest downgrade, not just a real email');

  // grew 1 → 3 while still gated to digest — must resolve-and-reopen, not go silent.
  await dispatchSlaAlerts({ warnings: [], pages: [
    { showId: 's1', outletId: 'o', elapsedMin: 90 },
    { showId: 's2', outletId: 'o', elapsedMin: 65 },
    { showId: 's3', outletId: 'o', elapsedMin: 61 },
  ] }, { route, resolve, statePath });

  assert.ok(calls.resolved.includes('opening-night-sla:pages-stuck'), 'growth resolves the incident even under a digest downgrade');
  const digestRoutes = calls.routed.filter(r => r.conditionKey === 'opening-night-sla:pages-stuck' && r.disposition === 'human');
  assert.equal(digestRoutes.length, 2, 'both calls requested human — neither was silently skipped');
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.notifiedPageCount, 3, 'peak advanced to the grown count on the second digest downgrade');
  fs.rmSync(statePath, { force: true });
});
