/**
 * BRO-8056 phase 2: the show-refresh reader.
 *  - decideShowRefresh: every path to 'base' / 'base-error' / a published hash,
 *    driven by fake store reads (no network).
 *  - renderForDecision on real core data (skips without data/): an unchanged
 *    slice renders exactly what the build renders; a changed slice changes the
 *    page's show, consensus and audience; a TBD slice falls back to the build.
 *
 * Run: npx tsx --test tests/unit/show-refresh-reader.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  decideShowRefresh, showRefreshEnabled, REV_BASE, REV_BASE_ERROR,
  type RefreshDeps, type RefreshManifest, type StoreRead,
} from '../../src/lib/show-refresh-core';

/* eslint-disable @typescript-eslint/no-require-imports */
const { sliceHash, SLICE_VERSION } = require('../../scripts/lib/show-refresh/slice');
/* eslint-enable @typescript-eslint/no-require-imports */

const ok = (value: unknown): StoreRead => ({ state: 'ok', value });
const MISSING: StoreRead = { state: 'missing' };
const ERR: StoreRead = { state: 'error', error: 'boom' };

function fakeSlice(over: Record<string, unknown> = {}) {
  return {
    sliceVersion: SLICE_VERSION, showId: 'hamilton-2015',
    row: { id: 'hamilton-2015', slug: 'hamilton' },
    reviews: [], blogReviews: [], audience: [], buzz: [], consensus: null, audienceBuzz: null,
    coverage: { cov: null, scorePublicSince: null, acked: false },
    ...over,
  };
}

function setup(over: Partial<RefreshDeps> = {}, opts: { slice?: Record<string, unknown>; held?: boolean } = {}) {
  const slice = fakeSlice(opts.slice);
  const hash = sliceHash(slice);
  const manifest: RefreshManifest = {
    schema: 1, sliceVersion: SLICE_VERSION, manifestId: 'm1', buildInstant: Date.UTC(2026, 10, 23, 12),
    shows: { 'hamilton-2015': { slug: 'hamilton', hash: '0000000000000000', held: opts.held === true, imagesSig: 'x' } },
  };
  const calls: string[] = [];
  const deps: RefreshDeps = {
    enabled: true,
    manifest,
    readKill: async () => { calls.push('kill'); return ok({ schema: 1, killed: false, seq: 1 }); },
    readHome: async () => { calls.push('home'); return ok({ manifestId: 'm1', shows: { 'hamilton-2015': { hash } } }); },
    readSlice: async (id, h) => { calls.push(`slice:${id}:${h}`); return ok(slice); },
    sliceHash,
    ...over,
  };
  return { deps, hash, slice, calls };
}

test('published slice: rev is its hash and the slice comes back', async () => {
  const { deps, hash, calls } = setup();
  const d = await decideShowRefresh('hamilton', deps);
  assert.equal(d.rev, hash);
  assert.equal(d.reason, 'published');
  assert.ok('slice' in d && d.slice.showId === 'hamilton-2015');
  assert.deepEqual(calls, ['kill', 'home', `slice:hamilton-2015:${hash}`]);
});

test('flag off, no manifest, not prerendered, held: base without reading the store', async () => {
  for (const [name, deps, slug] of [
    ['flag off', setup({ enabled: false }).deps, 'hamilton'],
    ['no manifest', setup({ manifest: null }).deps, 'hamilton'],
    ['not prerendered', setup().deps, 'some-other-show'],
    ['held', setup({}, { held: true }).deps, 'hamilton'],
  ] as const) {
    const calls: string[] = [];
    const spy = { ...deps, readKill: async () => { calls.push('kill'); return MISSING; } };
    const d = await decideShowRefresh(slug, spy);
    assert.equal(d.rev, REV_BASE, name);
    assert.deepEqual(calls, [], `${name} must not read the store`);
  }
});

test('kill: killed or missing => base; unreadable or malformed => base-error (fail closed)', async () => {
  const cases: Array<[StoreRead, string]> = [
    [ok({ killed: true }), REV_BASE],
    [MISSING, REV_BASE],
    [ERR, REV_BASE_ERROR],
    [ok({ killed: 'no' }), REV_BASE_ERROR],
    [ok(null), REV_BASE_ERROR],
  ];
  for (const [read, want] of cases) {
    const d = await decideShowRefresh('hamilton', setup({ readKill: async () => read }).deps);
    assert.equal(d.rev, want, JSON.stringify(read));
  }
});

