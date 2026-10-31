// BRO-4989: dated cost anchors (costHistory) and u/Boring_Waltz_9545's series.
// Tests the real modules via require() (CLAUDE.md §15).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  addAnchors, anchorErrors, anchorKey, dateFromText, legacyCostAnchor, sourceTypeForMethodology, historyWithSeeds,
} = require('../../scripts/lib/cost-history');
const {
  waltzAnchor, appendWaltzAnchors, waltzJumpFlags, shouldAlertNoAnchors, castEventsFor,
} = require('../../scripts/lib/waltz-cost-history');
const { hasCostAnchor } = require('../../scripts/lib/cost-for-week');

const post = (id, date, title = 'Grosses Analysis') => ({
  id, title, created_utc: Date.parse(date + 'T15:00:00Z') / 1000, permalink: `/r/Broadway/comments/${id}/x/`,
});

describe('costHistory anchors', () => {
  it('keeps several dated figures for one show and sorts them', () => {
    const a = waltzAnchor(post('p2', '2026-02-02'), 900_000);
    const b = waltzAnchor(post('p1', '2026-01-26'), 850_000);
    const c = waltzAnchor(post('p3', '2026-02-09'), 910_000);
    const { history, added } = addAnchors([], [a, b, c]);
    assert.strictEqual(added.length, 3);
    assert.deepStrictEqual(history.map((x) => x.asOf), ['2026-01-26', '2026-02-02', '2026-02-09']);
  });

  it('dedupes by post id, so a re-run or a backfill never doubles an anchor', () => {
    const shows = { wicked: { costHistory: [] } };
    const items = [
      { slug: 'wicked', anchor: waltzAnchor(post('p1', '2026-01-26'), 850_000) },
      { slug: 'wicked', anchor: waltzAnchor(post('p2', '2026-02-02'), 900_000) },
    ];
    const first = appendWaltzAnchors(shows, items, { apply: true });
    assert.strictEqual(first.added, 2);
    const again = appendWaltzAnchors(shows, items, { apply: true });
    assert.strictEqual(again.added, 0);
    assert.strictEqual(again.duplicates, 2);
    assert.strictEqual(shows.wicked.costHistory.length, 2, 'both dated figures survive');
  });

  it('BRO-5604: a trade-anchored record keeps hasCostAnchor after its first Waltz anchor', () => {
    const record = {
      weeklyRunningCost: 900_000,
      costMethodology: 'trade-reported',
      weeklyRunningCostSource: 'Variety, 2025-01-15',
      sources: [{ type: 'trade', url: 'https://variety.com/x', date: '2025-01-15' }],
    };
    const show = { slug: 'x-show', openingDate: '2025-02-01' };
    assert.strictEqual(hasCostAnchor(record, show), true, 'precondition: reported cost counts');
    const res = appendWaltzAnchors({ 'x-show': record }, [{ slug: 'x-show', anchor: waltzAnchor(post('p1', '2025-03-03'), 910_000) }],
      { apply: true, showsBySlug: { 'x-show': show } });
    assert.strictEqual(res.added, 1);
    assert.ok(record.costHistory.length >= 2, 'legacy anchor kept alongside the Reddit one');
    assert.strictEqual(hasCostAnchor(record, show), true, 'dated costs must stay on');
  });

  it('does not touch records in dry-run and reports shows with no record', () => {
    const shows = { six: {} };
    const res = appendWaltzAnchors(shows, [
      { slug: 'six', anchor: waltzAnchor(post('p1', '2026-01-26'), 500_000) },
      { slug: 'nope', anchor: waltzAnchor(post('p1', '2026-01-26'), 500_000) },
    ]);
    assert.strictEqual(res.added, 1);
    assert.deepStrictEqual(res.noRecord, ['nope']);
    assert.strictEqual(shows.six.costHistory, undefined);
  });

  it('refuses malformed anchors with reasons', () => {
    assert.ok(anchorErrors({ asOf: '2026-1-1', amount: 5, kind: 'x', sourceType: 'blog' }).length >= 4);
    assert.ok(anchorErrors({ asOf: '2026-01-01', amount: 800_000, kind: 'running-cost', sourceType: 'trade' })
      .some((e) => /sourceUrl/.test(e)), 'a trade anchor needs its URL');
    assert.deepStrictEqual(anchorErrors({ asOf: '2026-01-01', amount: 800_000, kind: 'running-cost', sourceType: 'industry-estimate' }), []);
    const { refused } = addAnchors([], [{ asOf: 'soon', amount: 1, kind: 'running-cost', sourceType: 'trade' }]);
    assert.strictEqual(refused.length, 1);
  });

  it('keys non-Reddit anchors by kind, date, amount and source', () => {
    const k = anchorKey({ asOf: '2008-05-01', amount: 800000, kind: 'running-cost', sourceUrl: 'https://x.test/a' });
    assert.strictEqual(k, 'running-cost|2008-05-01|800000|https://x.test/a');
  });
});

