// BRO-7051: opening-window mode of outlet-listing-poller. Requires the real filters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ow = require('../../scripts/lib/outlet-opening-window.js');
const poller = require('../../scripts/outlet-listing-poller.js');

const NOW = Date.parse('2026-11-06T15:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
const show = (id, category, daysAgo, extra = {}) => ({ id, category, openingDate: day(daysAgo), status: 'open', ...extra });

test('no in-window shows means no shows and no outlets (so no fetches)', () => {
  const shows = [show('old', 'broadway', 30), show('future', 'off-broadway', -5)];
  const w = ow.selectWindowShows(shows, NOW);
  assert.deepEqual(w, []);
  const r = ow.selectWindowOutlets({ windowShows: w, allShows: shows, allReviews: [], outletStrategyConfig: {}, wpApiConfig: {}, skipOutlets: new Set(), now: NOW });
  assert.deepEqual(r, { outlets: [], skippedSerp: [] });
});

test('window is 0..3 days past opening, status-independent', () => {
  const shows = [0, 1, 3, 4].map((d) => show('s' + d, 'off-broadway', d, { status: d === 1 ? 'previews' : 'open' }));
  assert.deepEqual(ow.selectWindowShows(shows, NOW).map((s) => s.id), ['s0', 's1', 's3']);
});

test('tours and regional shows are excluded', () => {
  const shows = [show('t', 'tour', 1), show('r', 'regional', 1), show('b', 'broadway', 1)];
  assert.deepEqual(ow.selectWindowShows(shows, NOW).map((s) => s.id), ['b']);
});

test('SERP-only outlets are skipped; free strategies are kept', () => {
  const osc = { a: { strategy: 'rss' }, b: { strategy: 'serp' }, c: { strategy: 'listing-html' }, d: { strategy: 'sitemap' } };
  const wp = { e: {} };
  assert.equal(ow.windowStrategyFor('a', osc, wp), 'rss');
  assert.equal(ow.windowStrategyFor('b', osc, wp), null);
  assert.equal(ow.windowStrategyFor('c', osc, wp), 'listing-html');
  assert.equal(ow.windowStrategyFor('d', osc, wp), 'sitemap');
  assert.equal(ow.windowStrategyFor('e', osc, wp), 'wp-api');
  assert.equal(ow.windowStrategyFor('zzz', osc, wp), null);
});

test('selectWindowOutlets filters by market and reports skipped SERP outlets', () => {
  const win = [show('ob1', 'off-broadway', 1)];
  const shows = [...win, show('ob2', 'off-broadway', 20), show('bw1', 'broadway', 20), show('bw2', 'broadway', 25)];
  const rev = (outletId, showId) => ({ outletId, showId });
  const reviews = [
    rev('obFeed', 'ob1'), rev('obFeed', 'ob2'),
    rev('bwFeed', 'bw1'), rev('bwFeed', 'bw2'),
    rev('obSerp', 'ob1'), rev('obSerp', 'ob2'),
  ];
  const osc = { obFeed: { strategy: 'rss' }, bwFeed: { strategy: 'rss' }, obSerp: { strategy: 'serp' } };
  const r = ow.selectWindowOutlets({ windowShows: win, allShows: shows, allReviews: reviews, outletStrategyConfig: osc, wpApiConfig: {}, skipOutlets: new Set(), now: NOW });
  assert.deepEqual(r.outlets, ['obFeed']);
  assert.deepEqual(r.skippedSerp, ['obSerp']);
});

test('paid budget caps attempts and counts refusals', () => {
  const b = ow.createPaidBudget(2);
  assert.deepEqual([b.attempt(), b.attempt(), b.attempt()], [true, true, false]);
  assert.equal(b.used, 2);
  assert.equal(b.refused, 1);
  assert.equal(ow.DEFAULT_MAX_PAID, 15);
});

test('projected monthly cost at the cap stays under the $10 target', () => {
  const p = ow.projectMonthlyCost({ paidPerRun: ow.DEFAULT_MAX_PAID, activeRunsPerMonth: 8 * 30 });
  assert.ok(p.usd < 10, `worst case ${p.usd}`);
});

test('poller config: New York Sun has a free entry and new OB feeds are registered', () => {
  const c = poller.OUTLET_STRATEGY_CONFIG;
  assert.equal(c['new-york-sun'].strategy, 'listing-html');
  for (const id of ['londonpubtheatres', 'fringereview', 'stagebuddy', 'the-knockturnal', 'lighting-and-sound-america']) {
    assert.ok(ow.windowStrategyFor(id, c, poller.WP_API_CONFIG || {}), id);
  }
});

test('needsCollection / showsNeedingCollection pick stubs without text, skip scored or flagged', () => {
  const stub = { url: 'https://x.com/a', contentTier: 'stub' };
  assert.equal(ow.needsCollection(stub), true);
  assert.equal(ow.needsCollection({ ...stub, fullText: 'abc' }), false);
  assert.equal(ow.needsCollection({ ...stub, assignedScore: 70 }), false);
  assert.equal(ow.needsCollection({ ...stub, wrongShow: true }), false);
  assert.equal(ow.needsCollection({ ...stub, duplicateOf: 'z' }), false);
  assert.equal(ow.needsCollection({ contentTier: 'stub' }), false);
  const win = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const by = { a: [stub], b: [stub, stub, { ...stub, fullText: 'x' }], c: [{ ...stub, assignedScore: 80 }], d: [stub] };
  assert.deepEqual(ow.showsNeedingCollection(win, by, 2), ['b', 'a']);
  assert.deepEqual(ow.showsNeedingCollection([], by), []);
});

test('retry bound: collector-skipped records and ledger-gated failures are not pending', () => {
  const stub = { reviewId: 'r1', url: 'https://x.com/a', contentTier: 'stub' };
  for (const bad of [{ fetchDiscoveryAbandoned: true }, { fabricatedEntry: true }, { incompleteReason: 'permanently_unavailable' }, { incompleteReason: 'multi_show_section_not_found' }]) {
    assert.equal(ow.needsCollection({ ...stub, ...bad }), false);
  }
  const gate = (show, r, entry) => ({ shouldRetry: entry.failureCount < 3 });
  const ledgerOf = (n) => ({ r1: { reviewId: 'r1', failureCount: n } });
  const win = [{ id: 'a' }];
  assert.deepEqual(ow.showsNeedingCollection(win, { a: [stub] }, 3, { ledger: ledgerOf(1), shouldRetryFetch: gate }), ['a']);
  assert.deepEqual(ow.showsNeedingCollection(win, { a: [stub] }, 3, { ledger: ledgerOf(3), shouldRetryFetch: gate }), []);
  assert.deepEqual(ow.showsNeedingCollection(win, { a: [stub] }, 3, { ledger: {}, shouldRetryFetch: gate }), ['a']);
});

// Review finding: review files carry no reviewId; the collector keys the ledger by "<showId>/<file>".
test('window-shows-needing-collection CLI honors the ledger with the real "<show>/<file>" key', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-cli-'));
  const open = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(root, 'shows.json'), JSON.stringify([
    { id: 'dead-show', category: 'off-broadway', openingDate: open },
    { id: 'fresh-show', category: 'off-broadway', openingDate: open },
  ]));
  for (const id of ['dead-show', 'fresh-show']) {
    fs.mkdirSync(path.join(root, 'review-texts', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'review-texts', id, 'outlet--critic.json'), JSON.stringify({ showId: id, url: 'https://example.com/a' }));
  }
  const recent = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'review-texts', 'failed-fetches.json'), JSON.stringify([
    { reviewId: 'dead-show/outlet--critic.json', showId: 'dead-show', url: 'https://example.com/a', failureReason: 'http_404', failureCount: 9, lastFailedAt: recent, firstFailedAt: recent },
  ]));
  const out = execFileSync('node', ['scripts/window-shows-needing-collection.js'], { env: { ...process.env, WINDOW_DATA_ROOT: root } }).toString().trim();
  assert.equal(out, 'fresh-show');
});

test('window runs do not bump the feed fail streak (daily-run threshold)', () => {
  const previous = { outlets: { nytg: { failStreak: 1, error: 'x' } } };
  const hm = { nytg: { error: 'boom' } };
  const win = poller.buildFeedHealthReport(hm, [], { previous, partial: true, holdStreak: true });
  assert.equal(win.outlets.nytg.failStreak, 1);
  const daily = poller.buildFeedHealthReport(hm, [], { previous, partial: true });
  assert.equal(daily.outlets.nytg.failStreak, 2);
});