test('home: unreadable => base-error; missing, other build, unlisted, equal to build => base', async () => {
  const { hash } = setup();
  const cases: Array<[StoreRead, string, string]> = [
    [ERR, REV_BASE_ERROR, 'error'],
    [MISSING, REV_BASE, 'missing'],
    [ok({ manifestId: 'other', shows: { 'hamilton-2015': { hash } } }), REV_BASE, 'other build'],
    [ok({ manifestId: 'm1', shows: {} }), REV_BASE, 'unlisted'],
    [ok({ manifestId: 'm1', shows: { 'hamilton-2015': { hash: '0000000000000000' } } }), REV_BASE, 'equal to build'],
    [ok({ manifestId: 'm1', shows: { 'hamilton-2015': { hash: '../../etc' } } }), REV_BASE_ERROR, 'malformed hash'],
    [ok([]), REV_BASE_ERROR, 'home not an object'],
    [ok({ shows: {} }), REV_BASE_ERROR, 'no manifestId'],
    [ok({ manifestId: 'm1' }), REV_BASE_ERROR, 'no shows'],
    [ok({ manifestId: 'm1', shows: { 'hamilton-2015': { hash: 7 } } }), REV_BASE_ERROR, 'non-string hash'],
    [ok({ manifestId: 'm1', shows: { 'hamilton-2015': null } }), REV_BASE_ERROR, 'null entry'],
  ];
  for (const [read, want, name] of cases) {
    const d = await decideShowRefresh('hamilton', setup({ readHome: async () => read }).deps);
    assert.equal(d.rev, want, name);
  }
});

test('slice: missing, unreadable, wrong show, wrong slug, tampered => base-error; other sliceVersion => base', async () => {
  const { slice } = setup();
  const cases: Array<[StoreRead, string, string]> = [
    [MISSING, REV_BASE_ERROR, 'missing'],
    [ERR, REV_BASE_ERROR, 'error'],
    [ok({ ...slice, showId: 'wicked-2003' }), REV_BASE_ERROR, 'another show'],
    [ok({ ...slice, row: { id: 'hamilton-2015', slug: 'wicked' } }), REV_BASE_ERROR, 'slug'],
    [ok({ ...slice, reviews: [{ x: 1 }] }), REV_BASE_ERROR, 'content differs from its hash'],
    [ok({ ...slice, sliceVersion: SLICE_VERSION + 1 }), REV_BASE, 'other slice version'],
    [ok('not json object'), REV_BASE_ERROR, 'malformed'],
  ];
  for (const [read, want, name] of cases) {
    const d = await decideShowRefresh('hamilton', setup({ readSlice: async () => read }).deps);
    assert.equal(d.rev, want, name);
  }
});

test('a malformed build manifest entry never throws', async () => {
  const { deps } = setup();
  const shows = { ...deps.manifest!.shows, 'broken-2020': null } as unknown as RefreshManifest['shows'];
  const d1 = await decideShowRefresh('hamilton', { ...deps, manifest: { ...deps.manifest!, shows } });
  assert.notEqual(d1.rev, REV_BASE_ERROR);
  const bad = { 'hamilton-2015': { slug: 'hamilton', held: false } } as unknown as RefreshManifest['shows'];
  const d2 = await decideShowRefresh('hamilton', { ...deps, manifest: { ...deps.manifest!, shows: bad } });
  assert.equal(d2.rev, REV_BASE_ERROR);
});

test('a read that throws never escapes: base-error', async () => {
  const d = await decideShowRefresh('hamilton', setup({ readHome: async () => { throw new Error('socket hang up'); } }).deps);
  assert.equal(d.rev, REV_BASE_ERROR);
  assert.match(d.reason, /socket hang up/);
});

