'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('./board-numbers.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDispatchLedgers } = require('./board-targeting-sources.js');

const open = { total: 551, byPriority: { 1: 1, 2: 39, 3: 265, 4: 239, 0: 7 } };
const inflow = (created, completed, canceled = 0, extra = {}) => ({ created, completed, canceled, ...extra });

test('BRO-6090: separate ceremony from Added/Completed and show the matching 7-day daily averages', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const session = { description: 'Filed by: session (kind: fix)', createdAt: '2026-10-24T01:00:00Z', completedAt: '2026-10-24T03:00:00Z' };
  const nodes = [
    { title: '[E2E Canary] alert chain check', ...session },
    { title: 'Opening-night watch 2026-10-23', ...session },
    { title: 'Opening-night audit 2026-10-23', ...session },
    { title: 'CANARY: touch data/audit/canary.marker', ...session },
    { title: 'Week in Review, 2026-10-17 to 2026-10-24', ...session },
    { title: 'Fix search', ...session },
    { title: 'Fast automated repair', ...session, description: 'Filed by: digest-autofix (kind: fix)' },
    { title: 'Older session work', ...session, createdAt: '2026-10-23T01:00:00Z' },
    { title: 'Still open', createdAt: session.createdAt, description: session.description },
    { title: 'Prior week work', createdAt: '2026-10-20T01:00:00Z' },
    { title: 'Canceled test', createdAt: session.createdAt, canceledAt: session.completedAt, description: session.description },
  ];
  const graphql = async (query, { filter }) => {
    assert.match(query, /includeArchived: true/);
    for (const field of ['title', 'description', 'createdAt', 'completedAt', 'canceledAt']) assert.ok(query.includes(field));
    assert.equal(filter.team.key.eq, 'BRO');
    assert.equal(filter.or.length, 3);
    return { issues: { nodes, pageInfo: { hasNextPage: false } } };
  };
  const d1 = await B.fetchBoardInflowCounts({ graphql, now, windowDays: 1 });
  const d7 = await B.fetchBoardInflowCounts({ graphql, now, windowDays: 7 });
  assert.deepEqual([d1.created, d1.completed, d1.canceled], [2, 2, 1]);
  assert.deepEqual([d7.created, d7.completed], [4, 2]);
  assert.deepEqual(d1.excluded.created, { canary: 1, routineLog: 4, sessionTracking: 2, duplicate: 0 });
  assert.deepEqual(d1.excluded.completed, { canary: 1, routineLog: 4, sessionTracking: 1, duplicate: 0 });
  const m = B.buildBoardNumbers({ data: { d1, d7, bySource: B.summarizeInflowBySource(nodes, { now }) } });
  const lines = B.renderBoardNumbersLines(m).join('\n');
  assert.match(lines, /Added: 2 in 24h \(7-day average 0\.6\/day\), 4 in 7 days/);
  assert.match(lines, /Completed: 2 in 24h \(7-day average 0\.3\/day\), 2 in 7 days/);
  assert.match(lines, /Added test alarms: 1 in 24h, 1 in 7 days/);
  assert.match(lines, /Added routine logs: 4 in 24h, 4 in 7 days/);
  assert.match(lines, /Added session self-tracking \(closed within 6h\): 2 in 24h, 2 in 7 days/);
  assert.match(lines, /Completed session self-tracking \(closed within 6h\): 1 in 24h, 1 in 7 days/);
  assert.match(lines, /Added in 24h by source: session 2, digest-autofix 1, unknown 1/);
  assert.match(B.renderBoardNumbersHtml(m), /7-day average 0\.6\/day/);
});

