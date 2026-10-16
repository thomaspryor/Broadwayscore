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
  assert.match(B.renderBoardNumbersLines(m).join('\n'), /Waiting on you: 0\nStuck cards: n\/a\nStuck alerts: 0/);
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
    fetchStuck: async () => ({ count: 2 }),
    fetchInflow: async ({ windowDays }) => { seen.push(windowDays); return inflow(windowDays, 1); },
    readLandedFn: () => ({ d1: { codex: 1, claude: 0 }, d7: { codex: 7, claude: 0 } }),
  });
  assert.deepEqual(seen.sort(), [1, 7]);
  assert.equal(d.open.error, 'boom');
  assert.equal(d.stuckCards.count, 2);
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

test('fetchStuckCards filters started cards idle 48h+ and pages', async () => {
  const calls = [];
  const pages = [
    { issues: { pageInfo: { hasNextPage: true, endCursor: 'c' }, nodes: [{ identifier: 'BRO-1', title: 'a' }, { identifier: 'BRO-2', title: 'b' }] } },
    { issues: { pageInfo: { hasNextPage: false }, nodes: [{ identifier: 'BRO-3', title: 'c' }] } },
  ];
  let i = 0;
  const now = new Date('2026-10-16T12:00:00Z');
  const r = await B.fetchStuckCards({ graphql: async (q, v) => { calls.push({ ...v.filter, after: v.after }); return pages[i++]; }, now });
  assert.equal(r.count, 3);
  assert.equal(calls[0].state.type.eq, 'started');
  assert.equal(calls[0].team.key.eq, 'BRO');
  assert.equal(calls[1].after, 'c');
  assert.equal(calls[0].updatedAt.lt, '2026-10-14T12:00:00.000Z');
});

test('stuck cards render n/a when the read fails, a number otherwise', () => {
  const bad = B.buildBoardNumbers({ data: { stuckCards: { error: 'x' } } });
  assert.match(B.renderBoardNumbersLines(bad).join('\n'), /Stuck cards: n\/a\n/);
  const ok = B.buildBoardNumbers({ data: { stuckCards: { count: 12 } } });
  assert.match(B.renderBoardNumbersLines(ok).join('\n'), /Stuck cards: 12 \(In Progress or In Review, no update in 48h\+, not waiting on you\)/);
});

test('fetchStuckCards skips autofix-filed and awaiting-owner cards', async () => {
  const nodes = [
    { identifier: 'BRO-1', title: 'real work', description: '', labels: { nodes: [] } },
    { identifier: 'BRO-2', title: 'BSC Daily: x', description: 'PARKED: x', labels: { nodes: [] } },
    { identifier: 'BRO-3', title: 'needs you', description: '', labels: { nodes: [{ name: 'awaiting-owner' }] } },
  ];
  const r = await B.fetchStuckCards({ graphql: async () => ({ issues: { pageInfo: { hasNextPage: false }, nodes } }) });
  assert.ok(r.count >= 1 && r.count <= 2, `count ${r.count}`);
  assert.ok(r.count < 3);
});

test('stuck-card truncation flags minimums; missing connection throws', async () => {
  const m = B.buildBoardNumbers({ data: { stuckCards: { count: 5, truncated: true } } });
  assert.equal(m.floors, true);
  await assert.rejects(() => B.fetchStuckCards({ graphql: async () => ({}) }), /no issues connection/);
});

test('html has no em dash and escapes', () => {
  const m = B.buildBoardNumbers({ data: { open }, waiting: 1, stuck: 0 });
  const html = B.renderBoardNumbersHtml(m, (s) => String(s).replace(/</g, '&lt;'));
  assert.ok(!html.includes('—'));
  assert.match(html, /Board numbers/);
});

test('BRO-5488: inflow by source reads the Filed-by footer, else title rules, and flags floods', () => {
  const { sourceFooter, titleKind } = require('./card-dedupe.js');
  const gap = (s) => `BSC Daily: Review gap — "${s}" missing 1 cited review(s)`;
  const cards = [
    ...['A', 'B', 'C', 'D'].map((s) => ({ title: gap(s), description: '' })),
    { title: 'Opening-night audit 2026-10-16', description: `x\n\n${sourceFooter('session', titleKind('Opening-night audit'))}` },
    { title: 'main test.yml red: E2E Tests / Run E2E tests', description: '' },
    { title: 'Rollup (workflow:A): k', description: sourceFooter('rollup', 'k') },
  ];
  const s = B.summarizeInflowBySource(cards);
  assert.equal(s.total, 7);
  assert.deepEqual(s.bySource, [
    { source: 'digest-autofix', count: 4 }, { source: 'ci-red', count: 1 }, { source: 'rollup', count: 1 }, { source: 'session', count: 1 },
  ]);
  assert.deepEqual(s.floods, [{ source: 'digest-autofix', kind: 'review gap missing cited', count: 4 }]);
  const m = B.buildBoardNumbers({ data: { d1: inflow(7, 0), bySource: s } });
  const text = B.renderBoardNumbersLines(m).join('\n');
  assert.match(text, /Added: 7 in 24h.*\nAdded in 24h by source: digest-autofix 4, ci-red 1, rollup 1, session 1\nFloods \(3\+ cards of one kind from one filer in 24h\): digest-autofix "review gap missing cited" 4\nCompleted:/);
});

test('BRO-5488: a failed by-source read drops the line instead of printing zeros', () => {
  const m = B.buildBoardNumbers({ data: { bySource: { error: 'boom' } } });
  assert.doesNotMatch(B.renderBoardNumbersLines(m).join('\n'), /by source/);
});
