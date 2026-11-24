// Tests for scripts/lib/show-refresh/publish-plan.js (BRO-8214, plan v14-final §1.5 steps 3-6, row 11).
// Run: node --test scripts/lib/show-refresh/publish-plan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planPublish, OUTCOMES, SKIPS } = require('./publish-plan.js');

const NOW = Date.UTC(2026, 10, 24, 12, 0);
const h = (c) => c.repeat(16);
const mshow = (o = {}) => ({ slug: 's', hash: h('a'), held: false, imagesSig: 'img', reviewCount: 2, reviewsSig: 'sig', ...o });
const manifest = (shows = { x: mshow() }, o = {}) => ({
  schema: 1, sliceVersion: 1, manifestId: 'm1', buildInstant: NOW - 3600e3, registrySha: 'reg',
  dataShas: { 'shows.json': 'z' }, showCount: Object.keys(shows).length, shows, ...o,
});
const hshow = (o = {}) => ({ hash: h('a'), held: false, slug: 's', imagesSig: 'img', reviewCount: 2, reviewsSig: 'sig', ...o });
const head = (shows = { x: hshow() }, o = {}) => ({ registrySha: 'reg', sliceVersion: 1, shows, ...o });
const plan = (a) => planPublish({ now: NOW, ...a });

test('no-op: HEAD == manifest => nothing-to-do, 0 targets, empty home', () => {
  const r = plan({ manifest: manifest(), head: head() });
  assert.equal(r.outcome, OUTCOMES.NOTHING_TO_DO);
  assert.deepEqual(r.targets, []);
  assert.equal(r.skips.x, SKIPS.UNCHANGED);
  assert.deepEqual(r.nextHome, { manifestId: 'm1', shows: {}, pending: {} });
});

test('a changed, eligible show is a target and goes to pending with its hash', () => {
  const r = plan({ manifest: manifest(), head: head({ x: hshow({ hash: h('b') }) }) });
  assert.equal(r.outcome, OUTCOMES.PUBLISH);
  assert.deepEqual(r.targets, [{ id: 'x', hash: h('b') }]);
  assert.deepEqual(r.nextHome.shows, { x: { hash: h('b') } });
  assert.deepEqual(r.nextHome.pending, { x: { since: NOW, expect: h('b') } });
  assert.equal(r.counts.targets, 1);
});

test('unusable manifest', () => {
  const r = plan({ manifest: { schema: 1, invalid: true }, head: head() });
  assert.equal(r.outcome, OUTCOMES.MANIFEST_UNUSABLE);
  assert.deepEqual(r.targets, []);
  assert.equal(plan({ manifest: null, head: head() }).outcome, OUTCOMES.MANIFEST_UNUSABLE);
});

test('slice version mismatch', () => {
  const r = plan({ manifest: manifest(), head: head({ x: hshow({ hash: h('b') }) }, { sliceVersion: 2 }) });
  assert.equal(r.outcome, OUTCOMES.SLICE_VERSION);
  assert.deepEqual(r.targets, []);
});

test('held at build / held at HEAD are never targets', () => {
  const r = plan({ manifest: manifest({ x: mshow({ held: true }), y: mshow() }), head: head({ x: hshow({ hash: h('b') }), y: hshow({ hash: h('b'), held: true }) }) });
  assert.equal(r.skips.x, SKIPS.HELD_BUILD);
  assert.equal(r.skips.y, SKIPS.HELD_HEAD);
  assert.deepEqual(r.targets, []);
});

test('images changed, flagged, compute error, not in HEAD', () => {
  const r = plan({
    manifest: manifest({ a: mshow(), b: mshow(), c: mshow(), d: mshow() }),
    head: head({ a: hshow({ hash: h('b'), imagesSig: 'new' }), b: hshow({ hash: h('b') }), c: { error: 'boom' } }),
    flagged: new Set(['b']),
  });
  assert.equal(r.skips.a, SKIPS.IMAGES_CHANGED);
  assert.equal(r.skips.b, SKIPS.FLAGGED);
  assert.equal(r.skips.c, SKIPS.COMPUTE_ERROR);
  assert.equal(r.skips.d, SKIPS.NOT_IN_HEAD);
  assert.deepEqual(r.targets, []);
  assert.equal(plan({ manifest: manifest(), head: head({ x: hshow({ hash: h('b') }) }), flagged: ['x'] }).skips.x, SKIPS.FLAGGED, 'array accepted');
});

test('review count drop is never published, even on the rebuild step', () => {
  const a = { manifest: manifest(), head: head({ x: hshow({ hash: h('b'), reviewCount: 1, reviewsSig: 'other' }) }) };
  assert.equal(plan(a).skips.x, SKIPS.REVIEW_COUNT_DROP);
  assert.equal(plan({ ...a, rebuildStep: true }).skips.x, SKIPS.REVIEW_COUNT_DROP);
});

test('review list changed: skipped on cron, published on the rebuild step', () => {
  const a = { manifest: manifest(), head: head({ x: hshow({ hash: h('b'), reviewCount: 3, reviewsSig: 'other' }) }) };
  assert.equal(plan(a).skips.x, SKIPS.REVIEW_LIST_CHANGED);
  const r = plan({ ...a, rebuildStep: true });
  assert.deepEqual(r.targets, [{ id: 'x', hash: h('b') }]);
});

test('an old manifest without review meta skips changed shows as no-review-meta', () => {
  const { reviewCount, reviewsSig, ...old } = mshow();
  const r = plan({ manifest: manifest({ x: old }), head: head({ x: hshow({ hash: h('b') }) }) });
  assert.equal(r.skips.x, SKIPS.NO_REVIEW_META);
  assert.equal(plan({ manifest: manifest({ x: old }), head: head() }).skips.x, SKIPS.UNCHANGED, 'unchanged stays unchanged');
});

