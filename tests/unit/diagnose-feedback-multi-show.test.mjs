// BRO-2362 / issue #515: a report naming TWO shows with the same bug must
// resolve BOTH show IDs in the diagnose step and must not auto-close as
// COMPLETED unless every named show was fixed. Exercises the real resolver
// (extractShowTitlesFromText + resolveShowMatches) the diagnose step uses,
// then the real multishow helpers. Fixture catalog keeps it data-independent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveShowMatches, extractShowTitlesFromText } = require('../../scripts/lib/resolve-show.js');
const {
  resolveShowsForDiagnosis,
  summarizeShowFixOutcomes,
} = require('../../scripts/lib/feedback-multishow.js');

const catalog = [
  { id: '3-summers-of-lincoln-regional-2025', title: '3 Summers of Lincoln', venue: 'A', city: 'X' },
  { id: 'the-family-album-regional-2026', title: 'The Family Album', venue: 'B', city: 'Y' },
  { id: 'hamilton-broadway-2015', title: 'Hamilton', venue: 'C', city: 'New York' },
];
const message = '3 Summers of Lincoln and The Family Album both list the wrong city for their venue.';

// Mirrors diagnoseBug's resolution loop (extract titles, load every match).
function resolveIds(msg) {
  const ids = [];
  for (const name of extractShowTitlesFromText(msg, catalog)) {
    for (const s of resolveShowMatches(name, catalog)) if (!ids.includes(s.id)) ids.push(s.id);
  }
  return ids;
}

test('message naming two shows resolves both show IDs', () => {
  const ids = resolveIds(message);
  assert.deepEqual(ids.sort(), [
    '3-summers-of-lincoln-regional-2025',
    'the-family-album-regional-2026',
  ]);
});

test('unrelated show in catalog is not pulled in', () => {
  assert.ok(!resolveIds(message).includes('hamilton-broadway-2015'));
});

test('diagnosis carries both shows through to resolved shows', () => {
  const r = resolveShowsForDiagnosis({ resolvedShowIds: resolveIds(message) }, catalog);
  assert.equal(r.resolvedShows.length, 2);
  assert.deepEqual(r.unresolvedShowIds, []);
});

test('fixing only one of two shows is partial, never fixed', () => {
  const [a, b] = catalog;
  const out = summarizeShowFixOutcomes([
    { show: a, applied: ['city -> Lincoln'] },
    { show: b, applied: [], skipped: ['no change'] },
  ]);
  assert.equal(out.action, 'partial');
  assert.match(out.comment, /The Family Album/);
});

test('fixing both shows is fixed', () => {
  const [a, b] = catalog;
  const out = summarizeShowFixOutcomes([
    { show: a, applied: ['x'] },
    { show: b, applied: ['y'] },
  ]);
  assert.equal(out.action, 'fixed');
});

// BRO-7594 / issue #1187: the show field matched three productions of one
// title, only one still running, plus a different title from the message.
// Narrow the same-title siblings to the live one; carry other titles through.
const revivals = [
  { id: 'awake-and-sing-1984', title: 'Awake and Sing!', status: 'closed' },
  { id: 'awake-and-sing-2006', title: 'Awake and Sing!', status: 'closed' },
  { id: 'awake-and-sing-2026', title: 'Awake and Sing!', status: 'previews' },
  { id: 'gemini-1977', title: 'Gemini', status: 'closed' },
];
const allIds = revivals.map((s) => s.id);
const base = { ambiguousShow: true, submitterShow: 'Awake and Sing!', resolvedShowIds: allIds };

test('one live sibling among closed ones narrows; other titles are kept', () => {
  const r = resolveShowsForDiagnosis(base, revivals);
  assert.equal(r.ambiguous, false);
  assert.deepEqual(r.showIds, ['awake-and-sing-2026', 'gemini-1977']);
  assert.deepEqual(r.narrowedFrom, ['awake-and-sing-1984', 'awake-and-sing-2006']);
});

test('a kept second title still blocks a "fixed" verdict when only one was fixed', () => {
  const r = resolveShowsForDiagnosis(base, revivals);
  const out = summarizeShowFixOutcomes(r.resolvedShows.map((x, i) => ({ show: x.show, applied: i === 0 ? ['runtime cleared'] : [] })));
  assert.notEqual(out.action, 'fixed');
});

test('no show field means no narrowing', () => {
  const r = resolveShowsForDiagnosis({ ...base, submitterShow: null }, revivals);
  assert.equal(r.ambiguous, true);
});

test('a sibling with unknown status blocks narrowing', () => {
  const cat = revivals.map((s) => (s.id === 'awake-and-sing-1984' ? { ...s, status: undefined } : s));
  assert.equal(resolveShowsForDiagnosis(base, cat).ambiguous, true);
});

test('two live siblings stay ambiguous', () => {
  const cat = revivals.map((s) => (s.id === 'awake-and-sing-2006' ? { ...s, status: 'open' } : s));
  assert.equal(resolveShowsForDiagnosis(base, cat).ambiguous, true);
});

test('all siblings closed stays ambiguous', () => {
  const cat = revivals.map((s) => ({ ...s, status: 'closed' }));
  assert.equal(resolveShowsForDiagnosis(base, cat).ambiguous, true);
});