describe('migrating today\'s single weeklyRunningCost', () => {
  it('dates a trade figure from the date written in its source', () => {
    const a = legacyCostAnchor({
      weeklyRunningCost: 1_000_000, costMethodology: 'trade-reported',
      weeklyRunningCostSource: 'Broadway Journal (Dec 16, 2025): weekly operating expenses exceeding $1 million',
      sources: [{ type: 'trade', url: 'https://broadwayjournal.com/x', date: '2023-04-18' }],
    }, { openingDate: '2018-04-22' });
    assert.strictEqual(a.asOf, '2025-12-16');
    assert.strictEqual(a.sourceType, 'trade');
    assert.strictEqual(a.dateFrom, 'source-text');
    assert.strictEqual(a.sourceUrl, 'https://broadwayjournal.com/x');
  });

  it('gives our own estimate the 2025 calibration year, capped at a closed show\'s closing', () => {
    const open = legacyCostAnchor({ weeklyRunningCost: 250_000, costMethodology: 'industry-estimate' }, { openingDate: '1996-11-14' });
    assert.strictEqual(open.asOf, '2025-07-01');
    const closed = legacyCostAnchor({ weeklyRunningCost: 600_000 }, { openingDate: '2010-01-01', closingDate: '2012-06-30' });
    assert.strictEqual(closed.asOf, '2012-06-30');
    assert.strictEqual(closed.sourceType, 'industry-estimate', 'an unnamed method is never a reported tier');
  });

  it('dates an undated figure by firstAdded before lastUpdated, which moves on every edit (BRO-5005)', () => {
    const src = 'Variety: weekly running costs of about $700,000'; // cited, but no date in it
    const r = { weeklyRunningCost: 700_000, costMethodology: 'trade-reported', weeklyRunningCostSource: src, firstAdded: '2025-03-02T10:00:00Z', lastUpdated: '2026-10-10T12:00:00Z' };
    const a = legacyCostAnchor(r, { openingDate: '2024-01-01' });
    assert.strictEqual(a.asOf, '2025-03-02');
    assert.strictEqual(a.dateFrom, 'record-added');
    const b = legacyCostAnchor({ weeklyRunningCost: 700_000, costMethodology: 'trade-reported', weeklyRunningCostSource: src, lastUpdated: '2026-01-05' }, { openingDate: '2024-01-01' });
    assert.strictEqual(b.asOf, '2026-01-05');
    assert.strictEqual(b.dateFrom, 'record-updated');
  });

  it('returns null with no figure', () => {
    assert.strictEqual(legacyCostAnchor({ weeklyRunningCost: null }), null);
  });

  it('maps methodologies to source tiers', () => {
    assert.strictEqual(sourceTypeForMethodology('sec-filing'), 'sec');
    assert.strictEqual(sourceTypeForMethodology('deep-research'), 'industry-estimate');
    assert.strictEqual(sourceTypeForMethodology(undefined), 'industry-estimate');
  });

  it('reads dates written several ways', () => {
    assert.strictEqual(dateFromText('Variety, March 2008'), '2008-03-15');
    assert.strictEqual(dateFromText('per 2019-06-02 filing'), '2019-06-02');
    assert.strictEqual(dateFromText('no date here'), null);
  });
});

describe('his week-over-week jumps', () => {
  const series = [
    waltzAnchor(post('a', '2026-01-05'), 800_000),
    waltzAnchor(post('b', '2026-01-12'), 820_000),
    waltzAnchor(post('c', '2026-01-19'), 1_000_000), // +22% in one week
    waltzAnchor(post('d', '2026-03-30'), 600_000), // far apart: not a single-week jump
  ];

  it('flags a single-week move over 15% with no reason', () => {
    const flags = waltzJumpFlags(series);
    assert.strictEqual(flags.length, 1);
    assert.strictEqual(flags[0].to, '2026-01-19');
    assert.strictEqual(flags[0].reason, null);
  });

  it('explains it by a nearby cast change', () => {
    const flags = waltzJumpFlags(series, [{ name: 'A Star', role: 'Lead', since: '2026-01-15' }]);
    assert.match(flags[0].reason, /cast change/);
  });

  it('reads cast events from cast-changes.json shape', () => {
    const ev = castEventsFor({ shows: { x: { currentCast: [{ name: 'n', role: 'r', since: '2026-01-01' }, { name: 'q' }] } } }, 'x');
    assert.strictEqual(ev.length, 1);
  });
});

