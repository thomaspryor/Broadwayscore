/**
 * BRO-8056 phase 1b: with deps.registry and deps.now injected, computeOneShow
 * is a pure function of its arguments: no file read, no clock. Show-refresh
 * relies on this to render a show exactly like the build that shipped.
 * Own file (not compute-one-show.test.ts) so the fs trap runs before any
 * earlier test has warmed the registry cache.
 *
 * Run: npx tsx --test tests/unit/compute-one-show-pure.test.ts
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { computeOneShow, type ComputeOneShowDeps } from '../../src/lib/compute-one-show';
import { buildCoverageFloorInputs } from '../../scripts/lib/coverage-floor-inputs';
import { getMarketDate } from '../../src/lib/date-utils';
import type { RawShow, RawReview } from '../../src/lib/engine';

const mkShow = (category: string, o: Record<string, unknown> = {}) => ({
  id: `fixture-${category}`, title: 'Fixture', slug: `fixture-${category}`, venue: 'Fixture Theatre',
  openingDate: '2026-11-22', closingDate: null, status: 'previews', type: 'musical', category,
  images: { thumbnail: null, poster: null, hero: null }, ...o,
}) as unknown as RawShow;
const review = (show: RawShow, i: number, score: number, outletId: string): RawReview => ({
  showId: show.id, outletId, outlet: `Outlet ${i}`, criticName: `Critic ${i}`, url: `https://example.com/${show.id}/${i}`,
  publishDate: '2026-11-20', assignedScore: score, scoreSource: 'llm-ensemble', bucket: 'Positive', contentTier: 'complete',
} as unknown as RawReview);
const noCoverage = buildCoverageFloorInputs({ gapAudit: { results: [] }, stamps: {}, acks: [] }, {} as NodeJS.ProcessEnv);
const registry = { 'fixture-outlet-a': { tier: 1 }, 'fixture-outlet-b': { tier: 3 } };
const deps = (extra: Partial<ComputeOneShowDeps> = {}): ComputeOneShowDeps => ({
  blogReviews: [], audience: [], buzz: [], coverageFloorInputs: noCoverage,
  versionImage: <T extends string | null | undefined>(p: T) => p, registry, now: Date.parse('2026-11-22T12:00:00Z'), ...extra,
});

test('reads no file when registry and now are injected', () => {
  const show = mkShow('broadway');
  const reviews = [review(show, 1, 90, 'fixture-outlet-a'), review(show, 2, 50, 'fixture-outlet-b'), review(show, 3, 70, 'nytimes')];
  const trapped: string[] = [];
  const trap = (name: string) => mock.method(fs, name as 'readFileSync', (...args: unknown[]) => { trapped.push(`${name}(${String(args[0])})`); throw new Error('fs read in pure compute'); });
  const mocks = ['readFileSync', 'existsSync', 'statSync', 'readdirSync', 'openSync'].map(trap);
  try {
    const out = computeOneShow(show, reviews, deps());
    assert.ok(out.criticScore, 'fixture should score');
  } finally {
    mocks.forEach(m => m.mock.restore());
  }
  assert.deepEqual(trapped, []);
});

test('the injected registry decides tiers', () => {
  const show = mkShow('broadway');
  const reviews = [review(show, 1, 95, 'fixture-outlet-a'), review(show, 2, 40, 'fixture-outlet-b')];
  const a = computeOneShow(show, reviews, deps());
  const b = computeOneShow(show, reviews, deps({ registry: { 'fixture-outlet-a': { tier: 3 }, 'fixture-outlet-b': { tier: 1 } } }));
  assert.ok(a.criticScore && b.criticScore);
  assert.ok(a.criticScore.score > b.criticScore.score, `${a.criticScore.score} should beat ${b.criticScore.score}`);
});

test('computedAt comes from the injected clock', () => {
  const out = computeOneShow(mkShow('broadway'), [], deps({ now: Date.parse('2026-11-22T04:30:00Z') }));
  assert.equal(out.computedAt, '2026-11-22T04:30:00.000Z');
});

// G3: one injected instant, each market keeps its own local date. The overlay
// compute (now injected) must equal the build compute (real clock at that instant).
for (const iso of ['2026-11-22T00:30:00Z', '2026-11-22T04:30:00Z', '2026-11-22T23:30:00Z']) {
  for (const category of ['broadway', 'west-end']) {
    test(`overlay == build at ${iso} for ${category}`, () => {
      const at = Date.parse(iso);
      // Opens on the market-local date, so status flips exactly at local midnight.
      const show = mkShow(category, { openingDate: getMarketDate(category, at) });
      const reviews = [review(show, 1, 80, 'fixture-outlet-a')];
      const overlay = computeOneShow(show, reviews, deps({ now: at }));
      mock.timers.enable({ apis: ['Date'], now: at });
      let build;
      try {
        build = computeOneShow(show, reviews, deps({ now: undefined }));
      } finally {
        mock.timers.reset();
      }
      assert.deepEqual(overlay, build);
      assert.equal(overlay.status, 'open', 'opening date == market today => open');
    });
  }
}

test('getMarketDate splits New York and London from one instant', () => {
  const at = Date.parse('2026-11-22T02:00:00Z'); // 21:00 Nov 21 in New York, 02:00 Nov 22 in London
  assert.equal(getMarketDate('broadway', at), '2026-11-21');
  assert.equal(getMarketDate('west-end', at), '2026-11-22');
  assert.equal(getMarketDate('off-west-end', new Date(at)), '2026-11-22');
});
