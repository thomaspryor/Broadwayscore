import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { overdueAlertAt, draftDeadlineAt, pastDeadlineShows } = require('./broadcast-deadline.js');

const at = (iso) => Date.parse(iso);
const bway = (id, openingDate) => ({ id, openingDate, category: 'broadway' });

test('deadline is 14:00 UTC the day after opening (10am EDT)', () => {
  assert.equal(draftDeadlineAt('2026-09-28').toISOString(), '2026-09-29T14:00:00.000Z');
});

test('deadline crosses month and year boundaries', () => {
  assert.equal(draftDeadlineAt('2026-09-30').toISOString(), '2026-10-01T14:00:00.000Z');
  assert.equal(draftDeadlineAt('2026-12-31').toISOString(), '2027-01-01T14:00:00.000Z');
});

test('winter (EST) opening uses the same UTC anchor (9am EST)', () => {
  assert.equal(draftDeadlineAt('2027-01-14').toISOString(), '2027-01-15T14:00:00.000Z');
});

test('overdue alert keeps the old inline definition (openingDate+T04:00Z, +1 day)', () => {
  assert.equal(overdueAlertAt('2026-09-28').toISOString(), '2026-09-29T04:00:00.000Z');
  assert.ok(overdueAlertAt('2026-09-28') < draftDeadlineAt('2026-09-28'), 'owner is paged before any gate is overridden');
});

test('a timestamped openingDate uses its calendar date', () => {
  assert.equal(draftDeadlineAt('2026-09-28T19:00:00Z').toISOString(), '2026-09-29T14:00:00.000Z');
});

test('overdue alert matches the old inline math across month, year and EST boundaries', () => {
  const oldInline = (d) => { const x = new Date(d + 'T04:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString(); };
  for (const d of ['2026-09-28', '2026-09-30', '2026-12-31', '2027-01-14', '2028-02-28', '2028-02-29']) {
    assert.equal(overdueAlertAt(d).toISOString(), oldInline(d), d);
  }
});

test('a sent (completed) broadcast is never forced', () => {
  const shows = [bway('a', '2026-09-28')];
  const sentShows = { a: { completed: true, draftStatus: 'sent', sentAt: '2026-09-29T20:00:00Z' } };
  assert.deepEqual(pastDeadlineShows({ showIds: ['a'], shows, sentShows, nowMs: at('2026-09-30T20:00:00Z') }), []);
});

test('a show with no category is treated as Broadway (not subject to the Round-up rule)', () => {
  const shows = [{ id: 'nocat', openingDate: '2026-09-28' }];
  const newsletterIssues = [{ edition: 'west-end', featuredShowIds: ['nocat'] }];
  assert.equal(pastDeadlineShows({ showIds: ['nocat'], shows, sentShows: {}, newsletterIssues, nowMs: at('2026-09-30T12:00:00Z') }).length, 1);
});

test('unparseable opening dates never trip the deadline', () => {
  for (const bad of [null, undefined, '', 'TBA', '2026-13-45x', 'Fall 2026']) {
    assert.equal(draftDeadlineAt(bad), null, String(bad));
  }
});

test('School Girls replay: 13:36 not yet past, 15:03 past', () => {
  const shows = [bway('school-girls', '2026-09-28')];
  const sentShows = { 'school-girls': { lastOverdueAlertAt: '2026-09-29T13:39:18.221Z' } };
  assert.deepEqual(pastDeadlineShows({ showIds: ['school-girls'], shows, sentShows, nowMs: at('2026-09-29T13:36:00Z') }), []);
  assert.deepEqual(
    pastDeadlineShows({ showIds: ['school-girls'], shows, sentShows, nowMs: at('2026-09-29T15:03:00Z') }),
    [{ id: 'school-girls', deadlineAt: '2026-09-29T14:00:00.000Z' }],
  );
});

test('exactly at the deadline counts as past', () => {
  const shows = [bway('a', '2026-09-28')];
  assert.equal(pastDeadlineShows({ showIds: ['a'], shows, sentShows: {}, nowMs: at('2026-09-29T14:00:00Z') }).length, 1);
});

test('a healthy completed draft is never re-forced', () => {
  const shows = [bway('a', '2026-09-28')];
  const sentShows = { a: { completed: true, draftStatus: 'draft', draftCreatedAt: '2026-09-29T18:50:29Z' } };
  assert.deepEqual(pastDeadlineShows({ showIds: ['a'], shows, sentShows, nowMs: at('2026-09-30T20:00:00Z') }), []);
});

test('a cancelled draft past the requeue cooldown is owed again', () => {
  const shows = [bway('a', '2026-09-28')];
  const sentShows = { a: { completed: true, draftStatus: 'cancelled', draftCreatedAt: '2026-09-28T00:00:00Z' } };
  assert.equal(pastDeadlineShows({ showIds: ['a'], shows, sentShows, nowMs: at('2026-09-30T20:00:00Z') }).length, 1);
});

test('West End covered by the Weekly Round-up is not forced (BRO-3088)', () => {
  const shows = [{ id: 'we', openingDate: '2026-09-28', category: 'west-end' }];
  const newsletterIssues = [{ edition: 'west-end', featuredShowIds: ['we'] }];
  const nowMs = at('2026-09-30T12:00:00Z');
  assert.deepEqual(pastDeadlineShows({ showIds: ['we'], shows, sentShows: {}, newsletterIssues, nowMs }), []);
  assert.equal(pastDeadlineShows({ showIds: ['we'], shows, sentShows: {}, nowMs }).length, 1);
});

test('empty ids and unknown shows are ignored, fresh shows stay out of the batch', () => {
  const shows = [bway('old', '2026-09-27'), bway('fresh', '2026-09-29')];
  const got = pastDeadlineShows({ showIds: ['', 'ghost', 'old', 'fresh'], shows, sentShows: {}, nowMs: at('2026-09-29T20:00:00Z') });
  assert.deepEqual(got.map(g => g.id), ['old']);
});
