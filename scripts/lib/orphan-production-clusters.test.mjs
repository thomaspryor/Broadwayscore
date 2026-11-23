import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('./orphan-production-clusters.js');

const now = Date.parse('2026-11-20');
const cutoffMs = Date.parse('2024-11-20');
const show = (o) => ({ id: 'x', title: 'Good Night, Oscar', ...o });
const old = show({ id: 'good-night-oscar-2023', previewsStartDate: '2023-04-07', openingDate: '2023-04-24', closingDate: '2023-08-27' });
const ctxFor = (shows) => ({ byTitle: L.indexShows(shows), cutoffMs, now });
const rv = (d, extra = {}) => ({ wrongProduction: true, publishDate: d, outletId: 'guardian', ...extra });

test('review dated outside every same-title window is an orphan; inside a window it is covered', () => {
  assert.ok(L.orphanCandidate(rv('2025-08-08'), old, ctxFor([old])));
  const barbican = show({ id: 'god-2025', previewsStartDate: '2025-07-26', openingDate: '2025-08-06', closingDate: '2025-10-04' });
  assert.equal(L.orphanCandidate(rv('2025-08-08'), old, ctxFor([old, barbican])), null);
});
test('non-flagged, cross-market-noted, too-old and wrongShow reviews are not orphans', () => {
  const c = ctxFor([old]);
  assert.equal(L.orphanCandidate({ publishDate: '2025-08-08' }, old, c), null);
  assert.equal(L.orphanCandidate(rv('2025-08-08', { wrongProductionNote: 'Cross-market review' }), old, c), null);
  assert.equal(L.orphanCandidate(rv('2023-08-08'), old, c), null);
  assert.equal(L.orphanCandidate(rv('2025-08-08', { wrongShow: true }), old, c), null);
});
test('clusters split on date gap, group by title+market, count duplicates across hosts', () => {
  const mk = (hostId, d, market = 'west-end') => ({ hostId, title: 'Cat on a Hot Tin Roof', file: 'f', ms: Date.parse(d), outletId: 'o', market });
  const cl = L.clusterOrphans([mk('h1', '2024-12-17'), mk('h2', '2024-12-18'), mk('h1', '2026-05-01'), mk('h3', '2024-12-19', 'broadway')]);
  assert.equal(cl.length, 3);
  assert.equal(cl[0].count, 2);
  assert.deepEqual(Object.keys(cl[0].hosts).sort(), ['h1', 'h2']);
});
test('proposeEntry carries estimate and validation requirement', () => {
  const [c] = L.clusterOrphans([{ hostId: 'h', title: 'Good Night, Oscar', file: 'f', ms: Date.parse('2025-08-07'), outletId: 'o', market: 'west-end' }]);
  const p = L.proposeEntry(c);
  assert.equal(p.proposedId, 'good-night-oscar-west-end-2025');
  assert.match(p.needsValidation, /validate-show-venue/);
});

test('proposed ids follow the shows.json slug rule (apostrophes dropped, & -> and)', () => {
  const c = (title) => ({ title, titleKey: L.normTitle(title), market: 'west-end', firstMs: Date.parse('2026-02-25'), lastMs: Date.parse('2026-06-23'), count: 7, hosts: {} });
  assert.equal(L.proposeEntry(c('Who’s Afraid of Virginia Woolf?')).proposedId, 'whos-afraid-of-virginia-woolf-west-end-2026');
  assert.equal(L.proposeEntry(c('Marie & Rosetta')).proposedId, 'marie-and-rosetta-west-end-2026');
});

test('a proposed id never reuses an existing show id (second same-year production takes -2)', () => {
  const c = { title: 'Who’s Afraid of Virginia Woolf?', titleKey: 'x', market: 'west-end', firstMs: Date.parse('2026-02-25'), lastMs: Date.parse('2026-06-23'), count: 7, hosts: {} };
  assert.equal(L.proposeEntry(c, new Set(['whos-afraid-of-virginia-woolf-west-end-2026'])).proposedId, 'whos-afraid-of-virginia-woolf-west-end-2026-2');
  assert.equal(L.proposeEntry(c, new Set(['whos-afraid-of-virginia-woolf-west-end-2026', 'whos-afraid-of-virginia-woolf-west-end-2026-2'])).proposedId, 'whos-afraid-of-virginia-woolf-west-end-2026-3');
});

test('urlKey folds www, query, hash, trailing slash and case so duplicate copies match (BRO-7959)', () => {
  const a = L.urlKey('https://www.NYTimes.com/2025/04/24/theater/pirates.html?smid=x#top');
  assert.equal(a, L.urlKey('http://nytimes.com/2025/04/24/theater/pirates.html'));
  assert.equal(L.urlKey('https://a.com/x/'), L.urlKey('https://a.com/x'));
  assert.notEqual(L.urlKey('https://a.com/x'), L.urlKey('https://a.com/y'));
});

