// Owner rule 2026-11-15: Coming Up always lists ALL Broadway openings of the coming week.
// Owner 2026-11-15 (Wanted): a mover card must never show a score readers did not see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectComingUp } = require('../lib/coming-up-select.js');
const { moverBaseline, publishedScoreFor } = require('../lib/mover-baseline.js');

const row = (id, category, eventDate, isPreview = false) => ({ show: { id, category }, eventDate, isPreview });
const WEEK_END = '2026-11-15';

test('screenshot case: 4 Broadway openings survive 6 Off-Broadway rows that sort earlier', () => {
  const items = [
    row('ob1', 'off-broadway', '2026-11-16', true), row('ob2', 'off-broadway', '2026-11-16', true),
    row('ob3', 'off-broadway', '2026-11-17'), row('ob4', 'off-broadway', '2026-11-17', true),
    row('fantasticks', 'broadway', '2026-11-16'), row('bmg', 'broadway', '2026-11-17'),
    row('wonderful-life', 'broadway', '2026-11-18'), row('much-ado', 'broadway', '2026-11-19'),
    row('ob5', 'off-broadway', '2026-11-18'),
  ];
  const ids = selectComingUp(items, { weekEndStr: WEEK_END }).map(it => it.show.id);
  for (const id of ['fantasticks', 'bmg', 'wonderful-life', 'much-ado']) assert.ok(ids.includes(id), `${id} missing: ${ids}`);
});

test('a slate with fewer than the cap is filled with the nearest other rows, date-sorted', () => {
  const items = [row('b1', 'broadway', '2026-11-19'), row('o1', 'off-broadway', '2026-11-16'), row('o2', 'off-broadway', '2026-11-17'),
    row('o3', 'off-broadway', '2026-11-18'), row('o4', 'off-broadway', '2026-11-18')];
  const out = selectComingUp(items, { weekEndStr: WEEK_END });
  assert.deepEqual(out.map(i => i.show.id), ['o1', 'o2', 'o3', 'b1']);
});

test('Broadway previews and Broadway openings beyond the coming week are not mandatory', () => {
  const items = [row('bp', 'broadway', '2026-11-16', true), row('late', 'broadway', '2026-11-29'),
    ...['a', 'b', 'c', 'd'].map((x, i) => row(x, 'off-broadway', `2026-11-1${6 + i}`))];
  const out = selectComingUp(items, { weekEndStr: WEEK_END, cap: 4 });
  assert.equal(out.length, 4);
  assert.ok(!out.some(i => i.show.id === 'late'));
});

const WANTED = { id: 'wanted-2022', openingDate: '2026-11-08' };
const SENT = { 'broadway:wanted-2022': { draftStatus: 'sent', draftNumbers: { 'wanted-2022': { score: 60, reviewCount: 20 } } } };

test('Wanted case: opened the Sunday before the week, so not a mover', () => {
  const r = moverBaseline({ show: WANTED, weekStartStr: '2026-11-09', weekEndStr: '2026-11-15', before: 66, after: 59, publishedScore: null });
  assert.deepEqual(r, { suppress: true, reason: 'opening-window' });
});

test('published score that holds within 3 points is not a mover even outside the opening window', () => {
  const show = { id: 'x', openingDate: '2026-09-01' };
  const r = moverBaseline({ show, weekStartStr: '2026-11-09', weekEndStr: '2026-11-15', before: 66, after: 59, publishedScore: 60 });
  assert.deepEqual(r, { suppress: true, reason: 'published-score-holds' });
});

test('a real move is displayed from the published score, never the recomputed one', () => {
  const show = { id: 'x', openingDate: '2026-09-01' };
  const r = moverBaseline({ show, weekStartStr: '2026-11-09', weekEndStr: '2026-11-15', before: 66, after: 52, publishedScore: 60 });
  assert.deepEqual(r, { suppress: false, before: 60 });
});

test('no published score: the recomputed baseline is used', () => {
  const show = { id: 'x', openingDate: '2026-06-01' };
  assert.deepEqual(moverBaseline({ show, weekStartStr: '2026-11-09', weekEndStr: '2026-11-15', before: 66.4, after: 59, publishedScore: null }), { suppress: false, before: 66 });
});

test('publishedScoreFor reads only sent records', () => {
  assert.equal(publishedScoreFor(SENT, 'wanted-2022'), 60);
  assert.equal(publishedScoreFor({ 'broadway:wanted-2022': { ...SENT['broadway:wanted-2022'], draftStatus: 'draft' } }, 'wanted-2022'), null);
  assert.equal(publishedScoreFor(undefined, 'wanted-2022'), null);
  assert.equal(publishedScoreFor({}, 'wanted-2022'), null);
});