test('BRO-6090: session cutoff is inclusive, requires session provenance and valid closure timestamps', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const base = { title: 'Session work', description: 'Filed by: session (kind: fix)', createdAt: '2026-10-24T00:00:00Z' };
  const nodes = [
    { ...base, completedAt: '2026-10-24T06:00:00Z' },
    { ...base, completedAt: '2026-10-24T06:00:00.001Z' },
    { ...base, completedAt: '2026-10-23T23:59:59Z' },
    { ...base, createdAt: '2026-10-24T11:00:00Z', completedAt: '2026-10-24T13:00:00Z' },
    { ...base, completedAt: 'bad date' },
    { ...base, updatedAt: '2026-10-24T01:00:00Z' },
    { ...base, description: '', completedAt: '2026-10-24T01:00:00Z' },
    { ...base, description: 'Filed by: alert-router (kind: fix)', completedAt: '2026-10-24T01:00:00Z' },
    { ...base, title: 'Fix Opening-night watch 2026-10-23', description: '' },
    { ...base, title: 'Week in Review rendering is broken', description: '' },
  ];
  const r = B.summarizeBoardFlow(nodes, { now, windowDays: 1 });
  assert.deepEqual([r.created, r.completed], [9, 4]);
  assert.deepEqual(r.excluded.created, { canary: 0, routineLog: 0, sessionTracking: 1, duplicate: 0 });
  assert.equal(B.summarizeInflowBySource(nodes, { now }).total, 9);
});

test('BRO-6130: a card in the Duplicate state counts as a record, not as added work', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const nodes = [
    { title: 'Real work', description: '', createdAt: '2026-10-24T01:00:00Z', state: { name: 'Todo' } },
    { title: 'Real work again', description: '', createdAt: '2026-10-24T02:00:00Z', canceledAt: '2026-10-24T03:00:00Z', state: { name: 'Duplicate' } },
  ];
  const r = B.summarizeBoardFlow(nodes, { now, windowDays: 1 });
  assert.equal(r.created, 1);
  assert.equal(r.excluded.created.duplicate, 1);
});

test('BRO-6090: board flow pages, includes old completions, and labels partial counts as minimums', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const calls = [];
  const graphql = async (q, v, opts) => {
    calls.push(v);
    assert.equal(opts.maxAttempts, 2);
    assert.equal(v.filter.or[0].createdAt.gte, '2026-10-23T12:00:00.000Z');
    return { issues: { nodes: [{ title: 'Long running work', createdAt: '2026-10-01T12:00:00Z', completedAt: '2026-10-24T01:00:00Z' }], pageInfo: { hasNextPage: calls.length < 2, endCursor: 'next' } } };
  };
  const r = await B.fetchBoardInflowCounts({ graphql, now, windowDays: 1 });
  assert.equal(r.created, 0);
  assert.equal(r.completed, 2);
  assert.equal(calls[1].after, 'next');
  assert.equal(r.truncated, false);
  calls.length = 0;
  const partial = await B.fetchBoardInflowCounts({ graphql, now, windowDays: 1, maxPages: 1 });
  assert.equal(partial.truncated, true);
  const text = B.renderBoardNumbersLines(B.buildBoardNumbers({ data: { d1: partial } })).join('\n');
  assert.match(text, /minimums/);
  assert.match(text, /7-day average n\/a\/day/);
  await assert.rejects(B.fetchBoardInflowCounts({ graphql: async () => ({}) }), /no issues connection/);
});

test('BRO-6090: digest uses the filtered collector by default and survives a failed window', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const data = await B.fetchBoardNumbersData({
    now,
    graphql: async (q, { filter }) => {
      assert.match(q, /query BoardFlow/);
      if (filter.or[0].createdAt.gte === '2026-10-23T12:00:00.000Z') throw new Error('window unavailable');
      return { issues: { nodes: [{ title: '[E2E Canary] alert', createdAt: '2026-10-24T01:00:00Z' }], pageInfo: { hasNextPage: false } } };
    },
    fetchOpen: async () => open, fetchStuck: async () => null, fetchParked: async () => null,
    fetchBySource: async () => null, fetchOpus: async () => null, fetchCost: async () => null,
    fetchDaily: async () => null, readLandedFn: () => null,
  });
  assert.equal(data.d1.error, 'window unavailable');
  assert.equal(data.d7.created, 0);
  const text = B.renderBoardNumbersLines(B.buildBoardNumbers({ data })).join('\n');
  assert.match(text, /Added: n\/a in 24h \(7-day average 0\.0\/day\), 0 in 7 days/);
  assert.match(text, /Added test alarms: n\/a in 24h, 1 in 7 days/);
});

