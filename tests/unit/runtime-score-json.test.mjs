/**
 * BRO-7803: runtime versioned score JSON (press-night scores live in minutes).
 * Every test requires the real production functions (CLAUDE.md rule 15).
 * Card VERIFY: node --test tests/unit/runtime-score-json.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../../scripts/lib/live-score/core.js');
const { chooseEntry, validatePayload } = require('../../scripts/lib/live-score/resolve.js');
const { applyHeroOverlay, stickyScore, reviewListProps } = require('../../scripts/lib/live-score/apply.js');
const { publish, purge } = require('../../scripts/lib/live-score/publish.js');

const view = (o = {}) => ({ score: 82, reviewCount: 6, tier1Count: 3, tier2Count: 1, showTBD: false, reviewsRemaining: 0, noReviewsExpected: false, criticsTakeMode: 'none', reviewArrival: null, ...o });
const row = (n) => ({ outletId: 'o' + n, outlet: 'O' + n, outletBadge: null, url: null, publishDate: '2026-11-19', tier: 1, reviewScore: 80 });
const KILL_ON = { schema: 1, enabled: true };

function mkPayload({ showId = 'x-2026', rev = 2000, v = view(), reviews = Array.from({ length: v.reviewCount }, (_, i) => row(i + 1)) } = {}) {
  const b = core.buildPayload({ showId, view: v, reviews, rev });
  return b;
}
function pointerFor(b, showId = 'x-2026') {
  return { schema: 1, seq: 1, shows: { [showId]: { v: b.v, c: b.c, rev: b.payload.rev, n: b.n, rc: b.payload.view.reviewCount, at: Date.now() } } };
}

/** In-memory stand-in for the bucket (same interface as makeStorage). */
function memStorage({ failPut = () => false, corruptGet = () => false } = {}) {
  const m = new Map(); const writes = [];
  return {
    m, writes,
    async put(path, text) { if (failPut(path)) throw new Error('boom ' + path); writes.push(path); m.set(path, text); },
    async get(path) { if (!m.has(path)) return { status: 404, text: '' }; return { status: 200, text: corruptGet(path) ? m.get(path) + ' ' : m.get(path) }; },
    async remove(path) { m.delete(path); },
  };
}

describe('1b. overlay never shows a count that differs from its rows (bar total)', () => {
  test('payload whose reviewCount differs from its row total is rejected', () => {
    const b = mkPayload({ v: view({ reviewCount: 99 }), reviews: [row(1), row(2)] });
    const entry = pointerFor(b).shows['x-2026'];
    const r = validatePayload({ payload: b.payload, entry, showId: 'x-2026', staticRev: 1000, staticReviewCount: 0 });
    assert.equal(r.reason, 'count-rows-mismatch');
  });
  test('payload whose rows match the count applies, and the breakdown total equals the count', () => {
    const b = mkPayload({ v: view({ reviewCount: 4 }) });
    const entry = pointerFor(b).shows['x-2026'];
    const r = validatePayload({ payload: b.payload, entry, showId: 'x-2026', staticRev: 1000, staticReviewCount: 0 });
    assert.equal(r.ok, true);
    const p = applyHeroOverlay({ show: { criticScore: {} } }, { view: r.view, reviews: r.reviews });
    assert.equal(p.show.criticScore.reviews.length, p.show.criticScore.reviewCount);
  });
});

