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
