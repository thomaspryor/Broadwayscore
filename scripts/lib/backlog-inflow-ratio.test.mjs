// BRO-3017. Colocated test for the backlog inflow ratio row in the morning
// digest. It require()s the real module (CLAUDE.md rule 15) — no restated
// thresholds, no second copy of the query text — so a production change to
// the policy fails here instead of drifting silently past.
//
// The plan this implements asked specifically for BOTH directions to be
// tested: a healthy ratio must NOT alarm. A row that is red every morning is
// a row the owner stops reading, which is how 21 email-worker alerts went
// unheeded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INFLOW_WINDOW_DAYS,
  OK_MAX_RATIO,
  WATCH_MAX_RATIO,
  MIN_CREATED_FOR_ALARM,
  buildInflowCountQuery,
  windowStart,
  buildCreatedFilter,
  buildCompletedFilter,
  buildCanceledFilter,
  buildOpenFilter,
  countMatching,
  fetchInflowCounts,
  assessInflowRatio,
} from './backlog-inflow-ratio.js';
import { TERMINAL_STATE_TYPES } from './linear-state-types.js';

// ---------------------------------------------------------------- verdicts

test('healthy ratio does NOT alarm', () => {
  const r = assessInflowRatio({ created: 10, completed: 12, canceled: 0, open: 40, windowDays: 7 });
  assert.equal(r.status, 'ok');
  assert.ok(r.message.includes('Holding'), r.message);
  assert.ok(!/⚠|NOTHING|growing/.test(r.message), r.message);
});

test('a green row still speaks — absence must never be the healthy signal', () => {
  // The whole failure this metric exists to end is a number nobody saw. A
  // status that renders nothing when fine is indistinguishable from a dead
  // collector, so `ok` must still carry a message.
  const r = assessInflowRatio({ created: 3, completed: 9, open: 12, windowDays: 7 });
  assert.equal(r.status, 'ok');
  assert.ok(r.message && r.message.length > 0);
});

test('exactly at the ok ceiling is still ok, just past it is not', () => {
  const at = assessInflowRatio({ created: OK_MAX_RATIO * 10, completed: 10, windowDays: 7 });
  assert.equal(at.status, 'ok');
  const past = assessInflowRatio({ created: OK_MAX_RATIO * 10 + 1, completed: 10, windowDays: 7 });
  assert.notEqual(past.status, 'ok');
});

test('exactly at the watch ceiling is watch, just past it is error', () => {
  const at = assessInflowRatio({ created: WATCH_MAX_RATIO * 10, completed: 10, windowDays: 7 });
  assert.equal(at.status, 'watch');
  const past = assessInflowRatio({ created: WATCH_MAX_RATIO * 10 + 1, completed: 10, windowDays: 7 });
  assert.equal(past.status, 'error');
});

test('the real 2026-09-07 measurement lands as error', () => {
  // 324 filed / 101 closed in the 7 days to 2026-09-07, measured live by
  // paginated query WITH archived issues included. If a future threshold
  // change makes THIS look healthy, that change is wrong.
  const r = assessInflowRatio({ created: 324, completed: 101, canceled: 3, open: 1074, windowDays: 7 });
  assert.equal(r.status, 'error');
  assert.equal(r.ratio, 3.2);
  assert.ok(r.message.includes('1074 open'), r.message);
  assert.ok(r.message.includes('3 more canceled'), r.message);
});

test('the per-week rate is normalized to the window, not the raw delta', () => {
  // The first version printed the in-window delta and labelled it "a week",
  // so a 1-day sample of +43 read as "43 issues a week" when it is 301.
  const day = assessInflowRatio({ created: 85, completed: 42, windowDays: 1 });
  assert.ok(day.message.includes('301 issues a week'), day.message);
  const week = assessInflowRatio({ created: 324, completed: 101, windowDays: 7 });
  assert.ok(week.message.includes('223 issues a week'), week.message);
  const month = assessInflowRatio({ created: 1137, completed: 60, windowDays: 30 });
  assert.ok(month.message.includes('251 issues a week'), month.message);
});

