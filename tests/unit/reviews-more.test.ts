/**
 * BRO-8170 gap 3: ReviewsList never mixes reviews.json rows from another
 * revision with the five rows embedded in the page (src/lib/reviews-more.ts).
 *
 * Run: npx tsx --test tests/unit/reviews-more.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fetchMoreRows, sameRenderData, MORE_RETRY_DELAY_MS } from '../../src/lib/reviews-more';
import { SHOW_REFRESH_REV_HEADER, showRefreshConfigured, showRefreshEnabled } from '../../src/lib/show-refresh-core';

const H1 = '0123456789abcdef';
const H2 = 'fedcba9876543210';

function res(rows: unknown[], rev: string | null, status = 200) {
  return {
    ok: status < 400, status,
    headers: new Headers(rev == null ? {} : { [SHOW_REFRESH_REV_HEADER]: rev }),
    json: async () => rows,
  };
}

function fakeFetch(...answers: ReturnType<typeof res>[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = async (url: string, init?: RequestInit) => { calls.push({ url, init }); return answers[Math.min(calls.length - 1, answers.length - 1)]; };
  return { f, calls };
}
const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };

test('sameRenderData: build data matches build data; slice hashes must be equal', () => {
  assert.equal(sameRenderData('base', 'base-error'), true);
  assert.equal(sameRenderData('base-error', null), true);
  assert.equal(sameRenderData(H1, H1), true);
  assert.equal(sameRenderData(H1, 'base'), false);
  assert.equal(sameRenderData('base', H1), false);
  assert.equal(sameRenderData(H1, H2), false);
});

test('matching revision: rows used, one request', async () => {
  const { f, calls } = fakeFetch(res([{ a: 1 }], H1));
  assert.deepEqual(await fetchMoreRows('/show/x/reviews.json', H1, { fetch: f, sleep }), { state: 'ok', rows: [{ a: 1 }] });
  assert.equal(calls.length, 1);
});

test('stale reviews.json: retried once past the browser cache, then used when it matches', async () => {
  sleeps.length = 0;
  const { f, calls } = fakeFetch(res([{ old: 1 }], H2), res([{ fresh: 1 }], H1));
  assert.deepEqual(await fetchMoreRows('/show/x/reviews.json', H1, { fetch: f, sleep }), { state: 'ok', rows: [{ fresh: 1 }] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init?.cache, 'no-store');
  assert.deepEqual(sleeps, [MORE_RETRY_DELAY_MS]);
});

test('still another revision after the retry: mismatch, never ok; only the retry rows ride along for an explicit click', async () => {
  const { f } = fakeFetch(res([{ first: 1 }], 'base'), res([{ retry: 1 }], 'base'));
  assert.deepEqual(await fetchMoreRows('/show/x/reviews.json', H1, { fetch: f, sleep }), { state: 'mismatch', latestRows: [{ retry: 1 }] });
});

test('reader off (no expected rev): rows used as before, header ignored, no retry', async () => {
  const { f, calls } = fakeFetch(res([{ a: 1 }], H2));
  assert.deepEqual(await fetchMoreRows('/show/x/reviews.json', undefined, { fetch: f, sleep }), { state: 'ok', rows: [{ a: 1 }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init, undefined, 'same request as before the change');
});

test('HTTP error: error, not rows', async () => {
  const { f } = fakeFetch(res([], H1, 500));
  const r = await fetchMoreRows('/show/x/reviews.json', H1, { fetch: f, sleep });
  assert.equal(r.state, 'error');
});

test('wiring: reviews.json carries the marker only while the flag is set', () => {
  const route = fs.readFileSync(path.join(__dirname, '../../src/app/show/[slug]/reviews.json/route.ts'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '../../src/app/show/[slug]/page.tsx'), 'utf8');
  const list = fs.readFileSync(path.join(__dirname, '../../src/components/ReviewsList.tsx'), 'utf8');
  assert.match(route, /SHOW_REFRESH_REV_HEADER\]: render\?\.rev/);
  assert.match(route, /showRefreshConfigured\(\) \? \{ headers:/);
  assert.match(page, /showRefreshConfigured\(\) \? \{ other: \{ \[SHOW_REFRESH_REV_META\]/);
  assert.match(page, /rev: showRefreshConfigured\(\) \? render\.rev : undefined/);
  assert.match(list, /fetchMoreRows<ReviewListItem>\(url, rev\)/);
  assert.match(list, /!cancelled && d\.state === 'ok'\) setLoaded/, 'the idle prefetch merges only same-revision rows');
  assert.match(list, /d\.state === 'mismatch' \? d\.latestRows/, 'a click uses the newest rows rather than a dead button');
  assert.match(list, /ensureMore\(\)\.then\(ok => \{ if \(ok\) setIsExpanded\(true\)/, 'Show more expands only once the rows are in');
  // Owner 2026-11-26 (BRO-8176 option B): no "being updated" note on a mismatch.
  assert.doesNotMatch(list, /being updated/i, 'no mismatch note in ReviewsList');
});

test('class guard: reviews.json and the OG image key their markers on the flag as configured', () => {
  // showRefreshEnabled() is false during `next build`, so a marker gated on it is
  // missing from everything a flag-on build prerenders.
  const dir = path.join(__dirname, '../../src/app/show/[slug]');
  const files = ['page.tsx', 'reviews.json/route.ts', 'opengraph-image.tsx'].map(f => path.join(dir, f)).filter(f => fs.existsSync(f));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /showRefreshEnabled\(\)/, `${path.relative(dir, f)} gates on showRefreshEnabled(); use showRefreshConfigured()`);
  }
});

test('flag-on build: the reader does not run, but the page still passes its marker', () => {
  const build = { SHOW_REFRESH_READER: 'on', NEXT_PHASE: 'phase-production-build' } as unknown as NodeJS.ProcessEnv;
  assert.equal(showRefreshEnabled(build), false);
  assert.equal(showRefreshConfigured(build), true);
  assert.equal(showRefreshConfigured({} as unknown as NodeJS.ProcessEnv), false, 'flag off: no marker, nothing changes');
});
