import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./reddit-opening-post');
const mail = require('./reddit-post-email');
const { buildDueReport, dueShows } = require('./reddit-opening-posts-due');

// Historical numeric inputs from run 41941944836, not review text. That run
// started at 00:31Z after the previous hourly run at 18:51Z (BRO-6987).
const show = { id: 'rope-off-broadway-2026', title: 'Rope', category: 'off-broadway', openingDate: '2026-11-03' };
const oldSlim = { cs: 62.83, rc: 10, rv: [] };
const newSlim = { cs: 58.43, rc: 11, rv: [] };
const facts = lib.buildFacts(show, oldSlim, []);
const draft = {
  ...lib.templateDraft(facts), showId: show.id, showTitle: show.title,
  subreddit: facts.subreddit, status: 'ready', source: 'template',
  score: 63, reviewCount: 10, emailedScore: 63, emailedReviewCount: 10,
  createdAt: '2026-11-04T08:03:52.270Z', emailedAt: '2026-11-04T18:59:48.251Z',
  reminderAt: '2026-11-04T18:59:48.251Z', updateCount: 1,
  submitUrl: 'https://www.reddit.com/r/offbroadwayNYC/submit',
};

function options({ prev = draft, current = newSlim, at = '2026-11-05T00:32:05.765Z', meta = {} } = {}) {
  return {
    shows: [show], slims: new Map(current ? [[show.id, current]] : []),
    drafts: { _meta: meta, drafts: { [show.id]: prev } },
    today: at.slice(0, 10), nowMs: Date.parse(at),
  };
}

test('BRO-6987: Rope below the cap is due, with the emailed/current inputs and a warning', () => {
  const input = options();
  assert.equal(lib.updateAllowed(draft, input.nowMs), true);
  assert.deepEqual(dueShows(input), [show.id]);
  const report = buildDueReport(input);
  assert.equal(report.due, true);
  assert.deepEqual(report.ids, [show.id]);
  assert.equal(report.warnings.length, 1);
  assert.match(report.summary, /rope-off-broadway-2026 \| 63\/10 \| 58\/11 \| 5\.5h \| redraft due/);
  assert.match(report.warnings[0], /last send 5\.5h ago/);
  assert.doesNotMatch(report.warnings[0], /stale for/);
});

test('unchanged, posted and expired drafts produce no mismatch warnings', () => {
  const same = buildDueReport(options({ current: oldSlim }));
  assert.equal(same.due, false);
  assert.equal(same.warnings.length, 0);
  assert.match(same.summary, /63\/10 \| 63\/10.*no work due/);
  for (const prev of [{ ...draft, status: 'posted' }, { ...draft, createdAt: '2026-10-01T00:00:00Z' }]) {
    const report = buildDueReport(options({ prev }));
    assert.deepEqual(report.rows, []);
    assert.deepEqual(report.warnings, []);
  }
});

test('the two-hour warning uses the latest send and respects the six-hour update cap', () => {
  assert.equal(buildDueReport(options({ at: '2026-11-04T20:59:48.250Z' })).warnings.length, 0);
  assert.equal(buildDueReport(options({ at: '2026-11-04T20:59:48.251Z' })).warnings.length, 1);
  const recentReminder = { ...draft, reminderAt: '2026-11-05T00:00:00Z' };
  assert.equal(buildDueReport(options({ prev: recentReminder })).warnings.length, 0);
  const capped = { ...draft, updateCount: 3 };
  const held = buildDueReport(options({ prev: capped }));
  assert.equal(held.due, false);
  assert.equal(held.warnings.length, 0, 'normal cap wait is recorded without a warning');
  assert.match(held.summary, /update cap wait/);
  const released = buildDueReport(options({ prev: capped, at: '2026-11-05T00:59:48.251Z' }));
  assert.equal(released.due, true);
  assert.equal(released.warnings.length, 1);
});

test('a redraft awaiting email remains visible, and the send clears the mismatch', () => {
  const liveFacts = lib.buildFacts(show, newSlim, []);
  const refreshed = lib.carryOverState(draft, {
    ...draft, ...lib.templateDraft(liveFacts), score: liveFacts.score, reviewCount: liveFacts.reviewCount,
  }, '2026-11-05T00:37:09.402Z');
  const waiting = buildDueReport(options({ prev: refreshed }));
  assert.deepEqual(waiting.ids, [], 'already redrafted, so only the email is due');
  assert.deepEqual(waiting.emails.map(e => e.kind), ['update']);
  assert.equal(waiting.due, true);
  assert.match(waiting.summary, /63\/10 \| 58\/11.*update email due/);
  const stamp = '2026-11-05T01:02:14.758Z';
  const sent = mail.afterSend(refreshed, mail.stampsFor('update', refreshed, stamp));
  const done = buildDueReport(options({ prev: sent, at: '2026-11-05T01:03:00Z' }));
  assert.equal(done.due, false);
  assert.deepEqual(done.warnings, []);
  assert.match(done.summary, /58\/11 \| 58\/11/);
});

test('missing current numbers, review holds and skipped detection are explicit', () => {
  const missing = buildDueReport(options({ current: null }));
  assert.match(missing.summary, /63\/10 \| unknown.*current numbers unavailable/);
  assert.deepEqual(missing.warnings, [], 'unknown is not a measured mismatch');
  const held = buildDueReport(options({ prev: { ...draft, heldGap: { reason: 'test' } }, meta: { postedDetection: 'skipped' } }));
  assert.match(held.summary, /review gap hold; posted detection skipped/);
  assert.equal(held.warnings.length, 1, 'explain why an allowed update could still be held');
});

test('an unsent new draft stays due without a stale-email warning', () => {
  const prev = { ...draft, emailedAt: undefined, reminderAt: undefined, emailedScore: undefined, emailedReviewCount: undefined };
  const report = buildDueReport(options({ prev, current: oldSlim }));
  assert.equal(report.due, true);
  assert.deepEqual(report.warnings, []);
  assert.match(report.summary, /unknown \| 63\/10 \| never \| new email due/);
});