describe('weekly no-anchor alert', () => {
  it('alerts only when he posted and nothing landed or was already stored', () => {
    assert.strictEqual(shouldAlertNoAnchors({ relevantPostsInWindow: 1, added: 0, duplicates: 0 }), true);
    assert.strictEqual(shouldAlertNoAnchors({ relevantPostsInWindow: 1, added: 3, duplicates: 0 }), false);
    assert.strictEqual(shouldAlertNoAnchors({ relevantPostsInWindow: 1, added: 0, duplicates: 4 }), false);
    assert.strictEqual(shouldAlertNoAnchors({ relevantPostsInWindow: 0, added: 0, duplicates: 0 }), false);
  });
});

describe('weekly cost checks', () => {
  const { checkCostAnchors, refreshOrder, isDatedReport, recentlyResearched } = require('../../scripts/lib/cost-anchor-checks');
  const NOW = Date.parse('2026-10-01');
  const open = { openingDate: '2015-08-06' };
  const report = (asOf) => ({ asOf, amount: 900_000, kind: 'running-cost', sourceType: 'trade', sourceUrl: 'https://x.test/' + asOf });

  it('queues an open show whose newest reported figure is over 3 years old', () => {
    const r = checkCostAnchors({ slug: 'h', record: {}, show: open, history: [report('2017-01-31')], currentCost: 900_000, category: 'musical', now: NOW });
    assert.ok(r.stale && r.stale.ageYears > 9);
    const fresh = checkCostAnchors({ slug: 'f', record: {}, show: open, history: [report('2025-06-01')], currentCost: 900_000, category: 'musical', now: NOW });
    assert.strictEqual(fresh.stale, null);
  });

  it('does not count our own estimate or an assumed date as a report', () => {
    assert.strictEqual(isDatedReport({ ...report('2025-07-01'), sourceType: 'industry-estimate' }), false);
    assert.strictEqual(isDatedReport({ ...report('2025-07-01'), dateBasis: 'migrated', dateFrom: 'record-updated' }), false);
    assert.strictEqual(isDatedReport({ ...report('2025-12-16'), dateBasis: 'migrated', dateFrom: 'source-text' }), true);
  });

  it('flags a union musical under $350K a week, not a play', () => {
    assert.ok(checkCostAnchors({ slug: 'c', record: {}, show: open, history: [report('2025-06-01')], currentCost: 260_000, category: 'musical', now: NOW }).floor);
    assert.strictEqual(checkCostAnchors({ slug: 'p', record: {}, show: open, history: [report('2025-06-01')], currentCost: 260_000, category: 'play', now: NOW }).floor, null);
  });

  it('requires a source tier and orders refreshes no-report first, then oldest', () => {
    const r = checkCostAnchors({ slug: 't', record: { weeklyRunningCost: 500_000 }, show: { openingDate: '2010-01-01', closingDate: '2012-01-01' }, history: [], now: NOW });
    assert.strictEqual(r.tier.length, 1);
    const order = refreshOrder([
      { slug: 'a', stale: { ageYears: 4 } }, { slug: 'b', stale: { ageYears: null } }, { slug: 'c', stale: null }, { slug: 'd', stale: { ageYears: 9 } },
    ]).map((x) => x.slug);
    assert.deepStrictEqual(order, ['b', 'd', 'a']);
  });

  it('skips a show researched in the last 180 days (no weekly re-queue loop)', () => {
    assert.strictEqual(recentlyResearched({ deepResearch: { verifiedDate: '2026-08-01' } }, NOW), true);
    assert.strictEqual(recentlyResearched({ deepResearch: { verifiedDate: '2026-02-03' } }, NOW), false);
    assert.strictEqual(recentlyResearched({}, NOW), false);
    assert.strictEqual(recentlyResearched({ deepResearch: { verifiedDate: 'unknown' } }, NOW), false);
    // the queue worker's own field (deep-research-commercial.js)
    assert.strictEqual(recentlyResearched({ lastResearchedAt: '2026-09-20T10:00:00Z', deepResearch: { verifiedDate: '2026-02-03' } }, NOW), true);
    assert.strictEqual(recentlyResearched({ lastResearchedAt: null, researchAttempts: 0 }, NOW), false);
  });
});