test('showRefreshEnabled: on only with SHOW_REFRESH_READER=on, never during next build', () => {
  assert.equal(showRefreshEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(showRefreshEnabled({ SHOW_REFRESH_READER: 'on' } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(showRefreshEnabled({ SHOW_REFRESH_READER: 'true' } as unknown as NodeJS.ProcessEnv), false);
  assert.equal(showRefreshEnabled({ SHOW_REFRESH_READER: 'on', NEXT_PHASE: 'phase-production-build' } as unknown as NodeJS.ProcessEnv), false);
});

// ---- real core data ----------------------------------------------------------
const DATA = path.join(__dirname, '../../data');
const MANIFEST = path.join(DATA, 'show-refresh-manifest.json');
const haveData = fs.existsSync(path.join(DATA, 'shows.json')) && fs.statSync(path.join(DATA, 'shows.json')).size > 100_000
  && fs.existsSync(MANIFEST);

async function realSlices(n: number) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { buildShowInputs } = require('../../scripts/lib/show-refresh/inputs');
  const { indexForSlices, sliceFor } = require('../../scripts/lib/show-refresh/slice');
  const { readCoverageFloorInputs } = require('../../scripts/lib/coverage-floor-inputs');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const manifest = read('show-refresh-manifest.json');
  const inputs = buildShowInputs({
    showsData: read('shows.json'), reviews: read('reviews.json').reviews,
    blogReviews: read('blog-reviews-for-scoring.json').reviews,
    audience: read('audience.json').audience, buzz: read('buzz.json').threads,
  });
  const index = indexForSlices(inputs, {
    consensusById: read('critic-consensus.json').shows,
    audienceBuzzById: read('audience-buzz.json').shows,
    coverageFloorInputs: readCoverageFloorInputs({
      gapAudit: path.join(DATA, 'audit', 'show-review-gap.json'),
      stamps: path.join(DATA, 'audit', 'score-public-since.json'),
      acks: path.join(DATA, 'audit', 't1-coverage-ack.json'),
      snapshot: path.join(DATA, 'coverage-floor-snapshot.json'),
    }),
  });
  // Diverse picks: listed, not held, spread over the manifest (musical, play, closed, West End...).
  const ids = Object.keys(manifest.shows).filter(id => !manifest.shows[id].held);
  const step = Math.max(1, Math.floor(ids.length / n));
  const picks = ids.filter((_, i) => i % step === 0).slice(0, n);
  return { manifest, picks: picks.map(id => ({ id, slug: manifest.shows[id].slug, slice: sliceFor(id, index) })) };
}

test('real data: an unchanged slice renders exactly what the build renders', { skip: !haveData && 'core data not present' }, async () => {
  const { renderForDecision, getShowForRender } = await import('../../src/lib/show-render');
  const { manifest, picks } = await realSlices(20);
  assert.ok(picks.length >= 10, 'want at least 10 shows');
  let same = 0;
  for (const p of picks) {
    assert.ok(p.slice, p.id);
    assert.equal(sliceHash(p.slice), manifest.shows[p.id].hash, `manifest hash = slice hash for ${p.id}`);
    const built = await getShowForRender(p.slug);
    const over = renderForDecision(p.slug, { rev: 'h', reason: 'published', showId: p.id, slice: p.slice }, manifest.buildInstant);
    assert.ok(built && over, p.id);
    assert.equal(built.rev, REV_BASE);
    assert.equal(over.rev, 'h', `${p.id} rendered from the slice (not TBD)`);
    // computedAt is the compute clock (build instant vs this process); no page shows it.
    const norm = (r: typeof built) => ({ ...r, rev: 'x', show: { ...r.show, computedAt: 'x' } });
    assert.deepEqual(norm(over), norm(built), `render parity ${p.id}`);
    same++;
  }
  console.log(`render parity: ${same}/${picks.length} shows identical`);
});

test('real data: a changed slice reaches show, consensus and audience; TBD falls back to the build', { skip: !haveData && 'core data not present' }, async () => {
  const { renderForDecision, getShowForRender } = await import('../../src/lib/show-render');
  const { manifest, picks } = await realSlices(40);
  const p = picks.find(x => x.slice && x.slice.reviews.length >= 8 && x.slice.consensus && x.slice.audienceBuzz);
  assert.ok(p, 'need a show with reviews, consensus and audience buzz');
  const s = structuredClone(p.slice);
  s.consensus = { ...s.consensus, text: 'FIXTURE consensus text' };
  s.row = { ...s.row, title: `${s.row.title} FIXTURE` };
  for (const r of s.reviews) { r.assignedScore = 99; r.originalScore = null; }
  const built = await getShowForRender(p.slug);
  const over = renderForDecision(p.slug, { rev: 'h2', reason: 'published', showId: p.id, slice: s }, manifest.buildInstant);
  assert.ok(built && over);
  assert.equal(over.rev, 'h2');
  assert.equal(over.consensus?.text, 'FIXTURE consensus text');
  assert.match(over.show.title, /FIXTURE$/);
  assert.notEqual(over.show.criticScore?.score, built.show.criticScore?.score, 'score follows the slice reviews');
  assert.deepEqual(over.audienceBuzz, built.audienceBuzz, 'audience unchanged when the slice audience is unchanged');

  const tbd = structuredClone(p.slice);
  tbd.reviews = []; tbd.blogReviews = [];
  const fallback = renderForDecision(p.slug, { rev: 'h3', reason: 'published', showId: p.id, slice: tbd }, manifest.buildInstant);
  assert.equal(fallback?.rev, REV_BASE, 'a TBD slice renders the build');
  assert.equal(fallback?.show.title, built.show.title);

  const broken = { ...structuredClone(p.slice), reviews: 'not an array' };
  const errored = renderForDecision(p.slug, { rev: 'h4', reason: 'published', showId: p.id, slice: broken as never }, manifest.buildInstant);
  assert.equal(errored?.rev, REV_BASE_ERROR, 'a slice that throws in compute renders the build, marked base-error');
});

// ---- BRO-8170 gap 7: one shared deadline across the kill, home and slice reads ----
test('gap 7: the deadline is shared: reads under it pass, the read that crosses it is base-error', async () => {
  const { readWithDeadline, READ_DEADLINE_ERROR } = await import('../../src/lib/show-refresh-core');
  let t = 0;
  const now = () => t;
  // Fake clock: each read "takes" 40 ms; the budget is 70 ms, so the third read starts past it.
  const slow = (r: StoreRead) => async () => { t += 40; return r; };
  const { deps, hash } = setup();
  const d = await decideShowRefresh('hamilton', {
    ...deps, deadlineMs: 70, now,
    readKill: slow(ok({ killed: false, seq: 1 })),
    readHome: slow(ok({ manifestId: 'm1', shows: { 'hamilton-2015': { hash } } })),
    readSlice: slow(ok(fakeSlice())),
  });
  assert.equal(d.rev, REV_BASE_ERROR);
  assert.match(d.reason, new RegExp(READ_DEADLINE_ERROR));
  t = 0;
  const fine = await decideShowRefresh('hamilton', { ...setup().deps, deadlineMs: 1000, now });
  assert.equal(fine.rev, hash, 'well under the deadline: published');
  // readWithDeadline: a hung read resolves at the deadline, a throw becomes an error read.
  const hung = await readWithDeadline(() => new Promise<StoreRead>(() => {}), Date.now() + 30);
  assert.deepEqual(hung, { state: 'error', error: READ_DEADLINE_ERROR });
  assert.deepEqual(await readWithDeadline(async () => { throw new Error('x'); }, null), { state: 'error', error: 'x' });
  // A synchronous throw (not a rejected promise) also becomes an error read, with or without a deadline.
  const syncThrow = (() => { throw new Error('sync'); }) as unknown as () => Promise<StoreRead>;
  assert.deepEqual(await readWithDeadline(syncThrow, Date.now() + 1000), { state: 'error', error: 'sync' });
  assert.deepEqual(await readWithDeadline(syncThrow, null), { state: 'error', error: 'sync' });
});

// ---- BRO-8170 gap 5: parity expects the page's TBD verdict (computeShowTBD) ----
test('gap 5: expectedParityRow is TBD exactly when the page is (previews, coverage floor), not on review count alone',
  { skip: !haveData && 'core data not present' }, async () => {
    const { expectedParityRow } = await import('../../scripts/lib/show-refresh/expected-parity-row');
    const { computeShowTBD } = await import('../../src/lib/show-score-tbd');
    const { renderForDecision } = await import('../../src/lib/show-render');
    const { manifest, picks } = await realSlices(40);
    const p = picks.find(x => x.slice && x.slice.reviews.length >= 8);
    assert.ok(p, 'need a scored show');
    const scored = expectedParityRow(p.slice, { buildInstant: manifest.buildInstant });
    assert.equal(typeof scored.score, 'number', `${p.id} scores`);
    // Same slice, now in previews: enough reviews, but the page shows TBD.
    const previews = structuredClone(p.slice);
    previews.row = { ...previews.row, status: 'previews', openingDate: '2099-01-01', closingDate: null, previewsStartDate: null };
    // No public-score stamp, so the BRO-7750 floor does not keep the score up.
    previews.coverage = { ...previews.coverage, scorePublicSince: null };
    const row = expectedParityRow(previews, { buildInstant: manifest.buildInstant });
    assert.equal(row.score, null, 'previews => TBD, as the page renders it');
    assert.equal(row.reviewCount, scored.reviewCount, 'count is reported either way');
    // And it agrees with the page's own gate on every pick.
    for (const x of picks.filter(y => y.slice)) {
      const r = renderForDecision(x.slug, { rev: 'h', reason: 'published', showId: x.id, slice: x.slice }, manifest.buildInstant);
      if (!r || r.rev !== 'h') continue;
      const want = computeShowTBD(r.show) ? null : Math.round(r.show.criticScore!.score!);
      assert.equal(expectedParityRow(x.slice, { buildInstant: manifest.buildInstant }).score, want, x.id);
    }
  });
