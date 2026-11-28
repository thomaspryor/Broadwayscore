/**
 * BRO-6659: Sanity's API request quota ran out (plan_limit_reached) and every
 * production deploy failed at "Failed to collect page data for /blog/[slug]",
 * because the blog pages called client.fetch with no error handling and every
 * prerender repeated the same requests. Guards the REAL helpers: one request
 * per (query, params) per 5 minutes; during `next build` a Sanity error
 * resolves to the last-good fallback; at runtime it rethrows so ISR keeps the
 * last good page instead of caching a degraded one.
 *
 * Run: npx tsx --test src/sanity/__tests__/sanity-fetch.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ||= 'fp1ft8k8';
process.env.NEXT_PUBLIC_SANITY_DATASET ||= 'production';

const { client } = await import('../client.ts');
const { useCdn } = await import('../env.ts');
const { sanityFetch } = await import('../fetch.ts');
const { getAllBlogReviewsFromSanity, getBlogReviewBySlugFromSanity } = await import('../../lib/data-reviews-blog-sanity.ts');

const BUILD = 'phase-production-build';
function inPhase(t, phase) {
  const prev = process.env.NEXT_PHASE;
  if (phase) process.env.NEXT_PHASE = phase;
  else delete process.env.NEXT_PHASE;
  t.after(() => {
    if (prev === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = prev;
  });
}

function stubFetch(impl) {
  const calls = [];
  client.fetch = async (query, params) => {
    calls.push([query, params]);
    return impl(query, params);
  };
  return calls;
}

test('reads go to the API CDN (separate, larger quota than the direct API)', () => {
  assert.equal(useCdn, true);
});

test('identical queries hit Sanity once per process', async () => {
  const calls = stubFetch(() => ['a', 'b']);
  const q = '*[_type == "dedupe-test"].slug.current';
  const results = await Promise.all([1, 2, 3].map(() => sanityFetch(q, {}, () => [])));
  await sanityFetch(q, {}, () => []);
  assert.equal(calls.length, 1);
  for (const r of results) assert.deepEqual(r, ['a', 'b']);
  await sanityFetch(q, { slug: 'x' }, () => []);
  assert.equal(calls.length, 2, 'different params are a different request');
});

test('memo entries expire so warm ISR functions still refresh', async (t) => {
  let n = 0;
  const calls = stubFetch(() => ++n);
  const q = '*[_type == "ttl-test"]';
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  assert.equal(await sanityFetch(q, {}, () => 0), 1);
  t.mock.timers.tick(4 * 60 * 1000);
  assert.equal(await sanityFetch(q, {}, () => 0), 1, 'still deduped inside the window');
  t.mock.timers.tick(2 * 60 * 1000);
  assert.equal(await sanityFetch(q, {}, () => 0), 2, 'refetched after it expires');
  assert.equal(calls.length, 2);
});

test('during the build, a quota error resolves to the fallback instead of throwing', async (t) => {
  inPhase(t, BUILD);
  const calls = stubFetch(() => {
    throw new Error('plan_limit_reached - API Requests quota limit reached.');
  });
  const q = '*[_type == "quota-test"]';
  assert.deepEqual(await sanityFetch(q, {}, () => ['last-good']), ['last-good']);
  assert.deepEqual(await sanityFetch(q, {}, () => ['ignored']), ['last-good'], 'failure is memoized too, no retry storm');
  assert.equal(calls.length, 1);
});

test('at runtime (ISR), a Sanity error rethrows and is not memoized', async (t) => {
  inPhase(t, undefined);
  let fail = true;
  const calls = stubFetch(() => {
    if (fail) throw new Error('plan_limit_reached');
    return ['fresh'];
  });
  const q = '*[_type == "runtime-test"]';
  await assert.rejects(sanityFetch(q, {}, () => ['fallback']), /plan_limit_reached/);
  fail = false;
  assert.deepEqual(await sanityFetch(q, {}, () => ['fallback']), ['fresh'], 'next request retries');
  assert.equal(calls.length, 2);
});

test('a throwing fallback is not memoized', async (t) => {
  inPhase(t, BUILD);
  stubFetch(() => {
    throw new Error('plan_limit_reached');
  });
  const q = '*[_type == "bad-fallback-test"]';
  await assert.rejects(sanityFetch(q, {}, () => { throw new Error('fs gone'); }), /fs gone/);
  assert.deepEqual(await sanityFetch(q, {}, () => ['ok']), ['ok']);
});

test('reviews fall back to the markdown copies when Sanity errors during the build', async (t) => {
  inPhase(t, BUILD);
  stubFetch(() => {
    throw new Error('plan_limit_reached');
  });
  const md = [{ slug: 'edward', title: 'Edward' }];
  assert.deepEqual(await getAllBlogReviewsFromSanity(() => md), md);
  // Two callers for the same slug share the memoized failure; both must fall back.
  assert.deepEqual(await getBlogReviewBySlugFromSanity('edward', () => md[0]), md[0]);
  assert.deepEqual(await getBlogReviewBySlugFromSanity('edward', () => md[0]), md[0]);
});

test('a review Sanity says does not exist stays not-found (no fallback)', async () => {
  stubFetch(() => null);
  assert.equal(await getBlogReviewBySlugFromSanity('no-such-review', () => ({ slug: 'wrong' })), null);
});
