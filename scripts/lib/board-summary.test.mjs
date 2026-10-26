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
