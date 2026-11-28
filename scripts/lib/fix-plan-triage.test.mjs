import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const t = require('./fix-plan-triage.js');

// A fake world: shows, commercial, review files and the counted set (reviews.json).
function ctx({ shows = {}, retired = [], commercial = {}, files = {}, counted = {}, texts = true } = {}) {
  const urlOf = (rec) => rec && rec.url;
  return {
    hasReviewTexts: texts,
    show: (id) => shows[id] || null,
    isRetired: (id) => retired.includes(id),
    commercial: (slug) => commercial[slug] || null,
    reviewFile: (rel) => files[rel] || null,
    reviewFileForUrl: (showId, url) => Object.keys(files).find((k) => k.startsWith(`${showId}/`) && files[k].url === url) || null,
    isUrlCounted: (showId, url) => (counted[`${showId}|${url}`] || 0) > 0,
    countedEntries: (showId, rec) => counted[`${showId}|${urlOf(rec)}`] || 0,
    isCounted: (showId, rec) => (counted[`${showId}|${urlOf(rec)}`] || 0) > 0,
    sameReview: (_s, a, b) => Boolean(a && b && a.url && a.url === b.url),
    showFiles: (showId) => Object.keys(files).filter((k) => k.startsWith(`${showId}/`)).map((k) => k.split('/')[1]),
  };
}

test('data-edit: resolved when already at newValue, still-needed at oldValue, obsolete otherwise', () => {
  const c = ctx({ shows: { s: { id: 's', openingDate: '2020-01-02' } } });
  const op = (oldValue, newValue) => ({ type: 'data-edit', file: 'shows.json', showId: 's', field: 'openingDate', oldValue, newValue });
  assert.equal(t.classifyOp(op('2020-01-01', '2020-01-02'), c).verdict, t.RESOLVED);
  assert.equal(t.classifyOp(op('2020-01-02', '2020-01-05'), c).verdict, t.STILL_NEEDED);
  assert.equal(t.classifyOp(op('2019-01-01', '2020-01-05'), c).verdict, t.OBSOLETE);
});

test('data-edit on a retired or missing show is obsolete; commercial edits read commercial.json', () => {
  const c = ctx({ retired: ['gone'], commercial: { wanted: { recouped: true } } });
  assert.match(t.classifyOp({ type: 'data-edit', file: 'shows.json', showId: 'gone', field: 'x', newValue: 1 }, c).reason, /retired/);
  assert.equal(t.classifyOp({ type: 'data-edit', file: 'commercial.json', showSlug: 'wanted', field: 'recouped', oldValue: null, newValue: true }, c).verdict, t.RESOLVED);
  assert.equal(t.classifyOp({ type: 'data-edit', file: 'commercial.json', showSlug: 'nope', field: 'recouped', newValue: true }, c).verdict, t.OBSOLETE);
});

test('review exclusion flags are judged by whether the review is counted now', () => {
  const files = { 's/a.json': { url: 'u1', wrongProduction: false }, 's/b.json': { url: 'u2', wrongProduction: true } };
  const c = ctx({ files, counted: { 's|u1': 1 } });
  const flag = (file, newValue) => ({ type: 'review-field-edit', file, field: 'wrongProduction', oldValue: !newValue, newValue });
  assert.equal(t.classifyOp(flag('s/a.json', true), c).verdict, t.STILL_NEEDED, 'counted, should be out');
  assert.equal(t.classifyOp(flag('s/b.json', true), c).verdict, t.RESOLVED, 'already at newValue');
  // Flag value differs, but the review is already out of the score some other way.
  const c2 = ctx({ files: { 's/a.json': { url: 'u1', wrongProduction: false, isNonReview: true } }, counted: {} });
  assert.equal(t.classifyOp(flag('s/a.json', true), c2).verdict, t.RESOLVED);
  // Clearing: counted already is resolved.
  assert.equal(t.classifyOp(flag('s/b.json', false), ctx({ files, counted: { 's|u2': 1 } })).verdict, t.RESOLVED);
});

