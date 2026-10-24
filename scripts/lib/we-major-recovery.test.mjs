import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./we-major-recovery.js');

const show = (o = {}) => ({
  id: 's1', title: 'Hamlet', season: '2018-2019', discoverySource: 'we-historical:wos',
  venue: 'Old Vic Theatre', openingDate: '2018-10-10', closingDate: '2018-12-20', ...o,
});
const rev = (showId, outletId, score = 70) => ({ showId, outletId, assignedScore: score });

test('buildSlots: counts only scored reviews, maps mail-on-sunday to daily-mail', () => {
  const rows = lib.buildSlots(
    [show()],
    [rev('s1', 'guardian'), rev('s1', 'mail-on-sunday'), rev('s1', 'times-uk', null), rev('s1', 'express-uk')],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].counted, 3);
  assert.equal(rows[0].majorHeld, 2);
  assert.ok(!rows[0].missing.includes('guardian'));
  assert.ok(!rows[0].missing.includes('daily-mail'));
  assert.ok(rows[0].missing.includes('times'));
});

test('buildSlots: skips non-historical shows and seasons outside the range', () => {
  const rows = lib.buildSlots(
    [show(), show({ id: 'b', discoverySource: 'broadway' }), show({ id: 'c', season: '2022-2023' })], [],
  );
  assert.deepEqual(rows.map(r => r.id), ['s1']);
});

test('orderQueue: tier 1 first, then fewest counted reviews', () => {
  const rows = [
    { id: 'a', title: 'A', season: '2018-2019', counted: 9, missing: ['artsdesk', 'guardian'] },
    { id: 'b', title: 'B', season: '2018-2019', counted: 2, missing: ['guardian', 'stage'] },
  ];
  const q = lib.orderQueue(rows);
  assert.deepEqual(q.map(x => `${x.showId}:${x.slot}`), ['b:guardian', 'a:guardian', 'b:stage', 'a:artsdesk']);
  assert.deepEqual(lib.orderQueue(rows, { slots: new Set(['stage']) }).map(x => x.slot), ['stage']);
});

test('showWindow: UK trusted outlets get the longer pre-preview lead, open runs are capped', () => {
  const trusted = lib.showWindow(show(), 'guardian');
  const other = lib.showWindow(show(), 'artsdesk');
  assert.ok(trusted.start < other.start);
  assert.equal(trusted.end > '2018-12-20', true);
  const open = lib.showWindow(show({ closingDate: undefined }), 'guardian');
  assert.equal(open.end, lib.addDays('2018-10-10', 365));
  assert.equal(lib.showWindow({ id: 'x' }, 'guardian'), null);
});

test('matchWosPosts: title, date window and exact venue must agree', () => {
  const rows = [{ id: 's1', missing: ['whatsonstage'] }];
  const shows = [show()];
  const ok = { url: 'u1', date: '2018-10-11', title: 'Hamlet', venue: 'Old Vic Theatre' };
  assert.equal(lib.matchWosPosts(rows, shows, [ok]).length, 1);
  // substring venue (Bristol Old Vic) is another production
  assert.equal(lib.matchWosPosts(rows, shows, [{ ...ok, venue: 'Bristol Old Vic' }]).length, 0);
  assert.equal(lib.matchWosPosts(rows, shows, [{ ...ok, date: '2019-06-01' }]).length, 0);
  assert.equal(lib.matchWosPosts(rows, shows, [{ ...ok, title: 'Macbeth' }]).length, 0);
  // no venue: accepted only as the single hit
  const noVenue = { ...ok, venue: '' };
  assert.equal(lib.matchWosPosts(rows, shows, [noVenue]).length, 1);
  assert.equal(lib.matchWosPosts(rows, shows, [noVenue, { ...noVenue, url: 'u2' }]).length, 0);
  assert.equal(lib.matchWosPosts([{ id: 's1', missing: ['guardian'] }], shows, [ok]).length, 0);
});

test('ledgerUsd: scrapingdog at PAYG rate, bright data per request, unknown providers free', () => {
  const pricing = {
    scrapingdog: { usdPerUnit: 0.00009, paygUsdPerUnit: 0.0004 },
    scrapingbee: { usdPerUnit: 0.0001 },
    brightdata: { usdPerUnit: 0.0015 },
  };
  const { usd, byProvider } = lib.ledgerUsd([
    { provider: 'scrapingdog', credits: 5 },
    { provider: 'scrapingbee', credits: 10 },
    { provider: 'brightdata', fn: 'web-unlocker' },
    { provider: 'brightdata', fn: 'web-unlocker', success: false },
    { provider: 'brightdata', fn: 'something-else' },
    { provider: 'browserbase', credits: 99 },
  ], pricing);
  assert.ok(Math.abs(usd - (0.002 + 0.001 + 0.0015)) < 1e-9);
  assert.ok(byProvider.scrapingdog > 0);
});

test('CostTally: projects scoring, reserves, and stops before the cap', () => {
  const t = new lib.CostTally({ capUsd: 1, scoringUsdPerReview: 0.1, reserveUsd: 0.2 });
  t.setScraperUsd(0.3);
  t.recordWritten(3);
  assert.ok(Math.abs(t.projectedTotalUsd - 0.8) < 1e-9);
  assert.equal(t.wouldExceed(0.05), false);
  assert.equal(t.wouldExceed(0.2), true);
  assert.match(t.line(), /^COST TALLY scraper=\$0\.300 .*cap=\$1$/);
});

test('SERP domains are bare hosts the scraper host matcher accepts; observer is never searched', () => {
  const { domainMatchesExpected } = require('../lib/scraper.js');
  for (const m of lib.MAJOR) {
    if (m.serp === false) continue;
    assert.equal(domainMatchesExpected(m.domain, m.domain), true, m.slot);
    assert.ok(!m.domain.includes('/'), `${m.slot} domain must be a bare host`);
  }
  assert.equal(lib.BY_SLOT.get('observer').serp, false);
});

test('CostTally: prior campaign spend and files count against the cap', () => {
  const t = new lib.CostTally({ capUsd: 10, scoringUsdPerReview: 0.1, priorScraperUsd: 6, priorWritten: 20 });
  t.setScraperUsd(1);
  assert.ok(Math.abs(t.projectedTotalUsd - 9) < 1e-9);
  assert.equal(t.wouldExceed(0.95), true);
});

test('ledgerUsd: sinceIso ignores earlier rows', () => {
  const pricing = { scrapingdog: { usdPerUnit: 0.1 }, scrapingbee: { usdPerUnit: 0 }, brightdata: { usdPerUnit: 0 } };
  const rows = [{ provider: 'scrapingdog', credits: 1, ts: '2026-01-01T00:00:00Z' }, { provider: 'scrapingdog', credits: 1, ts: '2026-02-01T00:00:00Z' }];
  assert.ok(Math.abs(lib.ledgerUsd(rows, pricing, '2026-01-15T00:00:00Z').usd - 0.1) < 1e-9);
});