test('BRO-6090: the by-source read requests closure timestamps so its counts exclude the same session cards', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const summary = await B.fetchInflowBySource({
    now,
    graphql: async (query, { filter }) => {
      assert.match(query, /createdAt completedAt canceledAt/);
      assert.equal(filter.createdAt.gte, '2026-10-23T12:00:00.000Z');
      return { issues: { nodes: [
        { title: 'Session', description: 'Filed by: session (kind: fix)', createdAt: '2026-10-24T01:00:00Z', completedAt: '2026-10-24T02:00:00Z' },
        { title: 'Real work', description: 'Filed by: session (kind: fix)', createdAt: '2026-10-24T01:00:00Z' },
      ], pageInfo: { hasNextPage: false } } };
    },
  });
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.bySource, [{ source: 'session', count: 1 }]);
});

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
  assert.match(text, /Added: n\/a in 24h \(7-day average 0\.7\/day\), 5 in 7 days/);
  assert.match(text, /Waiting on you: n\/a/);
  assert.match(text, /Landed on main, 24h: n\/a/);
  assert.match(text, /Opus in last 24h: n\/a/);
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
    fetchOpus: async () => ({ count: 7 }),
    fetchInflow: async ({ windowDays }) => { seen.push(windowDays); return inflow(windowDays, 1); },
    readLandedFn: () => ({ d1: { codex: 1, claude: 0 }, d7: { codex: 7, claude: 0 } }),
  });
  assert.deepEqual(seen.sort(), [1, 7]);
  assert.equal(d.open.error, 'boom');
  assert.equal(d.stuckCards.count, 2);
  assert.deepEqual(d.opus, { count: 7 });
  assert.deepEqual(d.landed7, { codex: 7, claude: 0 });
});

test('readLanded splits 24h and 7d from one log', () => {
  const now = 1_000_000_000_000;
  const t = (h) => Math.floor(now / 1000) - h * 3600;
  // Fields: %ct, author, co-authors, subject (LANDED_LOG_FORMAT). The owner row is a Mac Claude session (BRO-5767).
  const log = `${t(2)}\tCodex runner\t\tfix(BRO-1): a\n${t(30)}\tClaude\t\tfeat(BRO-2): b\n${t(3)}\tClaude\t\tBRO-3\n${t(1)}\tbot\t\tBRO-9\n${t(4)}\tTom Pryor\tClaude Sonnet 5.5 <noreply@anthropic.com>\tfix: c (BRO-4)\n`;
  const exec = (cmd, args) => (args[0] === 'log' ? log : 'false');
  assert.deepEqual(B.readLanded({ exec, nowMs: now }), { d1: { codex: 1, claude: 2 }, d7: { codex: 1, claude: 3 } });
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
  assert.equal(s.total, 6);
  assert.deepEqual(s.bySource, [
    { source: 'digest-autofix', count: 4 }, { source: 'ci-red', count: 1 }, { source: 'rollup', count: 1 },
  ]);
  assert.deepEqual(s.floods, [{ source: 'digest-autofix', kind: 'review gap missing cited', count: 4 }]);
  const m = B.buildBoardNumbers({ data: { d1: inflow(6, 0), bySource: s } });
  const text = B.renderBoardNumbersLines(m).join('\n');
  assert.match(text, /Added: 6 in 24h[\s\S]*\nAdded in 24h by source: digest-autofix 4, ci-red 1, rollup 1\nFloods \(3\+ cards of one kind from one filer in 24h\): digest-autofix "review gap missing cited" 4\nCompleted:/);
});

test('BRO-5488: a failed by-source read drops the line instead of printing zeros', () => {
  const m = B.buildBoardNumbers({ data: { bySource: { error: 'boom' } } });
  assert.doesNotMatch(B.renderBoardNumbersLines(m).join('\n'), /by source/);
});

