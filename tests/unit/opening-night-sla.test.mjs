import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { evaluateSlaForReviews, dispatchSlaAlerts, isTestShowId, resolveSlaScope } = require('../../scripts/lib/opening-night-sla.js');

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

// --- Regression coverage for the 2026-08-08 rebuild-emit scoping (task #388) ---

test('the run-level rebuild line (no showId) is NOT a terminal for any show', () => {
  // rebuild-all-reviews emits one showId-less 'rebuilt' line per run alongside
  // the per-show terminals, which were scoped down from ~1,210 lines to the
  // shows the SLA tracks. Honouring the run-level line as a terminal was the
  // tempting simplification and it is WRONG: per-show lines only ever existed
  // for shows with >=1 review in reviews.json, so a show whose first review is
  // still unscored has none. At the time of the change 2 of the 13 shows with
  // review-first-seen events had never appeared in a 'rebuilt' line. Clearing
  // on the run-level line would silently drop exactly the case this SLA is for.
  const now = new Date('2026-08-08T14:00:00Z');
  const entries = [
    makeEntry('the-peculiar-patriot-off-broadway-2026', 'nytimes:shaw:https://nyt/r', 'review-first-seen', 90, now),
    { showId: null, reviewKey: null, stage: 'rebuilt', at: new Date(now - 30 * MS_MIN).toISOString(), metadata: { scope: 'all-shows', showCount: 1210, perShowTerminalsEmitted: 11 } },
  ];
  const { pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(pages.length, 1, 'a stuck first review still pages despite a run-level rebuild');
  assert.equal(pages[0].showId, 'the-peculiar-patriot-off-broadway-2026');
});

test('a per-show rebuild still clears, and the run-level line alongside it changes nothing', () => {
  const now = new Date('2026-08-08T14:00:00Z');
  const entries = [
    makeEntry('now-you-see-me-live-west-end-2026', 'thestage:tim-bano:https://ts.com/r', 'review-first-seen', 90, now),
    { showId: 'now-you-see-me-live-west-end-2026', reviewKey: null, stage: 'rebuilt', at: new Date(now - 30 * MS_MIN).toISOString(), metadata: { reviewCount: 4 } },
    { showId: null, reviewKey: null, stage: 'rebuilt', at: new Date(now - 30 * MS_MIN).toISOString(), metadata: { scope: 'all-shows' } },
  ];
  const { warnings, pages } = evaluateSlaForReviews(entries, { warningMinutes: 30, pageMinutes: 60, now });
  assert.equal(pages.length, 0);
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
  // Simulates the router ledger: one open incident per conditionKey; an 'auto'
  // route files a card once, then goes 'silent' until resolveCondition().
  const openIncidents = new Set();
  const route = async (opts) => {
    calls.routed.push(opts);
    if (openIncidents.has(opts.conditionKey)) return { action: 'silent', conditionKey: opts.conditionKey };
    openIncidents.add(opts.conditionKey);
    return { action: opts.disposition, conditionKey: opts.conditionKey, dispatchOk: true };
  };
  const resolve = (key) => {
    calls.resolved.push(key);
    const had = openIncidents.has(key);
    openIncidents.delete(key);
    return had;
  };
  const readLedger = () => ({ conditions: Object.fromEntries([...openIncidents].map(k => [k, { status: 'open', disposition: 'auto' }])) });
  return { calls, route, resolve, readLedger, openIncidents };
}

let stateCounter = 0;
function tmpStatePath() {
  return path.join(os.tmpdir(), `sla-state-${process.pid}-${stateCounter++}.json`);
}

const PAGE_KEY = 'opening-night-sla:pages-stuck';
const opt = (h, statePath) => ({ route: h.route, resolve: h.resolve, readLedger: h.readLedger, statePath });

test('stuck reviews file one PARKED card per show (never an owner email), then dedup silently (BRO-5480)', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();
  const pages = [{ showId: 's', outletId: 'o', elapsedMin: 70 }, { showId: 's', outletId: 'p', elapsedMin: 65 }];
  await dispatchSlaAlerts({ warnings: [], pages }, opt(h, statePath));
  await dispatchSlaAlerts({ warnings: [], pages }, opt(h, statePath));
  const pageRoutes = h.calls.routed.filter(r => r.conditionKey.startsWith(PAGE_KEY));
  assert.equal(pageRoutes.length, 2, 'one route per show per run');
  for (const r of pageRoutes) {
    assert.equal(r.conditionKey, `${PAGE_KEY}:s`);
    assert.equal(r.disposition, 'auto');
    assert.notEqual(r.dispatchAtFiling, true, 'parked, so the CI sweep cancels it on drain');
  }
  assert.equal(h.calls.routed.some(r => r.disposition === 'human'), false, 'nothing asks to email the owner');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).stuckShows, ['s']);
  fs.rmSync(statePath, { force: true });
});

