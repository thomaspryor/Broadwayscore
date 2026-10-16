'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('./board-numbers.js');

const open = { total: 551, byPriority: { 1: 1, 2: 39, 3: 265, 4: 239, 0: 7 } };
const inflow = (created, completed, canceled = 0, extra = {}) => ({ created, completed, canceled, ...extra });

test('buildBoardNumbers shapes open rows, windows, lanes', () => {
  const m = B.buildBoardNumbers({
    data: { open, d1: inflow(87, 53, 4), d7: inflow(548, 300), landed1: { codex: 3, claude: 9 }, landed7: { codex: 10, claude: 40 } },
    waiting: 2, stuck: 1,
  });
  assert.equal(m.open.total, 551);
  assert.deepEqual(m.open.rows.map((r) => r.count), [1, 39, 265, 239, 7]);
  assert.deepEqual(m.added, { d1: 87, d7: 548 });
  assert.deepEqual(m.completed, { d1: 53, d7: 300 });
  assert.equal(m.waiting, 2);
  assert.equal(m.stuck, 1);
  assert.equal(m.floors, false);
});

test('waiting and stuck pass through untouched (single definition)', () => {
  const m = B.buildBoardNumbers({ data: {}, waiting: 0, stuck: 0 });
  assert.equal(m.waiting, 0);
  assert.equal(m.stuck, 0);
  assert.match(B.renderBoardNumbersLines(m).join('\n'), /Waiting on you: 0\nStuck alerts: 0/);
});

test('failed reads render n/a, never 0', () => {
  const m = B.buildBoardNumbers({ data: { open: { error: 'x' }, d1: { error: 'x' }, d7: inflow(5, 2), landed1: null } });
  const text = B.renderBoardNumbersLines(m).join('\n');
  assert.match(text, /Open cards: n\/a/);
  assert.match(text, /Added: n\/a in 24h, 5 in 7 days/);
  assert.match(text, /Waiting on you: n\/a/);
  assert.match(text, /Landed on main, 24h: n\/a/);
});

test('truncated walk marks counts as minimums', () => {
  const m = B.buildBoardNumbers({ data: { d7: inflow(10, 5, 0, { truncated: true, truncatedCounts: ['created'] }) } });
  assert.equal(m.floors, true);
  assert.match(B.renderBoardNumbersLines(m).join('\n'), /minimums/);
});

test('fetchOpenByPriority pages and buckets unknown priority as none', async () => {
  const pages = [
    { issues: { pageInfo: { hasNextPage: true, endCursor: 'c' }, nodes: [{ priority: 1 }, { priority: 3 }] } },
    { issues: { pageInfo: { hasNextPage: false }, nodes: [{ priority: 0 }, { priority: null }, { priority: 4 }] } },
  ];
  let i = 0;
  const r = await B.fetchOpenByPriority({ graphql: async () => pages[i++] });
  assert.equal(r.total, 5);
  assert.deepEqual(r.byPriority, { 1: 1, 2: 0, 3: 1, 4: 1, 0: 2 });
});

test('fetchBoardNumbersData asks for 1 and 7 day windows and survives one failure', async () => {
  const seen = [];
  const d = await B.fetchBoardNumbersData({
    graphql: null,
    fetchOpen: async () => { throw new Error('boom'); },
    fetchInflow: async ({ windowDays }) => { seen.push(windowDays); return inflow(windowDays, 1); },
    readLandedFn: () => ({ d1: { codex: 1, claude: 0 }, d7: { codex: 7, claude: 0 } }),
  });
  assert.deepEqual(seen.sort(), [1, 7]);
  assert.equal(d.open.error, 'boom');
  assert.deepEqual(d.landed7, { codex: 7, claude: 0 });
});

test('readLanded splits 24h and 7d from one log', () => {
  const now = 1_000_000_000_000;
  const t = (h) => Math.floor(now / 1000) - h * 3600;
  const log = `${t(2)}\tCodex runner\tfix(BRO-1): a\n${t(30)}\tClaude\tfeat(BRO-2): b\n${t(3)}\tClaude\tBRO-3\n${t(1)}\tbot\tBRO-9\n`;
  const exec = (cmd, args) => (args[0] === 'log' ? log : 'false');
  assert.deepEqual(B.readLanded({ exec, nowMs: now }), { d1: { codex: 1, claude: 1 }, d7: { codex: 1, claude: 2 } });
});

test('open-walk truncation alone does not flag minimums; shown-count truncation does', () => {
  const a = B.buildBoardNumbers({ data: { d7: inflow(10, 5, 0, { truncated: true, truncatedCounts: ['open'] }) } });
  assert.equal(a.floors, false);
  const b = B.buildBoardNumbers({ data: { d7: inflow(10, 5, 0, { truncated: true, truncatedCounts: ['created'] }) } });
  assert.equal(b.floors, true);
});

test('readLanded is null when a shallow clone could not be deepened', () => {
  const exec = (cmd, args) => { if (args[0] === 'fetch') throw new Error('net'); return 'true'; };
  assert.equal(B.readLanded({ exec }), null);
});

test('html has no em dash and escapes', () => {
  const m = B.buildBoardNumbers({ data: { open }, waiting: 1, stuck: 0 });
  const html = B.renderBoardNumbersHtml(m, (s) => String(s).replace(/</g, '&lt;'));
  assert.ok(!html.includes('—'));
  assert.match(html, /Board numbers/);
});