test('cancels never improve the ratio', () => {
  // Canceling an issue does not do the work. If cancels counted as closures a
  // mass triage sweep could make a 4.4:1 week read as healthy — the exact
  // incentive that would make this metric lie.
  const without = assessInflowRatio({ created: 100, completed: 10, canceled: 0, windowDays: 7 });
  const withMany = assessInflowRatio({ created: 100, completed: 10, canceled: 500, windowDays: 7 });
  assert.equal(without.ratio, withMany.ratio);
  assert.equal(without.status, withMany.status);
  assert.ok(withMany.message.includes('500 more canceled'), withMany.message);
});

test('nothing filed and nothing closed is quiet, not broken', () => {
  const r = assessInflowRatio({ created: 0, completed: 0, open: 5, windowDays: 7 });
  assert.equal(r.status, 'ok');
  assert.equal(r.ratio, null);
});

test('a few filed with none closed is watch, not an emergency', () => {
  const r = assessInflowRatio({ created: MIN_CREATED_FOR_ALARM - 1, completed: 0, windowDays: 7 });
  assert.equal(r.status, 'watch');
});

test('many filed with none closed is an error', () => {
  const r = assessInflowRatio({ created: MIN_CREATED_FOR_ALARM, completed: 0, windowDays: 7 });
  assert.equal(r.status, 'error');
  assert.equal(r.ratio, null);
  assert.ok(r.message.includes('NOTHING closed'), r.message);
});

test('a truncated count is reported as a floor, never as the answer', () => {
  // An under-count can only ever make the board look healthier than it is.
  const r = assessInflowRatio({ created: 250, completed: 250, open: 250, windowDays: 7, truncated: true });
  assert.equal(r.status, 'unknown');
  assert.ok(/page limit/.test(r.message), r.message);
  assert.ok(/worse/.test(r.message), r.message);
});

test('missing or unusable counts return unknown with no message', () => {
  for (const bad of [null, undefined, {}, { created: 5 }, { created: 'x', completed: 1 }]) {
    const r = assessInflowRatio(bad);
    assert.equal(r.status, 'unknown');
    assert.equal(r.message, null);
  }
});

test('window wording is driven by the window, not hardcoded', () => {
  assert.ok(assessInflowRatio({ created: 2, completed: 2, windowDays: 1 }).message.includes('in the last 1 day '));
  assert.ok(assessInflowRatio({ created: 2, completed: 2, windowDays: 7 }).message.includes('in the last 7 days '));
  assert.ok(assessInflowRatio({ created: 0, completed: 0, windowDays: 1 }).message.includes('in the last 1 day.'));
});

// ----------------------------------------------------------------- filters

test('the open filter excludes ALL THREE terminal state types', () => {
  // BRO-2466: a hand-rolled completed/canceled pair re-counted 19 duplicate
  // issues as open. This asserts against the shared constant, so a fourth
  // terminal type added there is inherited here.
  const f = buildOpenFilter();
  assert.deepEqual(f.state.type.nin, TERMINAL_STATE_TYPES);
  assert.ok(TERMINAL_STATE_TYPES.includes('duplicate'));
});

test('closure is counted from completedAt, cancels from canceledAt', () => {
  const since = '2026-09-01T00:00:00.000Z';
  assert.deepEqual(buildCompletedFilter(since).completedAt, { gte: since });
  assert.deepEqual(buildCanceledFilter(since).canceledAt, { gte: since });
  assert.deepEqual(buildCreatedFilter(since).createdAt, { gte: since });
  for (const f of [buildCompletedFilter(since), buildCanceledFilter(since), buildCreatedFilter(since)]) {
    assert.deepEqual(f.team, { key: { eq: 'BRO' } });
  }
});

test('windowStart walks back exactly windowDays from now', () => {
  const now = new Date('2026-09-08T00:00:00.000Z');
  assert.equal(windowStart(now, 7), '2026-09-01T00:00:00.000Z');
  assert.equal(windowStart(now), windowStart(now, INFLOW_WINDOW_DAYS));
});

// ------------------------------------------------------------- pagination