test('a second stuck show gets its own card; the first stays silent', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();
  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 'a', outletId: 'o', elapsedMin: 70 }] }, opt(h, statePath));
  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 'a', outletId: 'o', elapsedMin: 130 }, { showId: 'b', outletId: 'o', elapsedMin: 61 }] }, opt(h, statePath));
  assert.deepEqual([...h.openIncidents].sort(), [`${PAGE_KEY}:a`, `${PAGE_KEY}:b`]);
  assert.equal(h.calls.resolved.filter(k => k.startsWith(PAGE_KEY)).length, 0, 'no resolve-and-reopen churn');
  fs.rmSync(statePath, { force: true });
});

test('a show that drains resolves its own key; others stay open; the next occurrence files fresh', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();
  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 'a', outletId: 'o', elapsedMin: 70 }, { showId: 'b', outletId: 'o', elapsedMin: 70 }] }, opt(h, statePath));
  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 'b', outletId: 'o', elapsedMin: 130 }] }, opt(h, statePath));
  assert.deepEqual([...h.openIncidents], [`${PAGE_KEY}:b`]);
  await dispatchSlaAlerts({ warnings: [], pages: [] }, opt(h, statePath));
  assert.equal(h.openIncidents.size, 0, 'all drained');
  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 'a', outletId: 'o', elapsedMin: 62 }] }, opt(h, statePath));
  assert.ok(h.openIncidents.has(`${PAGE_KEY}:a`), 'fresh incident, fresh card');
  fs.rmSync(statePath, { force: true });
});

test('the pre-BRO-5480 shared email incident left open resolves on the next run', async () => {
  const h = makeHarness();
  h.openIncidents.add(PAGE_KEY); // legacy shared key, opened under disposition 'human'
  const statePath = tmpStatePath();
  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 's', outletId: 'o', elapsedMin: 700 }] }, opt(h, statePath));
  assert.ok(h.calls.resolved.includes(PAGE_KEY), 'legacy key resolved');
  assert.ok(h.openIncidents.has(`${PAGE_KEY}:s`), 'and the per-show card filed');
  fs.rmSync(statePath, { force: true });
});

test('the state file is rewritten only when the stuck-show set changes (it is committed hourly)', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();
  await dispatchSlaAlerts({ warnings: [], pages: [] }, opt(h, statePath));
  assert.equal(fs.existsSync(statePath), false, 'nothing stuck, nothing ever stuck: no write');
  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 's', outletId: 'o', elapsedMin: 70 }] }, opt(h, statePath));
  const first = fs.readFileSync(statePath, 'utf8');
  await dispatchSlaAlerts({ warnings: [], pages: [{ showId: 's', outletId: 'o', elapsedMin: 130 }] }, opt(h, statePath));
  assert.equal(fs.readFileSync(statePath, 'utf8'), first, 'same set: untouched');
  fs.rmSync(statePath, { force: true });
});

test('warnings route to digest disposition (never their own email)', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();
  await dispatchSlaAlerts({ warnings: [{ showId: 's', outletId: 'o', elapsedMin: 40 }], pages: [] }, opt(h, statePath));
  const warnRoute = h.calls.routed.find(r => r.conditionKey === 'opening-night-sla:warnings-delayed');
  assert.ok(warnRoute, 'warning was routed');
  assert.equal(warnRoute.disposition, 'digest');
  fs.rmSync(statePath, { force: true });
});

test('empty warnings resolve the warn condition (so a fresh batch re-digests)', async () => {
  const h = makeHarness();
  const statePath = tmpStatePath();
  await dispatchSlaAlerts({ warnings: [], pages: [] }, opt(h, statePath));
  assert.ok(h.calls.resolved.includes('opening-night-sla:warnings-delayed'), 'warn condition resolved on empty');
  fs.rmSync(statePath, { force: true });
});

// --- BRO-5427: duplicate P0 email + junk reviews paging as stuck ---

