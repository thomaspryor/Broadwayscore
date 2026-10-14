// BRO-4505: the retitle-show plan action, required from the real module (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { applyRetitleShow, retitleProblem } = require('./retitle-show-action.js');

const rows = () => [
  { id: 'king-lear-2-off-west-end-2026', title: 'King Lear 2', slug: 'king-lear-2-off-west-end' },
  { id: 'richard-ii-off-west-end-2026', title: 'Richard Ii', slug: 'richard-ii-off-west-end' },
  { id: 'king-lear-2019', title: 'King Lear', slug: 'king-lear' },
  { id: 'cloud-9-2026', title: 'Cloud 9', slug: 'cloud-9' },
];

test('cosmetic repairs apply: case fix, trailing slug counter; id and slug untouched', () => {
  const shows = rows();
  const a = applyRetitleShow(shows, { id: 'king-lear-2-off-west-end-2026', expectTitle: 'King Lear 2', newTitle: 'King Lear', reason: 'slug counter' });
  assert.equal(a.ok, true, a.reason);
  const b = applyRetitleShow(shows, { id: 'richard-ii-off-west-end-2026', expectTitle: 'Richard Ii', newTitle: 'Richard II', reason: 'roman numeral' });
  assert.equal(b.ok, true, b.reason);
  assert.deepEqual(shows.map(s => [s.id, s.title, s.slug]), [
    ['king-lear-2-off-west-end-2026', 'King Lear', 'king-lear-2-off-west-end'],
    ['richard-ii-off-west-end-2026', 'Richard II', 'richard-ii-off-west-end'],
    ['king-lear-2019', 'King Lear', 'king-lear'],
    ['cloud-9-2026', 'Cloud 9', 'cloud-9'],
  ]);
  assert.equal(retitleProblem("Hells Kitchen", "Hell's Kitchen"), null);
  assert.equal(retitleProblem('Amelie', 'Amélie'), null);
  assert.match(retitleProblem('Room 101', 'Room'), /not a cosmetic repair/);
  assert.match(retitleProblem('Apartment 23', 'Apartment 2'), /not a cosmetic repair/);
  // A number that is part of the name has no bare-title twin, or is a Part N.
  assert.match(applyRetitleShow(rows(), { id: 'cloud-9-2026', expectTitle: 'Cloud 9', newTitle: 'Cloud', reason: 'x' }).reason, /not a cosmetic repair/);
  assert.match(retitleProblem("A Doll's House, Part 2", "A Doll's House, Part", ["A Doll's House, Part"]), /not a cosmetic repair/);
});

test('refuses a renamed show, a stale expectTitle, a missing reason or a no-op; nothing changes', () => {
  const cases = [
    [{ id: 'king-lear-2-off-west-end-2026', expectTitle: 'King Lear 2', newTitle: 'Hamlet', reason: 'x' }, /not a cosmetic repair/],
    [{ id: 'king-lear-2-off-west-end-2026', expectTitle: 'King Lear 2', newTitle: 'King Lear 3', reason: 'x' }, /not a cosmetic repair/],
    [{ id: 'king-lear-2-off-west-end-2026', expectTitle: 'King Lear 2', newTitle: 'King', reason: 'x' }, /not a cosmetic repair/],
    [{ id: 'king-lear-2-off-west-end-2026', expectTitle: 'King Lear', newTitle: 'King Lear', reason: 'x' }, /plan expected/],
    [{ id: 'king-lear-2-off-west-end-2026', expectTitle: 'King Lear 2', newTitle: 'King Lear 2', reason: 'x' }, /equals the current/],
    [{ id: 'king-lear-2-off-west-end-2026', expectTitle: 'King Lear 2', newTitle: ' King Lear', reason: 'x' }, /trimmed/],
    [{ id: 'king-lear-2-off-west-end-2026', expectTitle: 'King Lear 2', newTitle: 'King Lear' }, /reason/],
    [{ id: 'nope-2026', expectTitle: 'X', newTitle: 'Y', reason: 'x' }, /no show/],
  ];
  for (const [action, re] of cases) {
    const shows = rows();
    const r = applyRetitleShow(shows, action);
    assert.equal(r.ok, false, String(re));
    assert.match(r.reason, re);
    assert.deepEqual(shows, rows());
  }
});

test('execute-approved-fix dispatches retitle-show and validates shows.json after it', () => {
  const src = readFileSync(new URL('../execute-approved-fix.js', import.meta.url), 'utf8');
  assert.match(src, /case 'retitle-show':\s*\n\s*result = executeRetitleShow\(action\)/);
  assert.match(src, /a\.type === 'retitle-show'/);
  assert.match(src, /'retitle-show': 'shows\.json'/);
});