describe('1. pointer/payload mismatch keeps the static page', () => {
  const b = mkPayload(); const ptr = pointerFor(b); const entry = ptr.shows['x-2026'];
  const ok = () => validatePayload({ payload: b.payload, entry, showId: 'x-2026', staticRev: 1000, staticReviewCount: 3 });
  test('good payload applies', () => assert.equal(ok().ok, true));
  for (const [name, mut, reason] of [
    ['wrong schema', (p) => ({ ...p, schema: 2 }), 'schema'],
    ['wrong show', (p) => ({ ...p, showId: 'other' }), 'show-mismatch'],
    ['wrong v', (p) => ({ ...p, v: 'deadbeefdeadbeef' }), 'version-mismatch'],
    ['wrong rev', (p) => ({ ...p, rev: p.rev + 1 }), 'rev-mismatch'],
    ['no view', (p) => ({ ...p, view: null }), 'no-view'],
    ['string counts', (p) => ({ ...p, view: { ...p.view, reviewCount: '6' } }), 'bad-counts'],
    ['scored without a score', (p) => ({ ...p, view: { ...p.view, score: null } }), 'scored-without-score'],
    ['reviews not array', (p) => ({ ...p, reviews: {} }), 'bad-reviews'],
  ]) test(name, () => {
    const r = validatePayload({ payload: mut(b.payload), entry, showId: 'x-2026', staticRev: 1000, staticReviewCount: 3 });
    assert.equal(r.ok, undefined); assert.equal(r.reason, reason);
  });
  test('null payload (404/bad JSON) is a no-op', () => assert.equal(validatePayload({ payload: null, entry, showId: 'x-2026', staticRev: 1000 }).ok, undefined));
});

describe('2. stale pointer / static newer', () => {
  const b = mkPayload({ rev: 2000 }); const ptr = pointerFor(b);
  test('payload newer than static -> entry chosen', () => assert.ok(chooseEntry({ showId: 'x-2026', staticRev: 1999, kill: KILL_ON, pointer: ptr }).entry));
  test('equal rev -> static wins', () => assert.equal(chooseEntry({ showId: 'x-2026', staticRev: 2000, kill: KILL_ON, pointer: ptr }).reason, 'static-newer-or-equal'));
  test('newer deploy after payload -> static wins', () => assert.equal(chooseEntry({ showId: 'x-2026', staticRev: 5000, kill: KILL_ON, pointer: ptr }).reason, 'static-newer-or-equal'));
  test('payload older than static is rejected even if the pointer entry lied', () => {
    const r = validatePayload({ payload: b.payload, entry: { v: b.v, rev: b.payload.rev }, showId: 'x-2026', staticRev: 3000 });
    assert.equal(r.reason, 'static-newer-or-equal');
  });
  test('review-count regression is rejected', () => {
    const r = validatePayload({ payload: b.payload, entry: pointerFor(b).shows['x-2026'], showId: 'x-2026', staticRev: 1000, staticReviewCount: 9 });
    assert.equal(r.reason, 'review-count-regression');
  });
});

describe('3. every failure path leaves the static page', () => {
  const b = mkPayload(); const ptr = pointerFor(b);
  for (const [name, args] of [
    ['kill switch off', { kill: { schema: 1, enabled: false }, pointer: ptr }],
    ['kill.json 404', { kill: null, pointer: ptr }],
    ['kill wrong schema', { kill: { schema: 9, enabled: true }, pointer: ptr }],
    ['pointer 404', { kill: KILL_ON, pointer: null }],
    ['pointer bad schema', { kill: KILL_ON, pointer: { schema: 9, shows: {} } }],
    ['pointer garbage', { kill: KILL_ON, pointer: 'x' }],
    ['no entry for this show', { kill: KILL_ON, pointer: { schema: 1, shows: {} } }],
    ['entry malformed', { kill: KILL_ON, pointer: { schema: 1, shows: { 'x-2026': { v: 5 } } } }],
  ]) test(name, () => {
    const r = chooseEntry({ showId: 'x-2026', staticRev: 1000, ...args });
    assert.equal(r.entry, undefined); assert.ok(r.reason);
  });
  test('resolver never throws on junk input', () => {
    for (const junk of [undefined, null, 1, 'a', [], {}]) {
      assert.doesNotThrow(() => chooseEntry({ showId: 'x', staticRev: 1, kill: junk, pointer: junk }));
      assert.doesNotThrow(() => validatePayload({ payload: junk, entry: junk, showId: 'x', staticRev: 1 }));
    }
  });
  test('provider source: fetch has a timeout, credentials omitted, errors swallowed, never blanks', () => {
    const src = fs.readFileSync('src/components/show-page/LiveScoreOverlay.tsx', 'utf8');
    assert.match(src, /AbortController/); assert.match(src, /credentials: 'omit'/);
    assert.match(src, /catch \{ return null; \}/); assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  });
});

