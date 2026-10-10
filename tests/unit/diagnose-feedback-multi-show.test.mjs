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