test('closures are counted WITH archived issues, open issues WITHOUT', async () => {
  // linear-archive-done.js archives every Done/Canceled issue older than 48h.
  // Linear's issues connection hides archived issues by default, so counting
  // closures without includeArchived drops everything closed more than two
  // days ago — live on 2026-09-07 that hid 41 of 101 closures and reported
  // 4.4:1 for a board running 3.2:1. This is the regression guard.
  const seen = [];
  const graphql = async (_q, vars) => {
    seen.push({ filter: vars.filter, includeArchived: vars.includeArchived });
    return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
  };
  await fetchInflowCounts({ graphql, now: new Date('2026-09-08T00:00:00.000Z') });
  const flagFor = (key) => seen.find((s) => key in s.filter).includeArchived;
  assert.equal(flagFor('createdAt'), true);
  assert.equal(flagFor('completedAt'), true);
  assert.equal(flagFor('canceledAt'), true);
  assert.equal(flagFor('state'), false); // the open count
});

test('the query the module sends actually paginates and can include archives', () => {
  // The 250-cap is what made 1,072 open issues first read as "250". A query
  // without a cursor argument or pageInfo cannot walk past page one, so this
  // asserts the real string, not a description of it.
  const q = buildInflowCountQuery();
  assert.ok(q.includes('$after: String'), q);
  assert.ok(q.includes('after: $after'), q);
  assert.ok(q.includes('hasNextPage'), q);
  assert.ok(q.includes('endCursor'), q);
  assert.ok(q.includes('$includeArchived: Boolean'), q);
  assert.ok(q.includes('includeArchived: $includeArchived'), q);
});

test('countMatching walks every page and sums them', async () => {
  const pages = [
    { nodes: Array(250).fill({ id: 'a' }), pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { nodes: Array(250).fill({ id: 'b' }), pageInfo: { hasNextPage: true, endCursor: 'c2' } },
    { nodes: Array(72).fill({ id: 'c' }), pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const cursors = [];
  let i = 0;
  const graphql = async (_q, vars) => {
    cursors.push(vars.after);
    return { issues: pages[i++] };
  };
  const r = await countMatching({ graphql, filter: {} });
  assert.equal(r.count, 572); // NOT 250
  assert.equal(r.truncated, false);
  assert.deepEqual(cursors, [null, 'c1', 'c2']);
});

test('countMatching stops at maxPages and says the count is truncated', async () => {
  const graphql = async () => ({ issues: { nodes: Array(250).fill({ id: 'x' }), pageInfo: { hasNextPage: true, endCursor: 'more' } } });
  const r = await countMatching({ graphql, filter: {}, maxPages: 3 });
  assert.equal(r.pages, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.count, 750);
});

test('countMatching throws rather than reporting zero when Linear returns junk', async () => {
  // Silently counting a malformed response as 0 would render "nothing filed
  // and nothing closed" — a green row over a broken read.
  await assert.rejects(() => countMatching({ graphql: async () => ({}), filter: {} }), /issues connection/);
});

test('fetchInflowCounts issues the four counts and propagates truncation', async () => {
  const seen = [];
  const graphql = async (_q, vars) => {
    seen.push(vars.filter);
    const n = seen.length;
    return {
      issues: {
        nodes: Array(n).fill({ id: 'x' }),
        // Only the 4th walk (open) needs a second page, and it stops at maxPages.
        pageInfo: { hasNextPage: n === 4, endCursor: 'c' },
      },
    };
  };
  const counts = await fetchInflowCounts({ graphql, now: new Date('2026-09-08T00:00:00.000Z'), maxPages: 1 });
  assert.equal(counts.created, 1);
  assert.equal(counts.completed, 2);
  assert.equal(counts.canceled, 3);
  assert.equal(counts.open, 4);
  assert.equal(counts.truncated, true);
  assert.equal(counts.since, '2026-09-01T00:00:00.000Z');
  assert.equal(counts.windowDays, INFLOW_WINDOW_DAYS);
  assert.ok('createdAt' in seen[0]);
  assert.ok('completedAt' in seen[1]);
  assert.ok('canceledAt' in seen[2]);
  assert.ok('state' in seen[3]);
});
