import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { showsMissingOrigin } = require('../../scripts/lib/show-origins');

const mk = (id, status, openingDate) => ({ id, status, openingDate, category: 'broadway', venue: 'Booth Theatre' });

test('flags opened shows without a record past the grace window', () => {
  const shows = [mk('a', 'open', '2026-09-01'), mk('b', 'closed', '2010-01-01'), mk('c', 'previews', '2026-10-01')];
  const got = showsMissingOrigin(shows, { b: {} }, '2026-10-22').map((s) => s.id);
  assert.deepEqual(got.sort(), ['a', 'c']);
});

test('ignores upcoming, recent openings, pre-2000-07 and labeled shows', () => {
  const shows = [mk('u', 'upcoming', '2026-12-06'), mk('r', 'open', '2026-10-20'), mk('old', 'closed', '1999-01-01'), mk('l', 'open', '2026-01-01')];
  assert.deepEqual(showsMissingOrigin(shows, { l: {} }, '2026-10-22'), []);
});