const { shouldEmitExcludedStage, reviewIdentity, TERMINAL_EXCLUSION_REASONS, TERMINAL_WHEN_ABANDONED_REASONS, createExcludedStageEmitter, excludedReviewIdentities } = require('../../scripts/lib/stage-latency.js');

test('resolveSlaScope: missing/unparseable checklist is an UNKNOWN scope', () => {
  assert.equal(resolveSlaScope(null).known, false);
  assert.equal(resolveSlaScope('garbage').known, false);
});

test('resolveSlaScope: a fabricated {shows:[]} without generatedAt is not a real run', () => {
  assert.equal(resolveSlaScope({ shows: [] }).known, false);
});

test('resolveSlaScope: the real zero-shows payload is a KNOWN empty scope', () => {
  const r = resolveSlaScope({ generatedAt: '2026-10-15T13:22:00Z', shows: [], error: 'No shows with openingDate within ±2 days' });
  assert.equal(r.known, true);
  assert.deepEqual(r.activeShowIds, []);
});

test('resolveSlaScope: schema drift (shows but no ids) is unknown; normal payload yields ids', () => {
  assert.equal(resolveSlaScope({ generatedAt: 'x', shows: [{ summary: {} }] }).known, false);
  const r = resolveSlaScope({ generatedAt: 'x', shows: [{ show: { id: 'a' } }, { showId: 'b' }] });
  assert.equal(r.known, true);
  assert.deepEqual(r.activeShowIds, ['a', 'b']);
});

test('an excluded stage clears the review even when critic casing and url form differ (the 2026-10-15 pages)', () => {
  const now = new Date('2026-10-15T15:07:00Z');
  const entries = [
    // first-seen keyed with the unenriched critic, later excluded under the enriched byline
    makeEntry('midnight-off-broadway-2026', 'rollingstone:neil-griffiths:https://au.rollingstone.com/music/x-102167/', 'review-first-seen', 833, now),
    makeEntry('midnight-off-broadway-2026', 'rollingstone:neil-griffiths:http://www.au.rollingstone.com/music/x-102167', 'excluded', 800, now),
    makeEntry('memoirs-show', 'theatermania:unknown:https://www.theatermania.com/news/finishing-memoirs_1856138/', 'review-first-seen', 87, now),
    makeEntry('memoirs-show', 'theatermania:david-gordon:https://www.theatermania.com/news/finishing-memoirs_1856138/', 'excluded', 60, now),
    // a real, un-excluded review on the same show still pages
    makeEntry('memoirs-show', 'nytimes:someone:https://www.nytimes.com/2026/10/15/theater/memoirs-review.html', 'review-first-seen', 90, now),
  ];
  const { pages } = evaluateSlaForReviews(entries, { now, activeShowIds: ['midnight-off-broadway-2026', 'memoirs-show'] });
  assert.deepEqual(pages.map(p => p.outletId), ['nytimes']);
});

test('an excluded stage for a different outlet or url does not clear a review', () => {
  const now = new Date('2026-10-15T15:07:00Z');
  const entries = [
    makeEntry('s', 'nytimes:a:https://nytimes.com/r1', 'review-first-seen', 90, now),
    makeEntry('s', 'vulture:a:https://nytimes.com/r1', 'excluded', 10, now),
    makeEntry('s', 'nytimes:a:https://nytimes.com/r2', 'excluded', 10, now),
  ];
  assert.equal(evaluateSlaForReviews(entries, { now, activeShowIds: ['s'] }).pages.length, 1);
});

test('reviewIdentity ignores the critic segment and url noise', () => {
  assert.equal(
    reviewIdentity('s', 'NYT:Ben Brantley:https://www.nytimes.com/a/b/?utm_source=x#top'),
    reviewIdentity('s', 'nyt:ben-brantley:http://nytimes.com/a/b'),
  );
  assert.equal(reviewIdentity('s', 'no-colons'), null);
  // a query string can BE the identity (WordPress ?p=): never merged
  assert.notEqual(reviewIdentity('s', 'o:c:https://blog.com/?p=1'), reviewIdentity('s', 'o:c:https://blog.com/?p=2'));
});

