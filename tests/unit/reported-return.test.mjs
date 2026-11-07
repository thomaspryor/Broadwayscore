import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { reportedReturn, reportedReturnLabel } = createRequire(import.meta.url)('../../scripts/lib/reported-return.js');

const closed = { status: 'closed', closingDate: '2026-01-18' };
const base = { designation: 'Fizzle', recouped: false, estimatedRecoupmentPct: [55, 60] };

test('trade-stated figure prints range, outlet and month', () => {
  const rr = reportedReturn({ ...base, estimatedRecoupmentSource: 'Broadway Journal reported investors got back 55-60% of the capitalization.', estimatedRecoupmentDate: '2026-10-13' }, closed);
  assert.equal(reportedReturnLabel(rr), 'Investors got back about 55-60% (Broadway Journal, Oct 2026)');
});
test('Reddit-only or inferred source shows nothing', () => {
  assert.equal(reportedReturn({ ...base, estimatedRecoupmentSource: 'Reddit grosses analysis: returned about 55-60%.' }, closed), null);
  assert.equal(reportedReturn({ ...base, estimatedRecoupmentSource: 'Inferred: closed 30 days ago, no trade-press recoupment found' }, closed), null);
});
test('trade outlet that states no figure shows nothing', () => {
  assert.equal(reportedReturn({ ...base, estimatedRecoupmentSource: 'Variety said the show closed at a loss.' }, closed), null);
});
test('open, TBD, recouped and nonprofit shows never print', () => {
  const src = { estimatedRecoupmentSource: 'Deadline: investors got back 55-60% of capitalization.' };
  assert.equal(reportedReturn({ ...base, ...src }, { status: 'open' }), null);
  assert.equal(reportedReturn({ ...base, ...src, designation: 'TBD' }, closed), null);
  assert.equal(reportedReturn({ ...base, ...src, recouped: true }, closed), null);
  assert.equal(reportedReturn({ ...base, ...src, designation: 'Nonprofit' }, closed), null);
  // An enhancement deal has investors to repay, so a reported return prints (BRO-5502).
  assert.notEqual(reportedReturn({ ...base, ...src, designation: 'Nonprofit', productionType: 'enhancement' }, closed), null);
});
test('single value and zero read naturally', () => {
  const rr = reportedReturn({ designation: 'Flop', recouped: false, estimatedRecoupmentPct: [15, 15], estimatedRecoupmentSource: 'BroadwayWorld: it only returned 15% of its investment.' }, closed);
  assert.equal(reportedReturnLabel(rr), 'Investors got back about 15% (BroadwayWorld)');
});
test('a widened stored range prints the source figure, not the range', () => {
  const rr = reportedReturn({ designation: 'Flop', recouped: false, estimatedRecoupmentPct: [10, 20], estimatedRecoupmentSource: 'BroadwayWorld: a show that grossed $1M a week only returned 15% of its investment.' }, closed);
  assert.equal(reportedReturnLabel(rr), 'Investors got back about 15% (BroadwayWorld)');
});
test('a loss percentage is never converted into a return', () => {
  assert.equal(reportedReturn({ designation: 'Flop', recouped: false, estimatedRecoupmentPct: [55, 65], estimatedRecoupmentSource: 'Deadline: producers confirmed a loss of 40% of capitalization.' }, closed), null);
});
test('a stated figure outside the stored range is not printed', () => {
  assert.equal(reportedReturn({ designation: 'Flop', recouped: false, estimatedRecoupmentPct: [10, 20], estimatedRecoupmentSource: 'Deadline: investors got back 60% of capitalization.' }, closed), null);
});

test('outlet must sit with the figure; two outlets and none beside the figure prints nothing', () => {
  const amb = reportedReturn({ designation: 'Flop', recouped: false, estimatedRecoupmentPct: [15, 15], estimatedRecoupmentSource: 'Variety covered the closing. The show only returned 15% of its investment, per a producer. Deadline covered the opening.' }, closed);
  assert.equal(amb, null);
  const ok = reportedReturn({ designation: 'Flop', recouped: false, estimatedRecoupmentPct: [15, 15], estimatedRecoupmentSource: 'Variety covered the closing. Deadline reported the show only returned 15% of its investment.' }, closed);
  assert.equal(reportedReturnLabel(ok), 'Investors got back about 15% (Deadline)');
});

test('real sweep sources: Hell\'s Kitchen range, Cabaret and Death Becomes Her zero', () => {
  const hk = reportedReturn({ designation: 'Fizzle', recouped: false, estimatedRecoupmentPct: [55, 60], estimatedRecoupmentDate: '2026-02-22',
    estimatedRecoupmentSource: 'Broadway Journal (Oct 12, 2026): Alicia Keys told The New York Times that when the show closed on Broadway, "investors had been paid back 60% of their stakes"; one investor told Broadway Journal the figure was 55%.' }, closed);
  assert.equal(reportedReturnLabel(hk), 'Investors got back about 55-60% (Broadway Journal, Oct 2026)');
  const cab = reportedReturn({ designation: 'Flop', recouped: false, estimatedRecoupmentPct: [0, 0],
    estimatedRecoupmentSource: 'Broadway Journal (Sep 7, 2025) reported the production "hasn\'t returned any money to investors, resulting in a total loss to-date," so investors had recouped 0% of the $24.25 million capitalization.' }, closed);
  assert.equal(reportedReturnLabel(cab), 'Investors got back none of their money (Broadway Journal, Sep 2025)');
  const boop = reportedReturn({ designation: 'Flop', recouped: false, estimatedRecoupmentPct: [0, 0],
    estimatedRecoupmentSource: 'The New York Times (Sep 22, 2025) reported Tammy Faye, Boop! and Smash investors lost 100% of their money: "All three lost their entire investments."' }, closed);
  assert.equal(reportedReturnLabel(boop), 'Investors got back none of their money (The New York Times, Sep 2025)');
});
test('Reddit claim beside an outlet name, figures across sentences, and 100% never print', () => {
  const r = (src, pct) => reportedReturn({ designation: 'Flop', recouped: false, estimatedRecoupmentPct: pct, estimatedRecoupmentSource: src }, closed);
  assert.equal(r('Reddit users claim it returned 25%. Variety covered the closing.', [25, 25]), null);
  // Two outlets, two figures: no merged 20-60 range under either name.
  assert.equal(reportedReturnLabel(r('Deadline said it returned 60% of its money. Broadway News said it returned 20% of its money.', [20, 60])), 'Investors got back about 60% (Deadline)');
  assert.equal(r('Deadline reported it returned 100% of its investment.', [100, 100]), null);
  assert.equal(reportedReturnLabel(r('Deadline reported it returned 5% and 10% of its investment.', [5, 10])), 'Investors got back about 5-10% (Deadline)');
});
