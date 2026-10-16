/** BRO-5450: a hand-verified, running tour with no matching schedule segment is not a problem. */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const { settleHandDatedNoMatch } = createRequire(import.meta.url)('../../scripts/lib/tour-schedule.js');
const P = 'no schedule segment matches this tour';
const hand = { openingDate: '2018-12-20', openingDateSource: 'hand-verified', closingDate: null };

test('hand-dated running tour: problem cleared', () => {
  const r = settleHandDatedNoMatch(hand, { write: {}, notes: ['5 segment(s)'], problem: P });
  assert.strictEqual(r.problem, undefined);
  assert.strictEqual(r.notes.length, 2);
});
test('undated tour keeps the problem', () => {
  assert.strictEqual(settleHandDatedNoMatch({ openingDate: null }, { write: {}, notes: [], problem: P }).problem, P);
});
test('other problems still report', () => {
  const d = { write: {}, notes: [], problem: 'schedule page parsed to zero engagements (layout change or wrong page)' };
  assert.strictEqual(settleHandDatedNoMatch(hand, d).problem, d.problem);
});
