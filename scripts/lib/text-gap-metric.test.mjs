// scanCorpus / buildMetric on a throwaway corpus: sidecars and holding dirs are
// excluded and counted, failed-fetches rows are matched by reviewId or filePath,
// and the totals add up. Requires the real functions.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanCorpus, buildMetric, indexFailedFetches, INCOMPLETE_REASON_ENUM } = require('./text-gap-metric.js');

const NOW = Date.parse('2026-11-08T00:00:00Z');
const BODY = 'The company sings well and the second act moves quickly, though the book sags in places and the staging never quite earns its final image. '.repeat(14).trim();

function review(over = {}) {
  return { showId: 'show-a', outletId: 'guardian', url: 'https://example.com/a', contentTier: 'complete', fullText: BODY, fetchMethod: 'x', ...over };
}

function makeCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gapmetric-'));
  const w = (rel, obj) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  w('show-a/guardian--a.json', review());
  w('show-a/guardian--b.json', review({ contentTier: 'truncated', truncationSignals: ['no_ending_punctuation'], fullText: BODY + ' • At the Almeida, London, until 7 June' }));
  w('show-a/standard--c.json', review({ outletId: 'standard', contentTier: 'stub', fullText: '', incompleteReason: 'thestage-browser-recovery: No article body element found' }));
  w('show-a/standard--d.json', review({ outletId: 'standard', duplicateOf: 'x.json', contentTier: 'truncated' }));
  w('show-a/_blocklist.json', { urls: [] });
  w('show-b/timeout--e.json', review({ outletId: 'timeout', contentTier: 'stub', fullText: '', url: null }));
  w('__test-holding/guardian--z.json', review({ contentTier: 'truncated' }));
  w('failed-fetches.json', [
    { reviewId: 'show-a/standard--c.json', failureReason: 'url_dead_404', failureCount: 3 },
    { filePath: 'data/review-texts/show-b/timeout--e.json', failureReason: 'soft_404' },
  ]);
  return dir;
}

const shows = new Map([
  ['show-a', { id: 'show-a', openingDate: '2026-03-01' }],
  ['show-b', { id: 'show-b', openingDate: '2019-03-01' }],
]);

test('indexFailedFetches keys reviewId rows and filePath-only rows alike', () => {
  const m = indexFailedFetches([
    { reviewId: 'a/b.json', failureReason: 'x' },
    { filePath: 'data/review-texts/c/d.json', failureReason: 'y' },
    { failureReason: 'orphan' },
  ]);
  assert.deepEqual([...m.keys()].sort(), ['a/b.json', 'c/d.json']);
});

test('scan excludes sidecars and holding dirs, and counts the sidecars', () => {
  const dir = makeCorpus();
  const scan = scanCorpus({ dir, shows, nowMs: NOW });
  assert.equal(scan.excludedSidecars, 1);
  assert.equal(scan.filesRead, 5); // a, b, c, d, e (the __test- dir and failed-fetches.json are not review files)
  assert.ok(!scan.rows.some((r) => r.showId.startsWith('__test')));
});

test('metric totals and classes add up; polluted reasons and recency counted', () => {
  const dir = makeCorpus();
  const m = buildMetric(scanCorpus({ dir, shows, nowMs: NOW }).rows);
  assert.equal(m.files, 5);
  assert.equal(m.excluded, 1); // d is a duplicate
  assert.equal(m.complete, 1); // a
  assert.equal(m.open, 3);
  assert.equal(m.byClass.FALSE_TRUNCATION_SUSPECT, 1); // b
  assert.equal(m.byClass.URL_DEAD, 1); // c, matched by reviewId
  assert.equal(m.byClass.NO_URL, 1); // e (no URL wins over its soft_404 row, as classifyIncompleteReason orders it)
  assert.equal(m.openRecent, 2); // b, c are on show-a (2026); e is on show-b (2019)
  assert.equal(m.pollutedReasonCount, 1); // c carries free text
  assert.equal(m.open + m.excluded + m.complete + m.terminal, m.files);
  assert.equal(m.byOutlet.guardian.open, 1);
});

test('filters: outlet, show and recent-only', () => {
  const dir = makeCorpus();
  const onlyStandard = buildMetric(scanCorpus({ dir, shows, nowMs: NOW, outletFilter: new Set(['standard']) }).rows);
  assert.equal(onlyStandard.files, 2);
  const onlyB = scanCorpus({ dir, shows, nowMs: NOW, showFilter: 'show-b' });
  assert.equal(onlyB.filesRead, 1);
  const recent = buildMetric(scanCorpus({ dir, shows, nowMs: NOW }).rows, { recentOnly: true });
  assert.equal(recent.open, 2);
});

test('tierOf re-tiers before classifying (what a rebuild would store)', () => {
  const dir = makeCorpus();
  const retiered = scanCorpus({ dir, shows, nowMs: NOW, tierOf: (r) => (r.truncationSignals ? 'complete' : r.contentTier) });
  const m = buildMetric(retiered.rows);
  assert.equal(m.byClass.FALSE_TRUNCATION_SUSPECT || 0, 0);
  assert.equal(m.complete, 2);
});

test('an unknown-critic stub beside an included named critic at the same outlet is not a gap (the rebuild drops it)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gapmetric-unk-'));
  const w = (rel, obj) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj));
  };
  const stub = { url: null, contentTier: 'stub', fullText: '', criticName: 'Unknown' };
  // real shape: school-girls-...-2026/nytimes--unknown.json beside nytimes--helen-shaw.json
  w('show-a/nytimes--helen-shaw.json', review({ outletId: 'nytimes', criticName: 'Helen Shaw' }));
  w('show-a/nytimes--unknown.json', review({ outletId: 'nytimes', ...stub }));
  // no named sibling: still a gap
  w('show-a/variety--unknown.json', review({ outletId: 'variety', ...stub }));
  // named sibling is itself excluded (wrong show): the stub is what the rebuild keeps, still a gap
  w('show-a/vulture--sara-holdren.json', review({ outletId: 'vulture', criticName: 'Sara Holdren', wrongShow: true }));
  w('show-a/vulture--unknown.json', review({ outletId: 'vulture', ...stub }));
  const rows = scanCorpus({ dir, shows, nowMs: NOW }).rows;
  const by = Object.fromEntries(rows.map((r) => [r.file, r]));
  assert.equal(by['nytimes--unknown.json'].gapClass, 'EXCLUDED');
  assert.equal(by['nytimes--unknown.json'].subclass, 'unknown_stub_named_sibling');
  assert.equal(by['nytimes--unknown.json'].open, false);
  assert.equal(by['variety--unknown.json'].gapClass, 'NO_URL');
  assert.equal(by['vulture--sara-holdren.json'].gapClass, 'EXCLUDED');
  assert.equal(by['vulture--unknown.json'].gapClass, 'NO_URL');
});

test('the enum covers what classifyIncompleteReason can write', () => {
  for (const r of ['no_url', 'url_dead', 'scraper_garbage', 'paywall', 'url_content_mismatch', 'route_capped', 'scraper_timeout', 'code_error', 'bot_blocked', 'partial_text', 'not_attempted', 'unknown']) {
    assert.ok(INCOMPLETE_REASON_ENUM.includes(r), r);
  }
});