test('shows at HEAD that the build did not render are dirty, never carried', () => {
  const r = plan({ manifest: manifest(), head: head({ x: hshow(), fresh: hshow({ hash: h('c') }) }) });
  assert.deepEqual(r.dirty, ['fresh']);
  assert.deepEqual(r.targets, []);
  assert.equal('fresh' in r.nextHome.shows, false);
});

test('registry mismatch: nothing new; keeps prev entries whose HEAD hash still matches', () => {
  const prevHome = { manifestId: 'm1', shows: { x: { hash: h('b') }, y: { hash: h('b') } }, pending: {} };
  const r = plan({
    manifest: manifest({ x: mshow(), y: mshow(), z: mshow() }),
    head: head({ x: hshow({ hash: h('b') }), y: hshow({ hash: h('c') }), z: hshow({ hash: h('d') }) }, { registrySha: 'other' }),
    prevHome,
  });
  assert.equal(r.outcome, OUTCOMES.REGISTRY_MISMATCH);
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.nextHome.shows, { x: { hash: h('b') } });
  assert.deepEqual(r.nextHome.pending.y, { since: NOW, expect: 'base' });
});

test('over the cap: nothing new; keeps prev entries whose HEAD hash still matches', () => {
  const shows = {}; const hs = {};
  for (let i = 0; i < 5; i++) { shows[`s${i}`] = mshow(); hs[`s${i}`] = hshow({ hash: h('b') }); }
  const prevHome = { manifestId: 'm1', shows: { s0: { hash: h('b') } }, pending: {} };
  const r = plan({ manifest: manifest(shows), head: head(hs), prevHome, cap: 3 });
  assert.equal(r.outcome, OUTCOMES.CAP);
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.nextHome.shows, { s0: { hash: h('b') } });
  assert.equal(r.counts.eligible, 5);
  assert.equal(plan({ manifest: manifest(shows), head: head(hs), cap: 5 }).outcome, OUTCOMES.PUBLISH, 'exactly the cap is allowed');
});

test('prevHome from another manifest is ignored (restart)', () => {
  const prevHome = { manifestId: 'old', shows: { x: { hash: h('b') }, gone: { hash: h('e') } }, pending: { q: { since: 1, expect: 'base' } } };
  const r = plan({ manifest: manifest(), head: head({ x: hshow({ hash: h('b') }) }), prevHome });
  assert.deepEqual(r.nextHome.shows, { x: { hash: h('b') } });
  assert.deepEqual(r.nextHome.pending, { x: { since: NOW, expect: h('b') } });
});

test('row 11: a published id that is no longer a target leaves home and goes to pending base', () => {
  const prevHome = { manifestId: 'm1', shows: { x: { hash: h('b') }, y: { hash: h('b') }, z: { hash: h('b') } }, pending: {} };
  const r = plan({
    manifest: manifest({ x: mshow(), y: mshow(), z: mshow() }),
    // x reverted to the build hash, y now flagged, z unchanged since the last publish
    head: head({ x: hshow(), y: hshow({ hash: h('c') }), z: hshow({ hash: h('b') }) }),
    prevHome, flagged: ['y'],
  });
  assert.deepEqual(r.nextHome.shows, { z: { hash: h('b') } });
  assert.deepEqual(r.nextHome.pending, { x: { since: NOW, expect: 'base' }, y: { since: NOW, expect: 'base' } });
  assert.equal(r.outcome, OUTCOMES.PUBLISH, 'a removal is a home change');
  assert.deepEqual(r.counts.removed, 2);
});

test('same manifest: unchanged published targets are not re-queued; existing pending entries are kept', () => {
  const prevHome = { manifestId: 'm1', shows: { x: { hash: h('b') } }, pending: { x: { since: 5, expect: h('b') }, old: { since: 4, expect: 'base' } } };
  const r = plan({ manifest: manifest(), head: head({ x: hshow({ hash: h('b') }) }), prevHome });
  assert.equal(r.outcome, OUTCOMES.NOTHING_TO_DO);
  assert.deepEqual(r.targets, [{ id: 'x', hash: h('b') }]);
  assert.deepEqual(r.nextHome.pending, { x: { since: 5, expect: h('b') }, old: { since: 4, expect: 'base' } });
  const r2 = plan({ manifest: manifest(), head: head({ x: hshow({ hash: h('c') }) }), prevHome });
  assert.equal(r2.outcome, OUTCOMES.PUBLISH);
  assert.deepEqual(r2.nextHome.pending.x, { since: NOW, expect: h('c') });
  assert.deepEqual(r2.nextHome.pending.old, { since: 4, expect: 'base' });
});

test('exports the CLI-only outcomes', () => {
  assert.equal(OUTCOMES.KILLED, 'killed');
  assert.equal(OUTCOMES.CAS_LOST, 'cas-lost');
});

test('a renamed show (HEAD slug != build slug) waits for the deploy: the reader would reject its slice', () => {
  const r = plan({ manifest: manifest({ x: mshow({ slug: 'old' }) }), head: head({ x: hshow({ hash: h('b'), slug: 'new' }) }) });
  assert.equal(r.skips.x, SKIPS.SLUG_CHANGED);
  assert.deepEqual(r.targets, []);
  const same = plan({ manifest: manifest({ x: mshow({ slug: 'old' }) }), head: head({ x: hshow({ hash: h('b'), slug: 'old' }) }) });
  assert.deepEqual(same.targets, [{ id: 'x', hash: h('b') }]);
});