describe('one report counts once (BRO-5632)', () => {
  // Water for Elephants: the legacy field holds Broadway Journal's $960K as a
  // running cost; the researched seed holds the same report as a break-even.
  const record = {
    weeklyRunningCost: 960000, costMethodology: 'trade-reported',
    weeklyRunningCostSource: 'Broadway Journal (Nov 6, 2023): "it will need to sell at least $960,000 of tickets each week"',
    sources: [{ type: 'trade', url: 'https://www.broadwayjournal.com/p/inside-broadways-1-million-nut-cases', date: '2023-11-06' }],
  };
  const show = { openingDate: '2024-03-21', closingDate: '2024-12-08' };
  const seed = { asOf: '2024-03-21', amount: 960000, kind: 'break-even', sourceType: 'trade', sourceUrl: 'https://www.broadwayjournal.com/p/inside-broadways-1-million-nut-cases' };

  it('drops the legacy copy when a seed repeats its figure under another kind', () => {
    const h = historyWithSeeds(record, show, [seed]);
    assert.deepStrictEqual(h.map((a) => a.kind), ['break-even']);
  });

  it('keeps a reported legacy figure when only an estimate seed repeats it', () => {
    const estimate = { ...seed, kind: 'running-cost', sourceType: 'industry-estimate' };
    const h = historyWithSeeds(record, show, [estimate]);
    assert.ok(h.some((a) => a.dateBasis === 'migrated' && a.sourceType === 'trade'), JSON.stringify(h));
  });

  it('keeps the legacy figure when only a Reddit figure repeats it', () => {
    const his = { asOf: '2024-04-02', amount: 960000, kind: 'running-cost', sourceType: 'reddit-standard', sourceUrl: 'https://www.reddit.com/comments/x', postId: 'x' };
    const h = historyWithSeeds(record, show, [his]);
    assert.ok(h.some((a) => a.dateBasis === 'migrated'), JSON.stringify(h));
  });
});

describe('an uncited "reported" cost is our estimate (BRO-5632)', () => {
  it('reads as industry-estimate without a publishable source, as reported with one', () => {
    const uncited = legacyCostAnchor({ weeklyRunningCost: 600_000, costMethodology: 'trade-reported' }, { openingDate: '2025-04-27' });
    assert.strictEqual(uncited.sourceType, 'industry-estimate');
    const cited = legacyCostAnchor({ weeklyRunningCost: 480_577, costMethodology: 'trade-reported', weeklyRunningCostSource: 'Forbes (Nov 17, 2025): fixed weekly operating costs of $480,577' }, { openingDate: '2025-11-20' });
    assert.strictEqual(cited.sourceType, 'trade');
  });

  it('vague attribution, an SEC or a producer label without a citation all read as estimates', () => {
    const show = { openingDate: '2023-03-16' };
    for (const costMethodology of ['trade-reported', 'sec-filing', 'producer-confirmed']) {
      const vague = legacyCostAnchor({ weeklyRunningCost: 659_000, costMethodology, weeklyRunningCostSource: 'Industry sources' }, show);
      assert.strictEqual(vague.sourceType, 'industry-estimate', costMethodology);
    }
    const sec = legacyCostAnchor({ weeklyRunningCost: 800_000, costMethodology: 'sec-filing', weeklyRunningCostSource: 'SEC Form D offering memorandum (2019): weekly running costs of $800,000' }, show);
    assert.strictEqual(sec.sourceType, 'sec');
  });

  it("a cited floor flagged as approximate keeps its reporter's tier (the-great-gatsby)", () => {
    const r = { weeklyRunningCost: 900_000, costMethodology: 'producer-confirmed', isEstimate: { weeklyRunningCost: true },
      weeklyRunningCostSource: "Gordon Cox interview with producer Chunsoo Shin (June 4, 2024): 'weekly running costs ringing in at more than $900,000 per week'" };
    assert.strictEqual(legacyCostAnchor(r, { openingDate: '2024-04-25' }).sourceType, 'producer-confirmed');
  });

  it('a stored copy whose figure was later edited keeps its stored tier', () => {
    const migrated = { asOf: '2025-06-29', amount: 600_000, kind: 'running-cost', sourceType: 'trade', dateBasis: 'migrated', note: 'migrated from weeklyRunningCost (trade-reported)' };
    const record = { weeklyRunningCost: 640_000, costMethodology: 'trade-reported', costHistory: [migrated] };
    assert.strictEqual(hasCostAnchor(record), true);
  });

  it('a stored migrated copy follows the record: uncited means no reported anchor', () => {
    const migrated = { asOf: '2025-06-29', amount: 600_000, kind: 'running-cost', sourceType: 'trade', dateBasis: 'migrated', note: 'migrated from weeklyRunningCost (trade-reported)' };
    const record = { weeklyRunningCost: 600_000, costMethodology: 'trade-reported', costHistory: [migrated] };
    assert.strictEqual(hasCostAnchor(record), false);
    assert.strictEqual(hasCostAnchor({ ...record, weeklyRunningCostSource: 'The New York Times (June 2025): about $600,000 a week' }), true);
  });
});
