import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { wetArchiveProblem } = require('../../scripts/lib/wet-archive-guard.js');

test('UK regional feeder house (RSC Stratford) is not a non-london-show (BRO-6694)', () => {
  const show = { id: 'x-regional-2026', category: 'regional', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon', openingDate: '2026-08-08' };
  assert.equal(wetArchiveProblem(show, { postDate: '2026-08-09' }), null);
});
test('a US regional row still fails the market check', () => {
  const show = { id: 'y-regional-2024', category: 'regional', venue: 'Goodman Theatre, Chicago', openingDate: '2024-04-17' };
  assert.equal(wetArchiveProblem(show, { postDate: '2024-04-18' }).code, 'non-london-show');
});
test('UK regional still gets the date check', () => {
  const show = { id: 'x', category: 'regional', venue: 'Royal Shakespeare Theatre', openingDate: '2026-08-08' };
  assert.equal(wetArchiveProblem(show, { postDate: '2020-01-01' }).code, 'post-predates-run');
});
test('broadway row and unknown show are flagged', () => {
  assert.equal(wetArchiveProblem({ id: 'b', category: 'broadway' }, {}).code, 'non-london-show');
  assert.equal(wetArchiveProblem(undefined, {}).code, 'unknown-show');
});
