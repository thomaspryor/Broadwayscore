import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  applyDepartureToCast,
  addArrivalToCast,
  buildHistoryEntryFromDeparture,
  buildHistoryEntryFromExpiredArrival,
} = require('./cast-changes-apply.js');

test('applyDepartureToCast removes ALL role-text-variant entries for the departing person', () => {
  // Regression fixture for the Daniel Radcliffe P0 (2026-07-21): 4 currentCast
  // entries for the same actor under different scraped role text, and a
  // departure event whose role string matches none of them exactly.
  const currentCast = [
    { name: 'Daniel Radcliffe', role: 'Narrator/Protagonist', since: '2026-03-12' },
    { name: 'Daniel Radcliffe', role: 'nameless protagonist', since: '2026-03-12' },
    { name: 'Daniel Radcliffe', role: 'Nameless protagonist', since: '2026-02-21' },
    { name: 'Daniel Radcliffe', role: 'Protagonist (nameless)', since: '2026-02-21' },
    { name: 'Tracee Ellis Ross', role: 'Narrator/Protagonist', since: '2026-07-07' },
  ];
  const event = { name: 'Daniel Radcliffe', role: 'Narrator', date: '2026-05-24' };
  const { currentCast: after, removed } = applyDepartureToCast(currentCast, event);
  assert.equal(after.length, 1);
  assert.equal(after[0].name, 'Tracee Ellis Ross');
  assert.equal(removed.length, 4);
});

test('applyDepartureToCast is a no-op when the person is not in currentCast', () => {
  const currentCast = [{ name: 'Tracee Ellis Ross', role: 'Narrator/Protagonist', since: '2026-07-07' }];
  const { currentCast: after, removed } = applyDepartureToCast(currentCast, { name: 'Mariska Hargitay', role: 'X', date: '2026-07-05' });
  assert.equal(after.length, 1);
  assert.equal(removed.length, 0);
});

test('addArrivalToCast skips when the person is already cast under different role text', () => {
  const currentCast = [{ name: 'Daniel Radcliffe', role: 'Nameless protagonist', since: '2026-02-21' }];
  const event = { name: 'Daniel Radcliffe', role: 'Narrator/Protagonist', date: '2026-03-12' };
  const { currentCast: after, added } = addArrivalToCast(currentCast, event);
  assert.equal(added, false);
  assert.equal(after.length, 1, 'must not create a duplicate entry for the same person');
});

test('addArrivalToCast adds a new person', () => {
  const currentCast = [{ name: 'Daniel Radcliffe', role: 'Narrator/Protagonist', since: '2026-02-21' }];
  const event = { name: 'Mariska Hargitay', role: 'Narrator/Protagonist', date: '2026-05-26' };
  const { currentCast: after, added } = addArrivalToCast(currentCast, event);
  assert.equal(added, true);
  assert.equal(after.length, 2);
  assert.ok(after.some(c => c.name === 'Mariska Hargitay' && c.since === '2026-05-26'));
});

test('buildHistoryEntryFromDeparture captures the stint window', () => {
  const member = { name: 'Daniel Radcliffe', role: 'Narrator/Protagonist', since: '2026-02-21' };
  const event = { date: '2026-05-24', note: 'Final bow', sourceUrl: 'https://playbill.com/x', sourceType: 'playbill' };
  const entry = buildHistoryEntryFromDeparture(member, event);
  assert.deepEqual(entry, {
    name: 'Daniel Radcliffe',
    role: 'Narrator/Protagonist',
    since: '2026-02-21',
    until: '2026-05-24',
    note: 'Final bow',
    sourceUrl: 'https://playbill.com/x',
    sourceType: 'playbill',
  });
});

test('buildHistoryEntryFromExpiredArrival preserves a stint discovered after it already ended', () => {
  // Regression: the Mariska Hargitay P0 — her whole EBT run (arrival AND
  // departure) was discovered by the scraper after both dates had already
  // passed, and the old code discarded the arrival event with no trace.
  const event = {
    name: 'Mariska Hargitay',
    role: 'Narrator/Protagonist',
    date: '2026-05-26',
    endDate: '2026-07-05',
    note: 'Broadway debut; limited engagement succeeding Daniel Radcliffe.',
    sourceUrl: 'https://playbill.com/article/mariska-hargitay-makes-broadway-debut-in-every-brilliant-thing-beginning-may-26',
    sourceType: 'playbill',
  };
  const entry = buildHistoryEntryFromExpiredArrival(event);
  assert.equal(entry.name, 'Mariska Hargitay');
  assert.equal(entry.since, '2026-05-26');
  assert.equal(entry.until, '2026-07-05');
});