test('duplicateOf is still-needed only when both copies are counted', () => {
  const dup = (target) => ({ type: 'review-field-edit', file: 's/a.json', field: 'duplicateOf', oldValue: null, newValue: target });
  const both = ctx({ files: { 's/a.json': { url: 'u1' }, 's/b.json': { url: 'u2' } }, counted: { 's|u1': 1, 's|u2': 1 } });
  assert.equal(t.classifyOp(dup('b.json'), both).verdict, t.STILL_NEEDED);
  const targetOut = ctx({ files: { 's/a.json': { url: 'u1' }, 's/b.json': { url: 'u2' } }, counted: { 's|u1': 1 } });
  assert.equal(t.classifyOp(dup('b.json'), targetOut).verdict, t.OBSOLETE);
  const noTarget = ctx({ files: { 's/a.json': { url: 'u1' } }, counted: { 's|u1': 1 } });
  assert.equal(t.classifyOp(dup('b.json'), noTarget).verdict, t.OBSOLETE);
  // Same url: one reviews.json row covers both files, so nothing is double-counted.
  const sameUrl = ctx({ files: { 's/a.json': { url: 'u1' }, 's/b.json': { url: 'u1' } }, counted: { 's|u1': 1 } });
  assert.equal(t.classifyOp(dup('b.json'), sameUrl).verdict, t.RESOLVED);
  const sameUrlTwice = ctx({ files: { 's/a.json': { url: 'u1' }, 's/b.json': { url: 'u1' } }, counted: { 's|u1': 2 } });
  assert.equal(t.classifyOp(dup('b.json'), sameUrlTwice).verdict, t.STILL_NEEDED);
});

test('audit-note fields are settled by a later write; a missing review file is obsolete', () => {
  const c = ctx({ files: { 's/a.json': { url: 'u1', wrongProductionReason: 'newer note' } } });
  assert.equal(t.classifyOp({ type: 'review-field-edit', file: 's/a.json', field: 'wrongProductionReason', oldValue: null, newValue: 'old note' }, c).verdict, t.OBSOLETE);
  assert.equal(t.classifyOp({ type: 'review-field-edit', file: 's/x.json', field: 'criticName', oldValue: 'A', newValue: 'B' }, c).verdict, t.OBSOLETE);
});

test('review ops are unknown without review texts', () => {
  const c = ctx({ texts: false });
  assert.equal(t.classifyOp({ type: 'review-field-edit', file: 's/a.json', field: 'criticName', newValue: 'B' }, c).verdict, t.UNKNOWN);
  assert.equal(t.classifyOp({ type: 'review-file-op', operation: 'move', sourcePath: 's/a.json', destPath: 't/a.json' }, c).verdict, t.UNKNOWN);
});

test('move: done, harmless, or still counted under the wrong show', () => {
  const op = { type: 'review-file-op', operation: 'move', sourcePath: 's/a.json', destPath: 't/a.json' };
  assert.equal(t.classifyOp(op, ctx({ files: { 't/a.json': { url: 'u' } } })).verdict, t.RESOLVED);
  assert.equal(t.classifyOp(op, ctx({ files: { 's/a.json': { url: 'u' }, 't/a.json': { url: 'u' } } })).verdict, t.OBSOLETE);
  const wrong = t.classifyOp(op, ctx({ files: { 's/a.json': { url: 'u' }, 't/a.json': { url: 'u' } }, counted: { 's|u': 1 } }));
  assert.equal(wrong.verdict, t.STILL_NEEDED);
  assert.match(wrong.reason, /still counted under s/);
  assert.equal(t.classifyOp({ type: 'review-file-op', operation: 'delete', sourcePath: 's/a.json' }, ctx()).verdict, t.RESOLVED);
});

