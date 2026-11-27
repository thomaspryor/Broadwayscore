import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wasCoveredByWeeklyRoundup, findMissedBroadcasts } = require('../../scripts/lib/missed-broadcasts');
const { pastDeadlineShows } = require('../../scripts/lib/broadcast-deadline');

// RULE21 BRO-8274: the real newsletter state records upcoming links as featured.
// The week ending November 22 mentioned these November 23/24 openings.
const shows = [
  { id: 'the-afronauts-west-end-2026', openingDate: '2026-11-23' },
  { id: 'a-christmas-carol-west-end-2026', openingDate: '2026-11-24' },
  { id: 'the-jungle-book-west-end-2026', openingDate: '2026-11-24' },
].map(s => ({ ...s, category: 'west-end', status: 'open' }));
const newsletterIssues = [{
  weekStart: '2026-11-16', edition: 'west-end', featuredShowIds: shows.map(s => s.id),
}];
const nowMs = Date.parse('2026-11-27T12:00:00Z');

test('the existing two-argument workflow caller resolves the opening date from show data', t => {
  const load = Module._load;
  t.mock.method(Module, '_load', function (request, ...args) {
    if (request === '../../data/shows.json') return { shows };
    return load.call(this, request, ...args);
  });
  assert.equal(wasCoveredByWeeklyRoundup(newsletterIssues, shows[0].id), false);
  const later = [{ ...newsletterIssues[0], weekStart: '2026-11-23' }];
  assert.equal(wasCoveredByWeeklyRoundup(later, shows[0].id), true);
  assert.equal(wasCoveredByWeeklyRoundup(later, shows[0].id, null), false);
  assert.equal(wasCoveredByWeeklyRoundup(later, 'unknown-show'), false);
});

test('upcoming newsletter mentions do not cancel the opening-night draft deadline', () => {
  const due = pastDeadlineShows({ showIds: shows.map(s => s.id), shows, sentShows: {}, newsletterIssues, nowMs });
  assert.deepEqual(due.map(s => s.id), shows.map(s => s.id));
});

test('the missed-broadcast audit keeps paging for qualified shows mentioned before opening', () => {
  const reviews = shows.flatMap(s => Array.from({ length: 12 }, () => ({ showId: s.id, assignedScore: 70 })));
  const missed = findMissedBroadcasts({ shows, reviews, sentShows: {}, newsletterIssues, now: nowMs });
  assert.equal(missed.length, 3);
  assert.ok(missed.every(s => s.state === 'never-drafted' && s.alertable));
});

test('coverage uses the issue Sunday, including month/year boundaries', () => {
  const issues = [{ weekStart: '2026-12-28', edition: 'west-end', featuredShowIds: ['x'] }];
  assert.equal(wasCoveredByWeeklyRoundup(issues, 'x', '2027-01-03'), true);
  assert.equal(wasCoveredByWeeklyRoundup(issues, 'x', '2027-01-04'), false);
  assert.equal(wasCoveredByWeeklyRoundup(issues, 'x', '2026-12-29'), true);
});

test('missing or invalid dates cannot prove review coverage', () => {
  for (const date of [null, '', 'TBA', '2026-02-30', '2026-13-01']) {
    assert.equal(wasCoveredByWeeklyRoundup(newsletterIssues, shows[0].id, date), false, String(date));
    const issues = [{ weekStart: date, edition: 'west-end', featuredShowIds: ['x'] }];
    assert.equal(wasCoveredByWeeklyRoundup(issues, 'x', '2026-11-23'), false, String(date));
  }
});

test('later West End coverage still suppresses a redundant draft, Broadway coverage does not', () => {
  const featuredShowIds = shows.map(s => s.id);
  for (const edition of ['west-end', undefined, 'broadway']) {
    const issues = [...newsletterIssues, { weekStart: '2026-11-23', edition, featuredShowIds }];
    const due = pastDeadlineShows({ showIds: featuredShowIds, shows, sentShows: {}, newsletterIssues: issues, nowMs });
    assert.equal(due.length, edition === 'broadway' ? 3 : 0);
  }
});

test('upcoming mentions never reopen a sent, drafted or deliberately discarded show', () => {
  const sentShows = {
    [shows[0].id]: { completed: true, draftStatus: 'sent', sentAt: '2026-11-25T14:00:00Z' },
    [shows[1].id]: { completed: true, draftStatus: 'draft', draftId: 'existing' },
    [shows[2].id]: { completed: false, discardedAt: '2026-11-25T14:00:00Z' },
  };
  assert.deepEqual(pastDeadlineShows({ showIds: shows.map(s => s.id), shows, sentShows, newsletterIssues, nowMs }), []);
});
