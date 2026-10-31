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

test('BRO-5110: dropped function words are restored; a content word in the insertion still refuses', () => {
  const shows = [
    { id: 'murder-cathedral-off-west-end-2026', title: 'Murder Cathedral', slug: 'murder-cathedral-off-west-end' },
    { id: 'wives-maids-off-west-end-2026', title: 'Wives Maids', slug: 'wives-maids-off-west-end' },
    { id: 'twenty-thousand-streets-off-west-end-2026', title: 'Twenty Thousand Streets', slug: 'twenty-thousand-streets-off-west-end' },
    { id: 'nero-off-west-end-2026', title: 'Nero', slug: 'nero-off-west-end' },
  ];
  const ok = (id, expectTitle, newTitle) => applyRetitleShow(shows, { id, expectTitle, newTitle, reason: 'slug dropped function words' });
  assert.equal(ok('murder-cathedral-off-west-end-2026', 'Murder Cathedral', 'Murder in the Cathedral').ok, true);
  assert.equal(ok('wives-maids-off-west-end-2026', 'Wives Maids', 'Wives as They Were and Maids as They Are').ok, true);
  // Content words ("Under the Sky") are a different title: the promoter's dated-listing path owns that.
  const content = ok('twenty-thousand-streets-off-west-end-2026', 'Twenty Thousand Streets', 'Twenty Thousand Streets Under the Sky');
  assert.equal(content.ok, false);
  assert.match(content.reason, /not a cosmetic repair/);
  // A one-word title never grows by this rule; reordering is not insertion.
  assert.equal(ok('nero-off-west-end-2026', 'Nero', 'The Nero').ok, false);
  assert.ok(retitleProblem('Murder Cathedral', 'Cathedral in the Murder'), 'out-of-order words refuse');
  assert.deepEqual(shows.map(s => s.title), ['Murder in the Cathedral', 'Wives as They Were and Maids as They Are', 'Twenty Thousand Streets', 'Nero']);
});

test('BRO-5110: restoring function words never lands on a title another row already holds', () => {
  const shows = [
    { id: 'lion-king-off-west-end-2026', title: 'Lion King', slug: 'lion-king-off-west-end' },
    { id: 'the-lion-and-the-king-2019', title: 'The Lion and the King', slug: 'the-lion-and-the-king' },
  ];
  const r = applyRetitleShow(shows, { id: 'lion-king-off-west-end-2026', expectTitle: 'Lion King', newTitle: 'The Lion and the King', reason: 'dropped function words' });
  assert.equal(r.ok, false);
  assert.equal(shows[0].title, 'Lion King');
});

test('a trailing " on Broadway" market tag may be dropped, unless another row holds the bare title', () => {
  assert.equal(retitleProblem('10 Things I Hate About You on Broadway', '10 Things I Hate About You', []), null);
  assert.match(retitleProblem('10 Things I Hate About You on Broadway', '10 Things I Hate About You', ['10 Things I Hate About You']), /not a cosmetic repair/);
  // one-word remainder and a different name still refuse
  assert.match(retitleProblem('Hamilton on Broadway', 'Hamilton', []), /not a cosmetic repair/);
  assert.match(retitleProblem('Wicked on Broadway', 'Gypsy', []), /not a cosmetic repair/);
});

test('the " on Broadway" tag rule matches collisions after normalization and ignores "of Broadway"', () => {
  assert.match(retitleProblem('10 Things I Hate About You on Broadway', '10 Things I Hate About You', ['10 things i hate about you!']), /not a cosmetic repair/);
  assert.match(retitleProblem('Prince of Broadway', 'Prince of', []), /not a cosmetic repair/);
});

test('applyRetitleShow drops the tag only with expectTitle and a reason', () => {
  const mk = () => [{ id: 'ten-2024', title: '10 Things I Hate About You on Broadway' }];
  const act = { id: 'ten-2024', expectTitle: '10 Things I Hate About You on Broadway', newTitle: '10 Things I Hate About You', reason: 'market tag added by feed' };
  const shows = mk();
  assert.equal(applyRetitleShow(shows, act).ok, true);
  assert.equal(shows[0].title, '10 Things I Hate About You');
  const stale = mk();
  assert.equal(applyRetitleShow(stale, { ...act, expectTitle: 'something else' }).ok, false);
  assert.equal(stale[0].title, '10 Things I Hate About You on Broadway');
});
