/** BRO-5450: a hand-verified, running tour with no matching schedule segment is not a tour-dates problem. */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const { settleHandDatedNoMatch, decideTourDates } = createRequire(import.meta.url)('../../scripts/lib/tour-schedule.js');
const row = (c, v, d) => `<tr><td>${c}</td><td>${v}</td><td>${d}</td><td>x</td></tr>`;
const table = rows => `<table><tr><th>Location</th><th>Venue</th><th>Dates</th><th>Season</th></tr>${rows.join('')}</table>`;
const NOW = new Date('2026-10-16T12:00:00Z');
const hand = { id: 't', title: 'T', openingDate: '2018-12-20', openingDateSource: 'hand-verified', closingDate: null };
const live = table([row('Boston, MA', 'A', 'October 1-13, 2026'), row('Denver, CO', 'B', 'November 3-15, 2026'), row('Dallas, TX', 'C', 'December 1-13, 2026')]);
const ended = table([row('Boston, MA', 'A', 'October 1-13, 2024'), row('Denver, CO', 'B', 'November 3-15, 2024'), row('Dallas, TX', 'C', 'December 1-13, 2024')]);
const decide = html => decideTourDates(hand, html, '', NOW);

test('hand-dated tour, page still lists current stops: problem cleared', () => {
  const d = decide(live);
  assert.strictEqual(d.problem, 'no schedule segment matches this tour');
  assert.strictEqual(settleHandDatedNoMatch(hand, d, live, NOW).problem, undefined);
});
test('hand-dated tour, page lists nothing current: keeps a problem', () => {
  const d = decide(ended);
  assert.match(settleHandDatedNoMatch(hand, d, ended, NOW).problem, /no current or upcoming stops/);
});
test('undated tour keeps the problem', () => {
  const t = { ...hand, openingDate: null };
  const d = decideTourDates(t, live, '', NOW);
  assert.ok(settleHandDatedNoMatch(t, d, live, NOW).problem);
});
test('tour with a closingDate keeps the problem', () => {
  const t = { ...hand, closingDate: '2025-01-01' };
  const d = { write: {}, notes: [], problem: decide(live).problem };
  assert.ok(settleHandDatedNoMatch(t, d, live, NOW).problem);
});