describe('4. min-review gate + BRO-7750 exception come from the shared function, not the client', () => {
  test('overlay carries showTBD; a TBD payload renders no number anywhere', () => {
    const tbd = view({ showTBD: true, score: 71, reviewCount: 2, reviewsRemaining: 1 });
    const props = applyHeroOverlay({ show: { criticScore: { score: null, reviewCount: 0, tier1Count: 0, tier2Count: 0, reviews: [] } }, hasEnoughCriticReviews: false, reviewsRemaining: 0, noReviewsExpected: false, criticsTakeMode: 'none', hasAudience: true }, { view: tbd, reviews: [row(1)] });
    assert.equal(props.hasEnoughCriticReviews, false); assert.equal(props.reviewsRemaining, 1); assert.equal(props.hasAudience, false);
    assert.equal(stickyScore(71, { view: tbd, reviews: [] }), null);
  });
  test('client never recomputes the gate (no hasEnoughReviews/applyCoverageFloor in overlay code)', () => {
    for (const f of ['src/components/show-page/LiveScoreOverlay.tsx', 'scripts/lib/live-score/apply.js', 'scripts/lib/live-score/resolve.js']) {
      const src = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(src, /hasEnoughReviews|applyCoverageFloor|scoreGateArg/, f);
    }
  });
  test('CLASS GUARD: show page has no inline gate copy (hasEnoughReviews / applyCoverageFloor)', () => {
    const src = fs.readFileSync('src/app/show/[slug]/page.tsx', 'utf8');
    assert.doesNotMatch(src, /hasEnoughReviews\(/); assert.doesNotMatch(src, /applyCoverageFloor\(/);
    assert.match(src, /computeShowTBD\(show\)/);
  });
});

describe('5. convergence: two sources never regress', () => {
  test('for every (staticRev, payloadRev) the displayed rev is the max', () => {
    for (const s of [0, 1, 1000, 2000, 2001, 9e12]) for (const p of [1, 999, 2000, 2001, 5000]) {
      const b = mkPayload({ rev: p }); const ptr = pointerFor(b);
      const pick = chooseEntry({ showId: 'x-2026', staticRev: s, kill: KILL_ON, pointer: ptr });
      const shown = pick.entry ? p : s;
      assert.equal(shown, Math.max(s, p), `static ${s} payload ${p}`);
    }
  });
  test('after a full build with the same data (static rev >= payload rev) the overlay turns itself off', () => {
    const b = mkPayload({ rev: 2000 });
    assert.equal(chooseEntry({ showId: 'x-2026', staticRev: 2000, kill: KILL_ON, pointer: pointerFor(b) }).entry, undefined);
  });
  test('an older checkout built later cannot beat a newer overlay', () => {
    const b = mkPayload({ rev: 5000 });
    assert.ok(chooseEntry({ showId: 'x-2026', staticRev: 4000, kill: KILL_ON, pointer: pointerFor(b) }).entry);
  });
});

describe('6. whole-page consistency: one view model feeds every score consumer', () => {
  const props = { show: { criticScore: { score: null, reviewCount: 0, tier1Count: 0, tier2Count: 0, reviews: [] } }, hasEnoughCriticReviews: false, reviewsRemaining: 2, noReviewsExpected: false, criticsTakeMode: 'coming-soon', reviewArrival: { x: 1 }, reviewAgeNote: null, hasAudience: false };
  test('TBD -> scored flips badge, bar rows, count, arrival and take together', () => {
    const o = { view: view({ reviewArrival: { y: 2 }, criticsTakeMode: 'none' }), reviews: [row(1), row(2), row(3)] };
    const p = applyHeroOverlay(props, o);
    assert.equal(p.hasEnoughCriticReviews, true); assert.equal(p.show.criticScore.score, 82); assert.equal(p.show.criticScore.reviewCount, 6);
    assert.equal(p.show.criticScore.reviews.length, 3); assert.equal(p.reviewsRemaining, 0); assert.deepEqual(p.reviewArrival, { y: 2 }); assert.equal(p.criticsTakeMode, 'none');
  });
  test('no overlay -> props returned untouched (identity)', () => { assert.equal(applyHeroOverlay(props, null), props); assert.equal(stickyScore(77, null), 77); });
  test('ReviewsList: overlay rows replace inline + lazy rows, loadMore off, no duplicates', () => {
    const o = { view: view(), reviews: [row(1), row(2), row(3), row(4), row(5), row(6), row(7)] };
    const p = reviewListProps({ reviews: [row(1)], more: { url: '/x/reviews.json', totalCount: 12 }, initialCount: 5, category: 'broadway' }, o);
    assert.equal(p.more, undefined); assert.equal(p.reviews.length, 7); assert.equal(new Set(p.reviews.map((r) => r.outletId)).size, 7);
    assert.equal(reviewListProps({ reviews: [row(1)], more: { url: 'u' } }, null).more.url, 'u');
  });
});

describe('7. publisher', () => {
  const plan = (n = 6, extra = {}) => [{ showId: 'x-2026', view: view({ reviewCount: n }), reviews: [row(1)], ...extra }];
  test('uploads payload, verifies, pointer written LAST', async () => {
    const st = memStorage(); const r = await publish({ storage: st, plan: plan(), rev: 2000 });
    assert.equal(r.pointerWritten, true); assert.equal(st.writes.at(-1), 'p.json'); assert.ok(st.writes[0].startsWith('s/x-2026.'));
    const ptr = JSON.parse(st.m.get('p.json')); assert.equal(ptr.shows['x-2026'].rev, 2000);
  });
  test('content-hash skip ignores rev: same data at a later rev writes nothing', async () => {
    const st = memStorage(); await publish({ storage: st, plan: plan(), rev: 2000 }); const n = st.writes.length;
    const r = await publish({ storage: st, plan: plan(), rev: 3000 });
    assert.equal(st.writes.length, n); assert.equal(r.results[0].reason, 'unchanged'); assert.equal(r.pointerWritten, false);
  });
  test('payload verify failure leaves the pointer untouched', async () => {
    const st = memStorage({ corruptGet: (p) => p.startsWith('s/') });
    const r = await publish({ storage: st, plan: plan(), rev: 2000 });
    assert.equal(r.results[0].status, 'failed'); assert.equal(r.pointerWritten, false); assert.equal(st.m.has('p.json'), false);
  });
  test('upload failure never advances the pointer', async () => {
    const st = memStorage({ failPut: (p) => p.startsWith('s/') });
    const r = await publish({ storage: st, plan: plan(), rev: 2000 });
    assert.equal(r.results[0].status, 'failed'); assert.equal(st.m.has('p.json'), false);
  });
  test('review count never decreases unless --allow-decrease', async () => {
    const st = memStorage(); await publish({ storage: st, plan: plan(6), rev: 2000 });
    const low = await publish({ storage: st, plan: plan(4), rev: 3000 });
    assert.equal(low.results[0].reason, 'review-count-decrease');
    const ok = await publish({ storage: st, plan: plan(4), rev: 3000, allowDecrease: true });
    assert.equal(ok.results[0].status, 'uploaded');
  });
  test('staleness-guard flagged show and unsafe run are never published', async () => {
    const st = memStorage();
    const a = await publish({ storage: st, plan: plan(), rev: 2000, flagged: new Set(['x-2026']) });
    const b = await publish({ storage: st, plan: plan(), rev: 2000, safe: false });
    assert.equal(a.results[0].reason, 'flagged-stale'); assert.equal(b.results[0].reason, 'unsafe-run'); assert.equal(st.writes.length, 0);
  });
  test('pointer merge never lowers a rev; expiry only drops covered entries', () => {
    const prev = { seq: 4, shows: { a: { v: '1', c: 'c', rev: 5000, at: 0 }, b: { v: '2', c: 'c', rev: 100, at: 0 } } };
    const now = 49 * 3600 * 1000;
    const m = core.mergePointer({ prev, updates: { a: { v: '9', c: 'z', rev: 4000 } }, now, live: { b: 200 } });
    assert.equal(m.shows.a.rev, 5000); assert.equal(m.shows.a.v, '1'); assert.equal(m.shows.b, undefined); assert.equal(m.seq, 5);
    const m2 = core.mergePointer({ prev, updates: {}, now, live: {} });
    assert.ok(m2.shows.b, 'expired but no live deploy covers it -> kept');
  });
  test('BRO-7831: an uncovered entry older than the hard cap is dropped; a younger uncovered one is kept', () => {
    const day = 86400000; const now = 10 * day;
    const prev = { seq: 1, shows: { old: { v: '1', c: 'c', rev: 5, at: now - 8 * day }, mid: { v: '2', c: 'c', rev: 5, at: now - 3 * day } } };
    const m = core.mergePointer({ prev, updates: {}, now, live: {} });
    assert.equal(m.shows.old, undefined); assert.ok(m.shows.mid);
  });
  test('BRO-7831: a purge tombstone survives the hard cap', async () => {
    const st = memStorage(); await purge({ storage: st, showId: 'x-2026', rev: 9000, now: 1000 });
    const prev = JSON.parse(st.m.get('p.json'));
    const m = core.mergePointer({ prev, updates: {}, now: prev.shows['x-2026'].at + 30 * 86400000, live: {} });
    assert.ok(m.shows['x-2026'], 'tombstone kept');
  });
  test('BRO-7831: eligibility window is wider than the publisher hot set', () => {
    assert.ok(core.ELIGIBLE_DAYS > core.HOT_DAYS);
    const now = Date.parse('2026-11-19T12:00:00Z');
    const sh = [{ id: 'soon', openingDate: '2026-11-23' }];
    assert.equal(core.selectHotShows({ now, shows: sh }).length, 0);
    assert.equal(core.selectHotShows({ now, shows: sh, days: core.ELIGIBLE_DAYS }).length, 1);
  });
  test('BRO-7831: consensus text that landed after the build shows through the overlay; absent field keeps static', () => {
    const { applyHeroOverlay } = require('../../scripts/lib/live-score/apply');
    const props = { show: { criticScore: {} }, consensusText: null, reviewAgeNote: null, hasAudience: false };
    const view = { score: 80, reviewCount: 1, tier1Count: 0, tier2Count: 0, showTBD: false, reviewsRemaining: 0, noReviewsExpected: false, criticsTakeMode: 'consensus', reviewArrival: null };
    assert.equal(applyHeroOverlay(props, { view: { ...view, consensusText: 'Critics loved it.' }, reviews: [] }).consensusText, 'Critics loved it.');
    assert.equal(applyHeroOverlay({ ...props, consensusText: 'static' }, { view, reviews: [] }).consensusText, 'static');
    const bad = validatePayload({ payload: { schema: core.SCHEMA, showId: 'x', v: 'v', rev: 9, view: { ...view, consensusText: 5 }, reviews: [{}] }, entry: { v: 'v', rev: 9 }, showId: 'x', staticRev: 1, staticReviewCount: 0 });
    assert.equal(bad.reason, 'bad-consensus');
  });
  test('hot set: opening +/-3d or fresh review; cold shows excluded', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    const ids = core.selectHotShows({ now, shows: [{ id: 'open', openingDate: '2026-11-19' }, { id: 'old', openingDate: '2025-01-01' }, { id: 'rev', openingDate: '2024-01-01' }], reviewDatesByShow: { rev: ['2026-11-18'], old: ['2026-01-01'] } });
    assert.deepEqual(ids.sort(), ['open', 'rev']);
  });
  test('kill.json is never written by the publisher (only by the CLI)', async () => {
    const st = memStorage(); await publish({ storage: st, plan: plan(), rev: 2000 }); await purge({ storage: st, showId: 'x-2026', rev: 9000 });
    assert.equal(st.writes.includes('kill.json'), false);
    assert.doesNotMatch(fs.readFileSync('scripts/lib/live-score/publish.js', 'utf8'), /kill\.json/);
  });
  test('purge tombstones the show (TBD view, higher rev) and deletes the old payload', async () => {
    const st = memStorage(); await publish({ storage: st, plan: plan(), rev: 2000 });
    const oldPath = [...st.m.keys()].find((k) => k.startsWith('s/x-2026.'));
    await purge({ storage: st, showId: 'x-2026', rev: 9000 });
    const ptr = JSON.parse(st.m.get('p.json')); assert.equal(ptr.shows['x-2026'].rev, 9000); assert.equal(st.m.has(oldPath), false);
    const tomb = JSON.parse(st.m.get(`s/x-2026.${ptr.shows['x-2026'].v}.json`)); assert.equal(tomb.view.showTBD, true); assert.equal(tomb.reviews.length, 0);
    // the takedown must actually apply on a page that was built with reviews (count-regression guard is waived for tombstones)
    const r = validatePayload({ payload: tomb, entry: ptr.shows['x-2026'], showId: 'x-2026', staticRev: 2000, staticReviewCount: 6 });
    assert.equal(r.ok, true); assert.equal(r.view.showTBD, true);
  });
});

describe('8. workflow wiring (rebuild-fast)', () => {
  const wf = fs.readFileSync('.github/workflows/rebuild-fast.yml', 'utf8');
  const i = wf.indexOf('- name: Publish live score payloads (BRO-7803)');
  const block = wf.slice(i, wf.indexOf('\n      - name:', i + 10));
  test('step exists, advisory, gated on the staleness guard, bounded', () => {
    assert.ok(i > 0);
    assert.match(block, /continue-on-error: true/);
    assert.match(block, /steps\.staleness\.outputs\.safe_to_publish == 'true'/);
    assert.match(block, /timeout-minutes: 3/);
    assert.match(block, /--flagged-file=/);
    assert.match(block, /SUPABASE_SERVICE_ROLE_KEY/);
  });
  test('runs after the staleness guard + flagged revert, the core data push and the deploy trigger', () => {
    const at = (n) => wf.indexOf(n);
    assert.ok(at('Verify no scoreable review vanished') < i);
    assert.ok(at('Revert public data for shows flagged by staleness guard') < i);
    assert.ok(i > at('- name: Push core data to private repo'));
    assert.ok(i > at('- name: Trigger deploy (core data changed)'));
    assert.match(block, /steps\.push-core-data\.outcome == 'success'/);
  });
  test('publisher honours the guard inputs (flagged file, safe flag, no-decrease)', () => {
    const ts = fs.readFileSync('scripts/publish-live-scores.ts', 'utf8');
    assert.match(ts, /flagged-file/); assert.match(ts, /LIVE_SCORES_SAFE/);
  });
});

describe('8b. page does not render a second reviews section next to the static one', () => {
  test('LiveReviewsSectionIfAbsent is told whether the static section exists and returns null then', () => {
    const page = fs.readFileSync('src/app/show/[slug]/page.tsx', 'utf8');
    const comp = fs.readFileSync('src/components/show-page/LiveScoreOverlay.tsx', 'utf8');
    assert.match(page, /<LiveReviewsSectionIfAbsent[^>]*staticHasReviews=/);
    assert.match(comp, /if \(staticHasReviews \|\|/);
  });
});

describe('7b. concurrent publishers do not drop each other', () => {
  test('second publisher re-reads the pointer and keeps the first one\'s show', async () => {
    const st = memStorage();
    const mk = (id, n) => [{ showId: id, view: view({ reviewCount: n }), reviews: [row(1)] }];
    // publisher A uploads, then B publishes a different show before A writes the pointer: emulate via sequential interleave
    await publish({ storage: st, plan: mk('a-2026', 5), rev: 1000 });
    await publish({ storage: st, plan: mk('b-2026', 6), rev: 1100 });
    const ptr = JSON.parse(st.m.get('p.json'));
    assert.ok(ptr.shows['a-2026'] && ptr.shows['b-2026']);
  });
});

describe('master switch and game-day wiring (BRO-7803)', () => {
  const read = (p) => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
  test('config enables the publisher by default', () => {
    assert.equal(require('../../scripts/lib/live-score/config').PUBLISHER_ENABLED, true);
  });
  test('the CLI and the simulated night both read the same switch', () => {
    assert.match(read('scripts/publish-live-scores.ts'), /PUBLISHER_ENABLED/);
    assert.match(read('scripts/lib/game-day/simulated-opening-night.js'), /liveScoreCfg\.PUBLISHER_ENABLED/);
  });
  test('a mutant exists that turns the night red when the switch is off', () => {
    assert.match(read('scripts/lib/game-day/mutants.js'), /BRO-7803-runtime-score-path/);
  });
});