test('ingest: resolved when the url is counted or on file; still-needed otherwise', () => {
  const run = (url) => ({ type: 'run-script', script: 'ingest-review-from-url.js', args: `--show=s --url=${url} --stub-on-failure` });
  const c = ctx({ shows: { s: { id: 's' } }, files: { 's/a.json': { url: 'https://x/2', fullText: 'prose' } }, counted: { 's|https://x/1': 1 } });
  assert.equal(t.classifyOp(run('https://x/1'), c).verdict, t.RESOLVED);
  assert.equal(t.classifyOp(run('https://x/2'), c).verdict, t.RESOLVED);
  assert.equal(t.classifyOp(run('https://x/3'), c).verdict, t.STILL_NEEDED);
  assert.equal(t.classifyOp(run('https://x/3'), ctx({ shows: { s: { id: 's' } }, texts: false })).verdict, t.UNKNOWN);
  assert.equal(t.classifyOp({ type: 'ingest-html-handoff', showId: 'gone', url: 'https://x/9' }, c).verdict, t.OBSOLETE);
  assert.deepEqual(t.parseArgs('--show=a --url="https://x/y?z=1" --apply'), { show: 'a', url: 'https://x/y?z=1', apply: true });
});

test('add-show, add-commercial-entry and retire-show compare against current data', () => {
  const c = ctx({ shows: { s: { id: 's' } }, retired: ['r'], commercial: { w: { designation: 'TBD' } } });
  assert.equal(t.classifyOp({ type: 'add-show', show: { id: 's' } }, c).verdict, t.RESOLVED);
  assert.equal(t.classifyOp({ type: 'add-show', show: { id: 'n' } }, c).verdict, t.STILL_NEEDED);
  assert.equal(t.classifyOp({ type: 'add-commercial-entry', slug: 'w', entry: { designation: 'TBD' } }, c).verdict, t.RESOLVED);
  assert.equal(t.classifyOp({ type: 'add-commercial-entry', slug: 'w', entry: { designation: 'Miss' } }, c).verdict, t.OBSOLETE);
  assert.equal(t.classifyOp({ type: 'retire-show', id: 'r' }, c).verdict, t.RESOLVED);
  assert.equal(t.classifyOp({ type: 'retire-show', id: 's' }, c).verdict, t.STILL_NEEDED);
});

test('classifyPlan judges only undone ops of a partial plan, every op of a pending one', () => {
  const c = ctx({ shows: { s: { id: 's', a: 1, b: 2 } } });
  const actions = [
    { type: 'data-edit', file: 'shows.json', showId: 's', field: 'a', oldValue: 0, newValue: 9 },
    { type: 'data-edit', file: 'shows.json', showId: 's', field: 'b', oldValue: 0, newValue: 2 },
  ];
  const partial = t.classifyPlan({ status: 'partial', plan: { actions }, results: [{ ok: true }, { ok: false }] }, c);
  assert.deepEqual(partial.ops.map((o) => o.i), [1]);
  assert.equal(partial.verdict, t.RESOLVED);
  const pending = t.classifyPlan({ status: 'pending', plan: { actions } }, c);
  assert.equal(pending.verdict, t.OBSOLETE, 'op 0 is neither old nor new');
  assert.deepEqual(pending.counts, { obsolete: 1, resolved: 1 });
});

test('reasons never echo review text fields', () => {
  const c = ctx({ files: { 's/a.json': { url: 'u', fullText: 'SECRET PROSE' } } });
  const v = t.classifyOp({ type: 'review-field-edit', file: 's/a.json', field: 'fullText', oldValue: 'x', newValue: 'y' }, c);
  assert.doesNotMatch(v.reason, /SECRET/);
});

test('a missing review file with a likely rename in the same show stays still-needed', () => {
  const c = ctx({ files: { 's/outlet--critic-2.json': { url: 'u' } } });
  const v = t.classifyOp({ type: 'review-field-edit', file: 's/outlet--critic.json', field: 'criticName', oldValue: 'A', newValue: 'B' }, c);
  assert.equal(v.verdict, t.STILL_NEEDED);
  assert.match(v.reason, /looks like a rename/);
});