test('shouldEmitExcludedStage: terminal reasons only, tracked-window reviews only', () => {
  const now = new Date('2026-10-15T15:00:00Z');
  const recent = { url: 'https://x.com/r', outletId: 'x', firstSeenAt: '2026-10-15T01:00:00Z' };
  assert.equal(shouldEmitExcludedStage('skippedWrongShow', recent, now), true);
  assert.equal(shouldEmitExcludedStage('skippedRejectionReason', recent, now), true);
  // "not yet" reasons must keep paging a stalled real review
  for (const r of ['skippedNoScore', 'skippedProcessingError', 'heldPreOpeningCorroboration', 'skippedPrematurePreOpening', 'skippedSuspectedMisattribution', 'skippedOutletDomainUnvalidated']) {
    assert.equal(TERMINAL_EXCLUSION_REASONS.has(r), false, r);
    assert.equal(shouldEmitExcludedStage(r, recent, now), false, r);
  }
  // found in previews two weeks out: still inside the tracked window
  assert.equal(shouldEmitExcludedStage('skippedWrongShow', { url: 'https://x.com/r', outletId: 'x', firstSeenAt: '2026-10-01T00:00:00Z' }, now), true);
  // outside the 21-day tracked window, and url-less rows: nothing
  assert.equal(shouldEmitExcludedStage('skippedWrongShow', { url: 'https://x.com/r', outletId: 'x', firstSeenAt: '2026-09-01T00:00:00Z' }, now), false);
  assert.equal(shouldEmitExcludedStage('skippedWrongShow', { firstSeenAt: '2026-10-15T01:00:00Z' }, now), false);
  assert.equal(shouldEmitExcludedStage('skippedWrongShow', { url: 'https://x.com/r' }, now), false);
});

test('every terminal exclusion reason is a stat key rebuild-all-reviews actually logs', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/rebuild-all-reviews.js'), 'utf8');
  const logged = new Set([...src.matchAll(/logExclusion\("([A-Za-z]+)"/g)].map(m => m[1]));
  for (const r of [...TERMINAL_EXCLUSION_REASONS, ...TERMINAL_WHEN_ABANDONED_REASONS]) assert.ok(logged.has(r), `${r} is not a rebuild logExclusion key (renamed?)`);
});

test('createExcludedStageEmitter writes each excluded review once, across runs (log-volume guard)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-emit-'));
  const logFile = path.join(dir, 'stage.jsonl');
  const now = new Date('2026-10-15T15:00:00Z');
  const data = { url: 'https://x.com/r', outletId: 'o', firstSeenAt: '2026-10-15T01:00:00Z' };
  // a previous rebuild already wrote this review's line (different critic casing)
  fs.writeFileSync(logFile, JSON.stringify({ showId: 's', reviewKey: 'o:Old Name:https://www.x.com/r/', stage: 'excluded', at: now.toISOString() }) + '\n');
  const emitted = [];
  const emitA = createExcludedStageEmitter({ logFile, now, emit: (e) => emitted.push(e) });
  assert.equal(emitA('s', 'skippedWrongShow', data, 'o:new-name:https://x.com/r'), false, 'already in the log');
  const other = { url: 'https://x.com/other', outletId: 'o', firstSeenAt: data.firstSeenAt };
  assert.equal(emitA('s', 'skippedWrongShow', other, 'o:a:https://x.com/other'), true);
  assert.equal(emitA('s', 'skippedNonReview', other, 'o:a:https://x.com/other'), false, 'second call in the same run');
  assert.equal(emitA('s', 'skippedNoScore', { url: 'https://x.com/3', outletId: 'o', firstSeenAt: data.firstSeenAt }, 'o:a:https://x.com/3'), false, 'non-terminal reason');
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].metadata, { reason: 'skippedWrongShow' });
});

test('same-identity dedup and date-mismatch reasons are never terminal (would silence the KEPT review)', () => {
  for (const r of ['skippedDuplicateUrl', 'skippedDuplicateOf', 'skippedDuplicateText', 'skippedWithinShowDupe',
    'skippedFingerprintDedup', 'skippedUnknownCriticDedup', 'skippedPlaceholderBylineTwin', 'skippedSameArticleNamedTwin', 'skippedGluedBylineTwin',
    'skippedCircularDuplicateTiebreak', 'skippedDateMismatch', 'skippedLateDateMismatch']) {
    assert.equal(TERMINAL_EXCLUSION_REASONS.has(r), false, r);
  }
});

