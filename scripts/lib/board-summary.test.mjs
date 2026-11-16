import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { bucketDailyFlow, dayKeys, boardVerdict, tilesFor, renderBoardSummaryHtml, fetchDailyFlow } = require('./board-summary.js');
const { buildBoardNumbers } = require('./board-numbers.js');

const NOW = new Date('2026-10-24T11:30:00Z'); // 07:30 New York, when the digest goes out

test('dayKeys: the last 7 full New York days, oldest first, never today', () => {
  const keys = dayKeys(NOW);
  assert.equal(keys.length, 7);
  assert.equal(keys[0], '2026-10-17');
  assert.equal(keys[6], '2026-10-23');
});

test('dayKeys: a DST change (New York falls back 2026-11-01) neither skips nor repeats a day', () => {
  const keys = dayKeys(new Date('2026-11-03T12:30:00Z'));
  assert.deepEqual(keys, ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

test('bucketDailyFlow: buckets by New York date; closed = completed or canceled; outside the window and today are dropped', () => {
  const rows = bucketDailyFlow([
    { createdAt: '2026-10-23T03:30:00Z' }, // 23:30 NY on the 22nd
    { createdAt: '2026-10-23T05:00:00Z' }, // 01:00 NY on the 23rd
    { createdAt: '2026-10-23T10:00:00Z', completedAt: '2026-10-23T12:00:00Z' },
    { createdAt: '2026-10-10T10:00:00Z', canceledAt: '2026-10-20T10:00:00Z' },
    { createdAt: '2026-10-24T05:00:00Z' }, // 01:00 NY today: not charted
  ], { now: NOW });
  const by = Object.fromEntries(rows.map((r) => [r.day, r]));
  assert.deepEqual(by['2026-10-23'], { day: '2026-10-23', added: 2, closed: 1, canceled: 0 });
  assert.deepEqual(by['2026-10-20'], { day: '2026-10-20', added: 0, closed: 1, canceled: 1 });
  assert.equal(by['2026-10-22'].added, 1);
  assert.equal(rows.reduce((a, r) => a + r.added, 0), 3);
});

const model = (over = {}) => ({ ...buildBoardNumbers({ data: {}, waiting: 1, stuck: 3 }), open: { total: 534, rows: [] }, ...over });

test('boardVerdict: closing at least as many as added is "Keeping up"; otherwise "Falling behind", with the pile change', () => {
  const up = boardVerdict(model(), [{ day: 'd', added: 579, closed: 587 }]);
  assert.equal(up.tone, 'good');
  assert.equal(up.headline, 'Keeping up');
  assert.match(up.sentence, /587 cards were closed and 579 were added, so the open pile is about 8 smaller \(534 open now\)\./);
  const down = boardVerdict(model(), [{ day: 'd', added: 120, closed: 100 }]);
  assert.equal(down.tone, 'warn');
  assert.match(down.sentence, /about 20 bigger/);
});

test('boardVerdict: canceled cards are named, and a partial walk drops the confident tone', () => {
  const v = boardVerdict(model(), [{ day: 'd', added: 5, closed: 205, canceled: 200 }]);
  assert.match(v.sentence, /205 cards were closed \(200 of them canceled, not done\)/);
  const p = boardVerdict(model(), [{ day: 'd', added: 5, closed: 9 }], { partial: true });
  assert.equal(p.tone, null);
  assert.match(p.sentence, /minimums/);
});

test('boardVerdict: no chart data falls back to the 7-day counts; no counts at all says so instead of guessing', () => {
  const m = model({ added: { d1: 1, d7: 10 }, completed: { d1: 1, d7: 6 }, canceled: { d1: 0, d7: 1 } });
  assert.equal(boardVerdict(m, null).headline, 'Falling behind');
  assert.equal(boardVerdict(model(), null).tone, null);
});

test('tilesFor: missing data reads n/a, never 0; nothing waiting reads "Nothing"', () => {
  const t = tilesFor(model({ waiting: 0, stuckCards: null, lanes: { d1: null, d7: null }, cost: null }));
  assert.equal(t[0][1], 'n/a');
  assert.equal(t[1][1], 'Nothing');
  assert.equal(t[2][1], 'n/a');
  assert.equal(t[3][1], 'n/a');
  assert.equal(tilesFor(model({ waiting: null }))[1][2], 'could not be read');
  const c = tilesFor(model({ cost: { claude: { sessions: 0 }, codex: { usd: 91.4 } } }));
  assert.equal(c[3][1], '$91');
  assert.match(c[3][2], /Claude spend not recorded/);
});

test('renderBoardSummaryHtml: escapes text, shows one chart row per day, and omits the chart without data', () => {
  const daily = dayKeys(NOW).map((day, i) => ({ day, added: i, closed: 7 - i }));
  const html = renderBoardSummaryHtml(model(), daily, (s) => String(s).replace(/</g, '&lt;'), { now: NOW });
  assert.match(html, /How the board is doing/);
  assert.equal((html.match(/\+\d+ \/ &minus;\d+/g) || []).length, 7);
  assert.doesNotMatch(renderBoardSummaryHtml(model(), null), /Cards added vs closed/);
});

test('fetchDailyFlow: pages through Linear and reports truncation at the page cap', async () => {
  let calls = 0;
  const graphql = async () => { calls++; return { issues: { nodes: [{ createdAt: '2026-10-23T10:00:00Z' }], pageInfo: { hasNextPage: true, endCursor: `c${calls}` } } }; };
  const r = await fetchDailyFlow({ graphql, now: NOW, maxPages: 3 });
  assert.equal(calls, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.days.find((d) => d.day === '2026-10-23').added, 3);
});

test('tilesFor: a stuck count cut off by the page cap reads as a minimum', () => {
  assert.equal(tilesFor(model({ stuckCards: 24, stuckCardsFloor: true }))[2][1], '24+ cards');
  assert.equal(tilesFor(model({ stuckCards: 1, stuckCardsFloor: false }))[2][1], '1 card');
});

test('renderBoardSummaryHtml: fills use background-color; Gmail drops the background shorthand (BRO-6164)', () => {
  const daily = dayKeys(NOW).map((day, i) => ({ day, added: i, closed: 7 - i }));
  for (const [name, d] of [['with chart', daily], ['without chart', null]]) {
    const html = renderBoardSummaryHtml(model(), d, (s) => String(s), { now: NOW });
    assert.doesNotMatch(html, /background:/, `${name}: no background shorthand`);
    assert.match(html, /background-color:#/, `${name}: fills are present, so the check is not vacuous`);
  }
});

// BRO-6442: the board category table in the morning email.
const { renderBoardCategoriesHtml } = require('./board-summary.js');
const bc = require('./board-categories.js');

function sampleReport() {
  const base = { priority: 2, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', labels: { nodes: [] }, comments: { nodes: [] }, description: '## Acceptance criteria\nVERIFY: node --test scripts/lib/foo.test.mjs' };
  return bc.categorizeBoard([
    { ...base, identifier: 'BRO-1', title: 'A <b>bold</b> title', state: { name: 'Todo', type: 'unstarted' } },
    { ...base, identifier: 'BRO-2', title: 'Two', state: { name: 'In Progress', type: 'started' } },
    { ...base, identifier: 'BRO-3', title: 'Three', state: { name: 'Paused', type: 'backlog' }, priority: 4 },
  ], { now: NOW });
}

test('renderBoardCategoriesHtml: every category row, totals, email-safe, no ids or titles', () => {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = renderBoardCategoriesHtml(sampleReport(), null, esc);
  for (const c of bc.CATEGORIES) assert.ok(html.includes(esc(c.label)), c.label);
  assert.match(html, /Total open<\/td><td[^>]*>3</);
  assert.doesNotMatch(html, /<svg|<style|class=|BRO-\d|bold/);
  assert.doesNotMatch(html, /change since/);
  assert.match(html, /white-space:nowrap/);
});

test('renderBoardCategoriesHtml: change since the last email when a snapshot exists', () => {
  const report = sampleReport();
  const prev = bc.snapshotOf(report);
  prev.open = 5;
  prev.categories.find((c) => c.key === 'paused').exclusive = 3;
  const html = renderBoardCategoriesHtml(report, prev);
  assert.match(html, /change since the last morning email/);
  assert.match(html, /\(-2\)/); // paused 3 -> 1, open 5 -> 3
  assert.equal((html.match(/\(-2\)/g) || []).length, 3); // paused row, its group subtotal, open total
  assert.doesNotMatch(html, /\(\+0\)|\(0\)/);
});

test('renderBoardCategoriesHtml: a failed fetch shows a visible unavailable line', () => {
  const html = renderBoardCategoriesHtml(null, null);
  assert.match(html, /Board table unavailable this morning/);
});

test('renderBoardCategoriesHtml: a malformed snapshot renders without deltas instead of throwing', () => {
  const html = renderBoardCategoriesHtml(sampleReport(), { categories: { nope: 1 }, open: 'x' });
  assert.match(html, /Every open card, once/);
  assert.doesNotMatch(html, /change since/);
});

// BRO-6870
test('renderBoardCategoriesHtml: four group headings with subtotals that add to the total; no stale Other footnote', () => {
  const r = sampleReport();
  const html = renderBoardCategoriesHtml(r, null);
  for (const g of bc.GROUPS) assert.ok(html.includes(g.title), g.title);
  const groups = bc.groupBoard(r);
  assert.equal(groups.reduce((a, g) => a + g.exclusive, 0), r.totals.exclusive);
  assert.doesNotMatch(html, /in Other (is|are) held for you/);
  assert.doesNotMatch(html, /VERIFY|Codex|cloud worker/i);
});

test('Stuck tile uses the board table started-idle number when the table exists', () => {
  const { boardStartedIdle } = require('../send-morning-digest.js');
  const r = bc.categorizeBoard([{ identifier: 'BRO-9', title: 't', priority: 3, description: '', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', labels: { nodes: [] }, comments: { nodes: [] }, state: { name: 'In Progress', type: 'started' } }], { now: NOW });
  assert.equal(boardStartedIdle(r), 1);
  assert.equal(boardStartedIdle(null), null);
  const tile = tilesFor(model({ stuckCards: 16, stuckCardsFloor: false }), { startedIdle: boardStartedIdle(r) })[2];
  assert.equal(tile[1], '1 card');
  assert.equal(tilesFor(model({ stuckCards: 16 }), { startedIdle: null })[2][1], '16 cards');
});

// BRO-7595: the morning headline counted every card, so test alarms and sessions' own
// tracking cards inflated both bars, and ~50 shipped fixes parked for a later check
// read as "Falling behind" with no explanation.
test('BRO-7595: bucketDailyFlow leaves out test alarms, duplicates and quick session tracking cards', () => {
  const rows = bucketDailyFlow([
    { title: '[E2E Canary] alarm', createdAt: '2026-10-23T14:00:00Z', canceledAt: '2026-10-23T15:00:00Z' },
    { title: 'Track this session', description: 'Filed by: session (kind: fix)', createdAt: '2026-10-22T14:00:00Z', completedAt: '2026-10-22T16:00:00Z' },
    { title: 'Same as BRO-1', state: { name: 'Duplicate' }, createdAt: '2026-10-21T14:00:00Z', canceledAt: '2026-10-21T15:00:00Z' },
    { title: 'Real fix', description: 'Filed by: session (kind: fix)', createdAt: '2026-10-20T14:00:00Z', completedAt: '2026-10-22T14:00:00Z' },
    { title: 'Real alert', description: 'Filed by: ci-red', createdAt: '2026-10-23T14:00:00Z' },
  ], { now: NOW });
  assert.equal(rows.reduce((a, r) => a + r.added, 0), 2, 'only the real fix and the real alert count as added');
  assert.equal(rows.reduce((a, r) => a + r.closed, 0), 1, 'only the real fix counts as closed');
  assert.equal(rows.reduce((a, r) => a + r.canceled, 0), 0);
});

test('BRO-7595: fetchDailyFlow asks Linear for the fields the bookkeeping rule needs', () => {
  const { DAILY_FLOW_QUERY } = require('./board-summary.js');
  for (const f of ['title', 'description', 'state { name }']) assert.ok(DAILY_FLOW_QUERY.includes(f), f);
});

const paused = (stamp, createdAt = '2026-10-22T10:00:00Z', where = 'comment') => ({
  identifier: 'BRO-1', title: 'x', createdAt, state: { name: 'Paused', type: 'backlog' },
  description: where === 'notes' ? `RECHECK-AFTER: ${stamp}` : 'notes',
  comments: { nodes: where === 'comment' ? [{ body: `Paused.\nRECHECK-AFTER: ${stamp}`, createdAt }] : [] },
});

test('BRO-7595: summarizeAwaitingCheck splits Paused check-date cards into waiting and overdue', () => {
  const { summarizeAwaitingCheck } = require('./board-summary.js');
  const r = summarizeAwaitingCheck([
    paused('2026-11-05'), // waiting, added this week
    paused('2026-11-05', '2026-09-01T10:00:00Z', 'notes'), // waiting, added before the window
    paused('2026-10-20'), // overdue
    paused('2026-10-24'), // today (UTC): still due tonight, so waiting
    { ...paused('2026-11-05'), state: { name: 'Todo', type: 'unstarted' } }, // handed off, not waiting
    { ...paused('x'), description: '', comments: { nodes: [] } }, // no stamp
  ], { now: NOW });
  assert.deepEqual(r, { waiting: 3, overdue: 1, waitingAddedInWindow: 2 });
});

test('BRO-7595: growth made only of waiting fixes is a middle tone, never green; overdue checks keep the warning', () => {
  const m = (awaitingCheck) => model({ awaitingCheck });
  const daily = [{ day: 'd', added: 248, closed: 220, canceled: 20 }];
  const steady = boardVerdict(m({ waiting: 60, overdue: 3, waitingAddedInWindow: 40, truncated: false }), daily);
  assert.equal(steady.tone, 'steady');
  assert.match(steady.headline, /waiting for their check/);
  assert.match(steady.sentence, /40 of the added cards are fixes already shipped and waiting for their check date\./);
  assert.match(steady.sentence, /3 cards are past their check date/);
  const overdue = boardVerdict(m({ waiting: 60, overdue: 38, waitingAddedInWindow: 40, truncated: false }), daily);
  assert.equal(overdue.tone, 'warn');
  assert.match(overdue.sentence, /38 cards are past their check date/);
  const realGrowth = boardVerdict(m({ waiting: 5, overdue: 0, waitingAddedInWindow: 5, truncated: false }), daily);
  assert.equal(realGrowth.headline, 'Falling behind');
  assert.equal(boardVerdict(m(null), daily).headline, 'Falling behind', 'no awaiting data: unchanged verdict');
  assert.equal(boardVerdict(m({ waiting: 60, overdue: 0, waitingAddedInWindow: 40, truncated: true }), daily).tone, 'warn', 'a truncated read is not trusted');
  assert.equal(boardVerdict(m({ waiting: 60, overdue: 0, waitingAddedInWindow: 40 }), [{ day: 'd', added: 5, closed: 9 }]).tone, 'good');
  const html = renderBoardSummaryHtml(m({ waiting: 60, overdue: 3, waitingAddedInWindow: 40, truncated: false }), [{ ...daily[0], day: '2026-10-23' }]);
  assert.match(html, /#e8f0fa/);
});

test('BRO-7595: fetchBoardNumbersData reads the awaiting-check count last and buildBoardNumbers carries it', async () => {
  const { fetchBoardNumbersData } = require('./board-numbers.js');
  const order = [];
  const stub = (name, val = {}) => async () => { order.push(name); return val; };
  const data = await fetchBoardNumbersData({
    graphql: async () => ({}), now: NOW, cwd: process.cwd(), readLandedFn: () => null,
    fetchInflow: stub('inflow'), fetchOpen: stub('open', { error: 'n/a' }), fetchStuck: stub('stuck'), fetchBySource: stub('bySource'),
    fetchParked: stub('parked'), fetchOpus: stub('opus'), fetchCost: stub('cost'), fetchDaily: stub('daily', { days: [] }),
    fetchAwaiting: stub('awaiting', { waiting: 2, overdue: 1, waitingAddedInWindow: 1, truncated: false }),
  });
  assert.equal(order[order.length - 1], 'awaiting');
  assert.deepEqual(buildBoardNumbers({ data }).awaitingCheck, { waiting: 2, overdue: 1, waitingAddedInWindow: 1, truncated: false });
  const failed = await fetchBoardNumbersData({
    graphql: async () => ({}), now: NOW, cwd: process.cwd(), readLandedFn: () => null,
    fetchInflow: stub('inflow'), fetchOpen: stub('open', { error: 'n/a' }), fetchStuck: stub('stuck'), fetchBySource: stub('bySource'),
    fetchParked: stub('parked'), fetchOpus: stub('opus'), fetchCost: stub('cost'), fetchDaily: stub('daily'),
    fetchAwaiting: async () => { throw new Error('429'); },
  });
  assert.equal(buildBoardNumbers({ data: failed }).awaitingCheck, null, 'a failed read is fail-soft');
});

test('BRO-7595: the awaiting-check query reads the newest comments, where a re-pause stamp lands', () => {
  assert.match(require('./board-summary.js').AWAITING_CHECK_QUERY, /comments\(last: 50, orderBy: createdAt\)/);
});