test('BRO-5626: parked count reads Backlog PARKED cards and leaves out owner-waiting, owner-hold and machine parks', async () => {
  const nodes = [
    { identifier: 'BRO-1', description: 'x\nPARKED: needs a key', labels: { nodes: [] } },
    { identifier: 'BRO-2', description: 'UNPARKED (BRO-5626 drain 2026-10-18): moved', labels: { nodes: [] } },
    { identifier: 'BRO-3', description: 'PARKED: owner call', labels: { nodes: [{ name: 'awaiting-owner' }] } },
    { identifier: 'BRO-4', description: 'PARKED: needs owner decision on the design', labels: { nodes: [] } },
    { identifier: 'BRO-5', description: `PARKED: ${require('./linear-drain-parked.js').AUTO_FILED_MARKER}`, labels: { nodes: [] } },
  ];
  const calls = [];
  const r = await B.fetchParkedCards({ graphql: async (q, v) => { calls.push(v.filter); return { issues: { pageInfo: { hasNextPage: false }, nodes } }; } });
  assert.equal(r.count, 1);
  assert.equal(calls[0].state.type.eq, 'backlog');
  assert.equal(calls[0].description.contains, 'PARKED');
});

test('BRO-5626: the parked line renders a number, or n/a when the read fails', () => {
  const ok = B.buildBoardNumbers({ data: { parked: { count: 41 } } });
  assert.match(B.renderBoardNumbersLines(ok).join('\n'), /Parked, never picked: 41 \(Backlog cards with a PARKED line/);
  const bad = B.buildBoardNumbers({ data: { parked: { error: 'x' } } });
  assert.match(B.renderBoardNumbersLines(bad).join('\n'), /Parked, never picked: n\/a\n/);
});

const opusNow = new Date('2026-10-20T12:00:00Z');
const opusLaunch = (id, hoursAgo = 1, extra = {}) => ({
  event: 'launch', taskId: `linear:BRO-${id}`, model: 'opus',
  ts: new Date(opusNow.getTime() - hoursAgo * 3600_000).toISOString(), ...extra,
});

function opusLedger(t, rows) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'board-opus-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  if (rows !== null) {
    fs.mkdirSync(path.join(repo, 'data/audit'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'data/audit/dispatch-ledger.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  }
  return ({ files }) => readDispatchLedgers({ repo, files });
}

test('BRO-5770: Opus usage shares the launch counter and cloud dedupe (no cap, BRO-6502)', async (t) => {
  const readLedger = opusLedger(t, [
    ...Array.from({ length: 6 }, (_, i) => opusLaunch(i, 4)),
    opusLaunch(7, 1, { priority: 1 }), // P0 exemption still counts as launch 7.
    opusLaunch(8, 24), // exact window boundary
    opusLaunch(9, -1), // future
    opusLaunch(10, 1, { unverified: true }),
    opusLaunch(11, 1, { remapped: true }),
    opusLaunch(12, 1, { model: 'sonnet' }),
    opusLaunch(13, 1, { taskId: 'notion:13' }),
    { event: 'job-spawned', taskId: 'linear:BRO-7', model: 'opus', ts: opusNow.toISOString() },
  ]);
  const usage = await B.fetchOpusUsage({
    now: opusNow, readLedger,
    fetchClaims: async (nowMs) => {
      assert.equal(nowMs, opusNow.getTime());
      return [opusLaunch(7, 0.9, { source: 'cloud-claim' }), opusLaunch(14, 2, { source: 'cloud-claim' })];
    },
  });
  assert.deepEqual(usage, { count: 8 });
  const model = B.buildBoardNumbers({ data: { opus: usage } });
  assert.ok(B.renderBoardNumbersLines(model).includes('Opus in last 24h: 8 (no cap)'));
  assert.match(B.renderBoardNumbersHtml(model), /Opus in last 24h<\/td><td[^>]*>8 \(no cap\)/);
});

test('BRO-5770: readable empty ledgers show zero', async (t) => {
  const readLedger = opusLedger(t, []);
  {
    const usage = await B.fetchOpusUsage({
      now: opusNow, readLedger, fetchClaims: async () => [],
    });
    assert.deepEqual(usage, { count: 0 });
    assert.ok(B.renderBoardNumbersLines(B.buildBoardNumbers({ data: { opus: usage } })).includes('Opus in last 24h: 0 (no cap)'));
  }
});

test('BRO-5770: missing Mac ledger is unknown and skips the cloud API read', async (t) => {
  await assert.rejects(B.fetchOpusUsage({
    now: opusNow, readLedger: opusLedger(t, null),
    fetchClaims: async () => { assert.fail('a partial count cannot be shown'); },
  }), /could not read data\/audit\/dispatch-ledger.jsonl/);
});

test('BRO-5770: cloud read failure never shows a partial Mac-only count', async (t) => {
  const readLedger = opusLedger(t, [opusLaunch(1)]);
  await assert.rejects(B.fetchOpusUsage({
    now: opusNow, readLedger, fetchClaims: async () => { throw new Error('cloud unavailable'); },
  }), /cloud unavailable/);
  await assert.rejects(B.fetchOpusUsage({ now: opusNow, readLedger, fetchClaims: async () => null }), /could not read cloud/);
});

test('BRO-5770: an Opus read failure preserves the rest of the digest and renders n/a', async () => {
  const data = await B.fetchBoardNumbersData({
    now: opusNow, graphql: null,
    fetchOpen: async () => open,
    fetchInflow: async () => inflow(3, 2),
    fetchStuck: async () => ({ count: 1 }),
    fetchParked: async () => ({ count: 0 }),
    fetchBySource: async () => B.summarizeInflowBySource([]),
    readLandedFn: () => null,
    fetchOpus: async ({ now }) => {
      assert.equal(now, opusNow);
      throw new Error('cloud unavailable');
    },
  });
  assert.equal(data.opus.error, 'cloud unavailable');
  const lines = B.renderBoardNumbersLines(B.buildBoardNumbers({ data }));
  assert.ok(lines.includes('Added: 3 in 24h (7-day average 0.4/day), 3 in 7 days'));
  assert.ok(lines.includes('Opus in last 24h: n/a (no cap)'));
});

test('BRO-6338: filingOutpacesClosingLine names the top filer only when added > closed on both of the last 2 days', () => {
  const bySource = { total: 40, bySource: [{ source: 'digest-autofix', count: 12 }, { source: 'ci-red', count: 5 }], floods: [{ source: 'digest-autofix', kind: 'fix', count: 9 }] };
  const day = (added, closed) => ({ day: 'x', added, closed, canceled: 0 });
  const line = B.filingOutpacesClosingLine({ daily: [day(1, 9), day(60, 40), day(70, 50)], bySource });
  assert.match(line, /outpacing closing for 2 days: 130 added, 90 closed/);
  assert.match(line, /Top filer in 24h: digest-autofix, 12 of 40/);
  assert.match(line, /Biggest flood: digest-autofix "fix" 9/);
  assert.equal(B.filingOutpacesClosingLine({ daily: [day(60, 40), day(30, 50)], bySource }), null, 'one catch-up day clears it');
  assert.equal(B.filingOutpacesClosingLine({ daily: [day(50, 50), day(70, 50)], bySource }), null, 'equal is not outpacing');
  assert.equal(B.filingOutpacesClosingLine({ daily: [day(70, 50)], bySource }), null, 'needs 2 days');
  assert.equal(B.filingOutpacesClosingLine({ daily: null, bySource }), null);
  assert.equal(B.filingOutpacesClosingLine({ daily: [day(70, 50), day(70, 50)], dailyTruncated: true, bySource }), null, 'truncated counts are minimums');
  assert.match(B.filingOutpacesClosingLine({ daily: [day(9, 1), day(9, 1)], bySource: null }), /^Filing is outpacing closing for 2 days: 18 added, 2 closed \(all cards, canceled counted as closed\)\.$/);
});

test('BRO-6338: ceremonyKind treats "TEST (BRO-N) ... safe to ignore" cards as test alarms', () => {
  const card = (title) => ({ title, description: 'Filed by: session (kind: fix)', createdAt: '2026-10-24T01:00:00Z', completedAt: '2026-10-24T02:00:00Z' });
  assert.equal(B.ceremonyKind(card('TEST (BRO-6235): end-to-end check, safe to ignore'), Date.parse("2026-10-24T12:00:00Z")), 'canary');
  assert.notEqual(B.ceremonyKind(card('TEST coverage for search, safe to ignore after launch'), Date.parse("2026-10-24T12:00:00Z")), 'canary');
});
