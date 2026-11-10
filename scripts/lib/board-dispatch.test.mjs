// BRO-7139 Step 2: board-dispatch groups cards by owning handler, lists gaps, writes one ledger row, never writes Linear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planDispatch, HANDLERS } = require('./board-handlers.js');
const { main, parseArgs, shouldWrite, ledgerRow, boardCounts } = require('../board-dispatch.js');
const NO_RECHECK = path.join(os.tmpdir(), 'bd-no-such-recheck-ledger.jsonl');

const report = {
  categories: [
    { key: 'waiting-owner', handlers: ['owner-decision-emails'] },
    { key: 'parked-other', handlers: ['llm-triage'] },
    { key: 'started-idle', handlers: ['linear-reclaim-abandoned', 'close-stuck-verified-cards'] },
    { key: 'app-repo', handlers: [] },
  ],
  cards: [
    { identifier: 'BRO-1', category: 'waiting-owner' },
    { identifier: 'BRO-2', category: 'parked-other' },
    { identifier: 'BRO-3', category: 'started-idle' },
    { identifier: 'BRO-4', category: 'app-repo' },
    { identifier: 'BRO-5', category: 'app-repo' },
    { identifier: 'BRO-6', category: 'mystery' },
  ],
};

test('planDispatch: each card goes to every handler its category names; non-applying rows are gaps', () => {
  const p = planDispatch(report, HANDLERS);
  assert.equal(p.open, 6);
  assert.deepEqual(p.handlers['owner-decision-emails'], { mode: 'apply', categories: ['waiting-owner'], count: 1, sample: ['BRO-1'] });
  assert.equal(p.handlers['linear-reclaim-abandoned'].count, 1);
  assert.equal(p.handlers['close-stuck-verified-cards'].count, 1);
  assert.equal(p.handlers['llm-triage'].mode, 'report-only'); // BRO-7139 Step 2: nightly report-only in data-health-check.yml
  assert.deepEqual(p.gaps, [
    { category: 'app-repo', count: 2, sample: ['BRO-4', 'BRO-5'] },
    { category: 'mystery', count: 1, sample: ['BRO-6'] },
    { category: 'parked-other', count: 1, sample: ['BRO-2'] },
  ]);
});

test('planDispatch: empty report and sample cap', () => {
  assert.deepEqual(planDispatch({}), { open: 0, handlers: {}, gaps: [] });
  const many = { categories: [{ key: 'app-repo', handlers: [] }], cards: Array.from({ length: 9 }, (_, i) => ({ identifier: `BRO-${i}`, category: 'app-repo' })) };
  const g = planDispatch(many).gaps[0];
  assert.equal(g.count, 9);
  assert.equal(g.sample.length, 5);
});

test('parseArgs and ledgerRow', () => {
  assert.equal(parseArgs(['--bogus']).error, 'unknown argument --bogus');
  assert.equal(parseArgs(['--no-write']).write, false);
  const row = ledgerRow(planDispatch(report), { now: new Date('2026-11-08T00:00:00Z'), broken: 1 });
  assert.equal(row.mode, 'report-only');
  assert.equal(row.v, 2);
  assert.deepEqual(row.handlers['owner-decision-emails'].categories, ['waiting-owner']);
  assert.equal(row.ts, '2026-11-08T00:00:00.000Z');
  assert.equal(row.uncategorized, 1);
  assert.equal(row.handlers['owner-decision-emails'].count, 1);
  assert.equal(ledgerRow(planDispatch(report), { now: new Date(), env: {} }).source, 'local');
});

test('main: kill switch writes nothing and makes no Linear call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));
  const ledger = path.join(dir, 'l.jsonl');
  let calls = 0;
  const code = await main([`--ledger=${ledger}`], { graphql: async () => { calls++; return {}; }, env: { BOARD_DISPATCH_DISABLED: 'true' }, log: () => {} });
  assert.equal(code, 0);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(ledger), false);
});

test('main: appends one row, only reads Linear (every call is a query, no mutation)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));
  const ledger = path.join(dir, 'l.jsonl');
  const queries = [];
  const node = { id: 'x', identifier: 'BRO-9', title: 'T', description: '', priority: 3, url: 'u', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    state: { name: 'Todo', type: 'unstarted' }, labels: { nodes: [] }, comments: { nodes: [] } };
  const graphql = async (q) => { queries.push(q); return { issues: { nodes: [node], pageInfo: { hasNextPage: false } } }; };
  for (let i = 0; i < 2; i++) assert.equal(await main([`--ledger=${ledger}`], { graphql, env: {}, log: () => {}, now: new Date('2026-11-08T00:00:00Z'), recheckLedger: NO_RECHECK }), 0);
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].open, 1);
  assert.equal(rows[0].v, 2);
  assert.equal(Object.values(rows[0].groups).reduce((a, n) => a + n, 0), 1); // groups partition the open cards
  assert.equal(typeof rows[0].ready, 'number');
  assert.ok(queries.every((q) => !/\bmutation\b/.test(q)));
});

test('main: a Linear failure exits 1 and leaves an error row', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));
  const ledger = path.join(dir, 'l.jsonl');
  const err = console.error; console.error = () => {};
  try {
    assert.equal(await main([`--ledger=${ledger}`], { graphql: async () => { throw new Error('down'); }, env: { GITHUB_RUN_ID: '42' }, log: () => {}, recheckLedger: NO_RECHECK }), 1);
  } finally { console.error = err; }
  const row = JSON.parse(fs.readFileSync(ledger, 'utf8').trim());
  assert.equal(row.error, 'down');
  assert.equal(row.source, 'ci');
  assert.equal(row.runId, '42');
  assert.equal(row.v, 2);
});

test('shouldWrite: CI or explicit ledger writes; a bare local run does not; flags win', () => {
  assert.equal(shouldWrite(parseArgs([]), {}), false);
  assert.equal(shouldWrite(parseArgs([]), { GITHUB_RUN_ID: '1' }), true);
  assert.equal(shouldWrite(parseArgs(['--ledger=/x']), {}), true);
  assert.equal(shouldWrite(parseArgs(['--write']), {}), true);
  assert.equal(shouldWrite(parseArgs(['--no-write']), { GITHUB_RUN_ID: '1' }), false);
});

test('planDispatch: a card with no category is a named gap, never an undefined key', () => {
  const p = planDispatch({ categories: [], cards: [{ identifier: 'BRO-7' }] });
  assert.deepEqual(p.gaps, [{ category: 'uncategorized', count: 1, sample: ['BRO-7'] }]);
});

test('ledgerRow carries answeredCheck', () => {
  const row = ledgerRow({ ...planDispatch(report), answeredCheck: 'answered-line-only' }, { now: new Date(), env: {} });
  assert.equal(row.answeredCheck, 'answered-line-only');
});

test('boardCounts: group exclusives and ready come from the real classifier report', () => {
  const r = { categories: [{ key: 'ready', exclusive: 3, overlap: 0, byPriority: { urgent: 0, high: 0 } }, { key: 'started-idle', exclusive: 2, overlap: 0, byPriority: { urgent: 0, high: 0 } }] };
  const c = boardCounts(r);
  assert.equal(c.ready, 3);
  assert.equal(c.groups.stuck, 2);
  assert.equal(c.groups.moving, 3);
  assert.equal(boardCounts({ categories: [] }).ready, 0);
});