// Review findings (ship-check, BRO-7092).
test('validation-failed plans: every op is undone, even with ok results', () => {
  const c = ctx({ shows: { s: { id: 's', a: 0 } } });
  const plan = { status: 'validation-failed', plan: { actions: [{ type: 'data-edit', file: 'shows.json', showId: 's', field: 'a', oldValue: 0, newValue: 9 }] }, results: [{ ok: true }] };
  assert.equal(t.classifyPlan(plan, c).verdict, t.STILL_NEEDED);
});

test('a cross-show move whose destination is missing is still-needed even when the source is flagged out', () => {
  const op = { type: 'review-file-op', operation: 'move', sourcePath: 's/a.json', destPath: 't/a.json' };
  assert.equal(t.classifyOp(op, ctx({ files: { 's/a.json': { url: 'u', wrongProduction: true } } })).verdict, t.STILL_NEEDED);
});

test('a ManualClear pin never written stays still-needed', () => {
  const c = ctx({ files: { 's/a.json': { url: 'u' } }, counted: { 's|u': 1 } });
  const v = t.classifyOp({ type: 'review-field-edit', file: 's/a.json', field: 'nonReviewManualClear', oldValue: null, newValue: { by: 'owner' } }, c);
  assert.equal(v.verdict, t.STILL_NEEDED);
});

test('an ingest that only left a retry stub is still-needed', () => {
  const run = { type: 'run-script', script: 'scripts/ingest-review-from-url.js', args: ['--show=s', '--url=https://x/1'] };
  const stub = ctx({ shows: { s: { id: 's' } }, files: { 's/a.json': { url: 'https://x/1', contentTier: 'stub' } } });
  assert.equal(t.classifyOp(run, stub).verdict, t.STILL_NEEDED);
  const real = ctx({ shows: { s: { id: 's' } }, files: { 's/a.json': { url: 'https://x/1', fullText: 'prose', isNonReview: true } } });
  assert.equal(t.classifyOp(run, real).verdict, t.RESOLVED);
});

test('review reasons never echo prose from excerpt or note fields', () => {
  const c = ctx({ files: { 's/a.json': { url: 'u', lboRoundupExcerpt: 'PROSE ONE', wrongProductionReason: 'The critic wrote PROSE TWO' } } });
  for (const [field, oldValue] of [['lboRoundupExcerpt', 'x'], ['wrongProductionReason', 'y']]) {
    const v = t.classifyOp({ type: 'review-field-edit', file: 's/a.json', field, oldValue, newValue: 'z' }, c);
    assert.doesNotMatch(v.reason, /PROSE/);
  }
});

test('data-edit on a file with no rule is left for a person', () => {
  assert.equal(t.classifyOp({ type: 'data-edit', file: 'audience-buzz.json', showId: 's', field: 'title', newValue: 'x' }, ctx({ shows: { s: { id: 's', title: 'x' } } })).verdict, t.STILL_NEEDED);
});

test('restore-body and copy-multishow-section are judged from the review files', () => {
  const files = { 's/a.json': { url: 'u', fullText: 'prose' }, 's/b.json': { url: 'v', contentTier: 'stub' }, 't/col.json': { url: 'w', fullText: 'prose' } };
  const c = ctx({ shows: { t: { id: 't' }, x: { id: 'x' } }, files });
  const restore = (f) => ({ type: 'run-script', script: 'restore-released-quarantined-body.js', args: `--file=${f} --apply` });
  assert.equal(t.classifyOp(restore('s/a.json'), c).verdict, t.RESOLVED);
  assert.equal(t.classifyOp(restore('s/b.json'), c).verdict, t.STILL_NEEDED);
  const copy = (to) => ({ type: 'run-script', script: 'copy-multishow-section.js', args: `--from=o/col.json --to-show=${to} --apply` });
  assert.equal(t.classifyOp(copy('t'), c).verdict, t.RESOLVED);
  assert.equal(t.classifyOp(copy('x'), c).verdict, t.STILL_NEEDED);
  assert.equal(t.classifyOp(copy('gone'), c).verdict, t.OBSOLETE);
  assert.equal(t.classifyOp(copy('t'), ctx({ texts: false })).verdict, t.UNKNOWN);
});