test('urlKey keeps identifying query params but drops tracking ones; titlesCompatible is prefix-based (BRO-7959)', () => {
  assert.notEqual(L.urlKey('https://a.com/r.php?id=1'), L.urlKey('https://a.com/r.php?id=2'));
  assert.equal(L.urlKey('https://a.com/r?id=1&utm_source=x'), L.urlKey('https://a.com/r?id=1'));
  assert.ok(L.titlesCompatible('imeverywoman', 'imeverywomanthechakakhanmusical'));
  assert.ok(!L.titlesCompatible('seagull', 'threesisters'));
});

// BRO-8093 class guard: the gate decision end to end (findOrphans -> clusterOrphans -> gateKeyTotals -> gateFailures).
// Reverting a rehome (production not in shows.json, reviews parked flagged on the old same-title show) must turn the gate red.
test('gate: a missing production fails, adding it + rehoming passes, and the revert view fails again', () => {
  const nowG = Date.parse('2026-11-20');
  const host = { id: 'good-night-oscar-2023', title: 'Good Night, Oscar', previewsStartDate: '2023-04-07', openingDate: '2023-04-24', closingDate: '2023-08-27' };
  const added = { id: 'good-night-oscar-off-west-end-2025', title: 'Good Night, Oscar', previewsStartDate: '2025-07-26', openingDate: '2025-08-06', closingDate: '2025-10-04' };
  const outlets = { guardian: { region: 'london' } };
  const parked = [1, 2, 3, 4].map((n) => [host.id, `guardian--c${n}.json`, { wrongProduction: true, publishDate: `2025-08-0${n + 4}`, outletId: 'guardian', url: `https://x.co.uk/r${n}` }]);
  const runGate = (records, shows) => L.gateFailures(L.gateKeyTotals(L.clusterOrphans(L.findOrphans(records, shows, outlets, nowG)), 3), {});
  // before the fix: 4 parked reviews, no 2025 production -> red
  const red = runGate(parked, [host]);
  assert.equal(red.length, 1);
  assert.equal(red[0].key, 'goodnightoscar|west-end');
  assert.equal(red[0].count, 4);
  // after the fix: show added, reviews moved with reroutedFrom -> green
  const fixed = parked.map(([, f, j]) => [added.id, f, { ...j, wrongProduction: false, reroutedFrom: host.id }]);
  assert.deepEqual(runGate(fixed, [host, added]), []);
  // the show added but reviews still parked are covered by its window -> green too
  assert.deepEqual(runGate(parked, [host, added]), []);
  // revertRehome of the fixed state reproduces the red, without mutating its inputs
  const v = L.revertRehome(fixed, [host, added], new Set([added.id]), new Set([added.id]));
  assert.equal(runGate(v.records, v.shows).length, 1);
  assert.equal(fixed[0][2].wrongProduction, false);
  // a pre-existing rehome target kept in shows (--keep-shows) covers its own window -> no false red
  const k = L.revertRehome(fixed, [host, added], new Set(), new Set([added.id]));
  assert.deepEqual(runGate(k.records, k.shows), []);
});

test('revertRehome leaves non-orphan (different-title) reroutes in place and reports hosts missing from shows', () => {
  const target = { id: 'oscar-2025', title: 'Good Night, Oscar', openingDate: '2025-08-06' };
  const other = { id: 'cats-2016', title: 'Cats', openingDate: '2016-07-31' };
  const recs = [
    ['oscar-2025', 'a.json', { reroutedFrom: 'cats-2016' }],
    ['oscar-2025', 'b.json', { reroutedFrom: 'gone-2023' }],
  ];
  const v = L.revertRehome(recs, [target, other], new Set(), new Set(['oscar-2025']));
  assert.equal(v.records[0][0], 'oscar-2025');
  assert.equal(v.records[1][0], 'gone-2023');
  assert.deepEqual(v.missingHosts, ['oscar-2025/b.json -> gone-2023']);
});

test('gate: a flagged copy whose URL is live elsewhere is not counted; baseline ratchet allows equal, fails growth', () => {
  const nowG = Date.parse('2026-11-20');
  const host = { id: 'h-2010', title: 'When We Are Married', openingDate: '2010-01-01', closingDate: '2010-03-01' };
  const other = { id: 'h-other-2023', title: 'When We Are Married', openingDate: '2023-01-01', closingDate: '2023-02-01' };
  const recs = [0, 1, 2].map((n) => [host.id, `o--c${n}.json`, { wrongProduction: true, publishDate: '2025-06-10', outletId: 'o', url: `https://a.co.uk/${n}` }]);
  const live = recs.map(([, f, j]) => [other.id, `live-${f}`, { url: j.url, publishDate: '2023-01-10' }]);
  assert.equal(L.findOrphans([...recs, ...live], [host, other], {}, nowG).length, 0);
  const totals = L.gateKeyTotals(L.clusterOrphans(L.findOrphans(recs, [host, other], {}, nowG)), 3);
  assert.deepEqual(L.gateFailures(totals, { 'whenwearemarried|west-end': 3 }), []);
  assert.equal(L.gateFailures(totals, { 'whenwearemarried|west-end': 2 }).length, 1);
});
