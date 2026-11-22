/**
 * BRO-8056 phase 1a: computeOneShow is the single per-show compute that
 * getAllShows() maps over (and show-refresh will call with one show's slice).
 * Hand-made fixture data only, so this runs in test.yml's blocking batch.
 *
 * Run: npx tsx --test tests/unit/compute-one-show.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOneShow, type ComputeOneShowDeps } from '../../src/lib/compute-one-show';
import { buildCoverageFloorInputs } from '../../scripts/lib/coverage-floor-inputs';
import type { RawShow, RawReview } from '../../src/lib/engine';

const show = {
  id: 'fixture-show-2026', title: 'Fixture Show', slug: 'fixture-show', venue: 'Fixture Theatre',
  openingDate: '2026-11-01', closingDate: null, status: 'open', type: 'musical', category: 'broadway',
  images: { thumbnail: '/images/shows/fixture/thumb.webp', poster: '/images/shows/fixture/poster.webp', hero: null },
} as unknown as RawShow;

const review = (i: number, score: number, outletId = `outlet-${i}`): RawReview => ({
  showId: show.id, outletId, outlet: `Outlet ${i}`, criticName: `Critic ${i}`, url: `https://example.com/r${i}`,
  publishDate: '2026-11-02', assignedScore: score, scoreSource: 'llm-ensemble', bucket: 'Positive', contentTier: 'complete',
} as unknown as RawReview);

const critic = [review(1, 82, 'nytimes'), review(2, 74), review(3, 65)];
const blog = [review(9, 90, 'fixture-blog')];
const noCoverage = buildCoverageFloorInputs({ gapAudit: { shows: [] }, stamps: {}, acks: {} }, {} as NodeJS.ProcessEnv);
const deps = (extra: Partial<ComputeOneShowDeps> = {}): ComputeOneShowDeps => ({
  blogReviews: [], audience: [], buzz: [], coverageFloorInputs: noCoverage,
  versionImage: <T extends string | null | undefined>(p: T) => p, ...extra,
});
const strip = (o: unknown) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'computedAt' ? undefined : v)));

test('blog reviews score exactly as if appended after the critic reviews', () => {
  const split = computeOneShow(show, critic, deps({ blogReviews: blog }));
  const merged = computeOneShow(show, [...critic, ...blog], deps());
  assert.deepEqual(strip(split), strip(merged));
  assert.ok(split.criticScore, 'fixture should produce a critic score');
});

test('does not mutate its inputs', () => {
  const before = JSON.stringify({ show, critic, blog });
  computeOneShow(show, critic, deps({ blogReviews: blog }));
  assert.equal(JSON.stringify({ show, critic, blog }), before);
});

test('image paths go through the injected versionImage', () => {
  const out = computeOneShow(show, critic, deps({ versionImage: <T extends string | null | undefined>(p: T) => (typeof p === 'string' ? `${p}?v=1` : p) as T }));
  assert.equal(out.images?.thumbnail, '/images/shows/fixture/thumb.webp?v=1');
  assert.equal(out.images?.poster, '/images/shows/fixture/poster.webp?v=1');
});

test('coverage-hold ceiling uses the injected clock (72h after opening)', () => {
  const opened = Date.parse(show.openingDate);
  const early = computeOneShow(show, critic, deps({ now: opened + 3600 * 1000 }));
  const late = computeOneShow(show, critic, deps({ now: opened + 80 * 3600 * 1000 }));
  assert.notEqual(early.coverageAcked, true);
  assert.equal(late.coverageAcked, true);
});

test("rejects a review that belongs to another show (slice contract)", () => {
  const stray = { ...review(5, 70), showId: 'other-show-2026' } as RawReview;
  assert.throws(() => computeOneShow(show, [...critic, stray], deps()), /other-show-2026/);
  assert.throws(() => computeOneShow(show, critic, deps({ blogReviews: [stray] })), /other-show-2026/);
});