test('text-quality reasons are terminal only once discovery is abandoned', () => {
  const now = new Date('2026-10-15T15:00:00Z');
  const base = { url: 'https://timeout.com/listing', outletId: 'timeout', firstSeenAt: '2026-10-14T12:00:00Z' };
  assert.equal(shouldEmitExcludedStage('skippedScraperGarbage', base, now), false, 're-collect pending');
  assert.equal(shouldEmitExcludedStage('skippedShowNotMentioned', base, now), false);
  assert.equal(shouldEmitExcludedStage('skippedScraperGarbage', { ...base, fetchDiscoveryAbandoned: true }, now), true);
  assert.equal(shouldEmitExcludedStage('skippedWrongShow', { ...base, outletId: undefined }, now), false, 'no outletId: key would never match');
});

test('an exclusion stops counting once the review is re-collected after it', () => {
  const now = new Date('2026-10-15T15:07:00Z');
  const k = 'o:c:https://x.com/r';
  const entries = [
    makeEntry('s', k, 'review-first-seen', 300, now),
    makeEntry('s', k, 'excluded', 280, now),
    makeEntry('s', k, 'review-text-collected', 200, now), // flag cleared + re-fetched
  ];
  assert.equal(excludedReviewIdentities(entries).size, 0);
  assert.equal(evaluateSlaForReviews(entries, { now, activeShowIds: ['s'] }).pages.length, 1);
  // re-excluded by the next rebuild: silent again
  entries.push(makeEntry('s', k, 'excluded', 150, now));
  assert.equal(evaluateSlaForReviews(entries, { now, activeShowIds: ['s'] }).pages.length, 0);
});

test('reviewIdentity refuses a key with no critic segment', () => {
  assert.equal(reviewIdentity('s', 'nyt:https://x.com/a'), null);
});

test('resolveSlaScope: a --show filtered run never speaks for the night', () => {
  const payload = { generatedAt: 'x', shows: [], error: 'Show not found: typo' };
  assert.equal(resolveSlaScope(payload, { filtered: true }).known, false);
  assert.equal(resolveSlaScope({ generatedAt: 'x', shows: [{ show: { id: 'a' } }] }, { filtered: true }).known, false);
});

// --- BRO-5480: a show rebuild still holds back as not open does not page ---
test('reviews on a show rebuild is holding as not-yet-open do not page; they page again once the hold goes stale', () => {
  const now = new Date('2026-10-16T12:32:00Z');
  const show = 'dirty-dancing-the-classic-story-on-stage-west-end-2026';
  const entries = [
    makeEntry(show, 'whatsonstage:james-fitzgerald:https://www.whatsonstage.com/old-review/', 'review-first-seen', 690, now),
    { showId: show, reviewKey: null, stage: 'held', at: new Date(now - 20 * MS_MIN).toISOString(), metadata: { reason: 'skippedUpcomingShows' } },
  ];
  assert.equal(evaluateSlaForReviews(entries, { now, activeShowIds: [show] }).pages.length, 0, 'fresh hold: not stuck');
  const later = new Date(now.getTime() + 3 * 60 * MS_MIN); // show opened, no held line for 3h
  assert.equal(evaluateSlaForReviews(entries, { now: later, activeShowIds: [show] }).pages.length, 1, 'stale hold: back in flight');
  // a hold from BEFORE the review was first seen says nothing about it
  const early = [entries[0], { ...entries[1], at: new Date(now - 700 * MS_MIN).toISOString() }];
  assert.equal(evaluateSlaForReviews(early, { now, activeShowIds: [show] }).pages.length, 1);
});

test('isBeforeOpeningDate: held only strictly before the opening date', () => {
  const { isBeforeOpeningDate } = require('../../scripts/lib/stage-latency.js');
  const now = new Date('2026-10-16T05:00:00Z');
  assert.equal(isBeforeOpeningDate('2026-10-17', now), true);
  assert.equal(isBeforeOpeningDate('2026-10-16', now), false, 'opening day: reviews are due');
  assert.equal(isBeforeOpeningDate(undefined, now), false);
  assert.equal(isBeforeOpeningDate('TBA', now), false);
});

test('isHeldBeforeOpening: upcoming with no date is held; previews with no date is not', () => {
  const { isHeldBeforeOpening } = require('../../scripts/lib/stage-latency.js');
  const now = new Date('2026-10-16T05:00:00Z');
  assert.equal(isHeldBeforeOpening('skippedUpcomingShows', null, now), true);
  assert.equal(isHeldBeforeOpening('skippedPreviewsShows', null, now), false);
  assert.equal(isHeldBeforeOpening('skippedPreviewsShows', '2026-10-16', now), false, 'opening day');
  assert.equal(isHeldBeforeOpening('skippedPreviewsShows', '2026-10-20', now), true);
});
