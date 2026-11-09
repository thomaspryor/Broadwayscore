// BRO-7139 Step 2: nightly llm-triage queue + ledger. require() the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Q = require('./llm-triage-queue.js');
const CLI = require('../llm-triage.js');
const bc = require('./board-categories.js');

const NOW = Date.parse('2026-11-09T03:00:00Z');
const NO_RECHECK = path.join(os.tmpdir(), 'llm-triage-no-such-recheck-ledger.jsonl');
const c = (n, category, created) => ({ identifier: `BRO-${n}`, category, createdAt: created });

test('ownedCategories reads the llm-triage handler from the real classifier table', () => {
  assert.deepEqual(Q.ownedCategories().sort(), ['other', 'parked-other']);
});

test('selectQueue: only llm-triage categories, oldest first, cooldown, cap', () => {
  const board = { cards: [
    c(1, 'other', '2026-10-05'), c(2, 'parked-other', '2026-10-01'), c(3, 'ready', '2026-09-01'),
    c(4, 'waiting-owner', '2026-09-01'), c(5, 'other', '2026-10-10'), c(6, 'other', '2026-10-20'),
  ] };
  const ledger = [
    { id: 'BRO-5', ts: '2026-11-07T03:00:00Z', verdict: 'release' }, // 2 days ago: cooling
    { id: 'BRO-6', ts: '2026-10-20T03:00:00Z', verdict: 'keep' }, // 20 days ago: due again
    { id: 'BRO-1', ts: '2026-11-08T01:00:00Z', error: 'Anthropic 529' }, // error 26h ago: due again
    { id: 'BRO-2', ts: '2026-11-08T12:00:00Z', error: 'Anthropic 529' }, // error 15h ago: cooling 1 day
  ];
  const q = Q.selectQueue(board, ledger, { nowMs: NOW, cap: 2 });
  assert.deepEqual(q.ids, ['BRO-6', 'BRO-1']); // longest since last triage first
  assert.equal(q.eligible, 4);
  assert.equal(q.cooling, 2);
  assert.deepEqual(Q.selectQueue(board, ledger.slice(0, 3), { nowMs: NOW }).ids, ['BRO-2', 'BRO-6', 'BRO-1']); // never-triaged first
  // Cron drift: triaged 02:16 seven days ago, tonight starts 02:15. Due, not skipped.
  const drift = Q.selectQueue({ cards: [c(7, 'other', '2026-10-01')] }, [{ id: 'BRO-7', ts: '2026-11-02T03:01:00Z', verdict: 'keep' }], { nowMs: NOW });
  assert.deepEqual(drift.ids, ['BRO-7']);
  // Starvation: a new card beats an old card that was triaged a week ago.
  const st = Q.selectQueue({ cards: [c(8, 'other', '2026-01-01'), c(9, 'other', '2026-11-01')] }, [{ id: 'BRO-8', ts: '2026-11-01T03:00:00Z', verdict: 'keep' }], { nowMs: NOW, cap: 1 });
  assert.deepEqual(st.ids, ['BRO-9']);
  assert.throws(() => Q.selectQueue(board, [], {}), /nowMs/);
});

test('parseLedger skips torn lines', () => {
  assert.deepEqual(Q.parseLedger('{"id":"BRO-1"}\n{"id":\n\n{"id":"BRO-2"}\n').map((r) => r.id), ['BRO-1', 'BRO-2']);
});

test('ledgerRow: public repo, so ids/enums/dates only, never model or card text', () => {
  const secret = 'owner said spend $500 on ads, email jane@example.com';
  const row = Q.ledgerRow({ id: 'BRO-9', facts: { VERIFY_RESULT: 'pass', LANDINGS: 'abc123 fix', CONDITION_STATE: secret, CATEGORY: 'other' },
    verdict: { verdict: 'ask-owner', reason: secret, question: `DECISION NEEDED: ${secret}`, default: secret, verify: secret, close_evidence: secret,
      default_allowed: true, recheck_after: secret, duplicate_of: secret, blocked_on: 'BRO-12' } },
  { ts: '2026-11-09T03:00:00Z', source: 'ci', runId: '7', model: 'm' });
  assert.ok(!JSON.stringify(row).includes('jane'), JSON.stringify(row));
  assert.equal(row.verdict, 'ask-owner');
  assert.equal(row.has_question, true);
  assert.equal(row.category, 'other');
  assert.equal(row.default_allowed, true);
  assert.equal(row.blocked_on, 'BRO-12');
  assert.equal(row.duplicate_of, null);
  assert.equal(row.recheck_after, null);
  assert.deepEqual(row.facts, { verify: 'pass', condition: null, landed: true });
  assert.equal(row.error, null);
  const bad = Q.ledgerRow({ id: 'BRO-9', error: `bad JSON: Unexpected token in ${secret}` }, { ts: 't', source: 'ci' });
  assert.equal(bad.error, 'bad JSON');
  assert.equal(Q.ledgerRow({ id: 'BRO-9', verdict: { verdict: secret } }, { ts: 't', source: 'ci' }).verdict, null);
});

test('CLI --queue --ledger: reads only llm-triage cards, appends rows, never mutates; kill switch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-triage-q-'));
  const ledger = path.join(dir, 'l.jsonl');
  fs.writeFileSync(ledger, '{"id":"BRO-1","ts":"2026-11-01T00:00:00Z","verdict":"keep"}'); // no trailing newline
  const owned = { identifier: 'BRO-200', title: 'Odd card', description: 'nothing parseable', createdAt: '2026-10-01T00:00:00Z', state: { name: 'Todo', type: 'unstarted' }, priority: 3, comments: { nodes: [] } };
  const other = { ...owned, identifier: 'BRO-201', description: 'PARKED: waiting' };
  const graphql = async (q) => {
    assert.doesNotMatch(q, /mutation/);
    if (/issues\s*\(/.test(q)) return { issues: { nodes: [owned, other], pageInfo: { hasNextPage: false } } };
    if (/BRO-201/.test(q)) return { i0: other };
    assert.doesNotMatch(q, /BRO-200/); // the needs-safe-check card is never fetched
    return {};
  };
  const board = bc.categorizeBoard([owned, other], { now: new Date(NOW) });
  const want = board.cards.filter((x) => Q.ownedCategories().includes(x.category)).map((x) => x.identifier);
  assert.deepEqual(want, ['BRO-201'], `fixture must land in an llm-triage category, got ${JSON.stringify(board.cards.map((x) => x.category))}`);
  const asked = [];
  const code = await CLI.main(['--queue', '--ask', `--ledger=${ledger}`], {
    graphql, now: new Date(NOW), log: () => {}, env: { ANTHROPIC_API_KEY: 'x', GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '42' },
    commitSearch: () => [], workflowRuns: () => [], recheckLedger: NO_RECHECK,
    ask: async (prompt) => { asked.push(prompt); return JSON.stringify({ id: 'BRO-201', verdict: 'release', reason: 'r' }); },
  });
  const rows = Q.parseLedger(fs.readFileSync(ledger, 'utf8'));
  assert.equal(rows[0].id, 'BRO-1');
  const fresh = rows.slice(1);
  assert.deepEqual(fresh.map((r) => r.id).sort(), want.sort());
  assert.equal(asked.length, want.length);
  assert.ok(fresh.every((r) => r.source === 'ci' && r.runId === '42'));
  assert.ok(fresh.every((r) => r.verdict === 'release' && !r.error), JSON.stringify(fresh));
  assert.equal(code, 0);
  assert.throws(() => CLI.parseArgs(['--queue', '--ledger=x']), /needs --ask/);
  assert.throws(() => CLI.parseArgs(['--queue', '--ids=BRO-1']), /exclusive/);
  assert.throws(() => CLI.parseArgs(['--queue', '--cap=99']), /--cap/);
  const before = fs.readFileSync(ledger, 'utf8');
  assert.equal(await CLI.main(['--queue', '--ask', `--ledger=${ledger}`], { env: { LLM_TRIAGE_DISABLED: 'true' }, log: () => {} }), 0);
  assert.equal(fs.readFileSync(ledger, 'utf8'), before);
});

test('CLI: rows land per card, a deadline stops new cards, every card failing exits 1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-triage-d-'));
  const ledger = path.join(dir, 'l.jsonl');
  const mk = (n) => ({ identifier: `BRO-${n}`, title: `t${n}`, description: '', createdAt: '2026-10-01T00:00:00Z', state: { name: 'Todo', type: 'unstarted' }, priority: 3, comments: { nodes: [] } });
  const cards = [mk(301), mk(302), mk(303)];
  const graphql = async (q) => {
    if (/issues\s*\(/.test(q)) return { issues: { nodes: cards, pageInfo: { hasNextPage: false } } };
    const out = {}; let j = 0;
    for (const m of q.matchAll(/issue\(id: "(BRO-\d+)"\)/g)) { out[`i${j++}`] = cards.find((c) => c.identifier === m[1]); }
    return out;
  };
  let t = 0; const seenAtAsk = [];
  const code = await CLI.main(['--ids=BRO-301,BRO-302,BRO-303', '--ask', `--ledger=${ledger}`, '--deadline-min=1'], {
    graphql, now: new Date(NOW), log: () => {}, env: { ANTHROPIC_API_KEY: 'x' }, commitSearch: () => [], workflowRuns: () => [], recheckLedger: NO_RECHECK,
    clock: () => t,
    ask: async () => { seenAtAsk.push(fs.existsSync(ledger) ? Q.parseLedger(fs.readFileSync(ledger, 'utf8')).length : 0); t += 40000; throw new Error('Anthropic 529'); },
  });
  assert.deepEqual(seenAtAsk, [0, 1]); // card 2 sees card 1's row already written
  const rows = Q.parseLedger(fs.readFileSync(ledger, 'utf8'));
  assert.deepEqual(rows.map((r) => r.id), ['BRO-301', 'BRO-302']); // 80s > 60s deadline: BRO-303 never started
  assert.equal(code, 1); // every card that ran failed
});

test('CLI: a partial failure exits 0 but warns on the run page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-triage-w-'));
  const ledger = path.join(dir, 'l.jsonl');
  const mk = (n) => ({ identifier: `BRO-${n}`, title: `t${n}`, description: '', createdAt: '2026-10-01T00:00:00Z', state: { name: 'Todo', type: 'unstarted' }, priority: 3, comments: { nodes: [] } });
  const cards = [mk(401), mk(402)];
  const graphql = async (q) => {
    if (/issues\s*\(/.test(q)) return { issues: { nodes: cards, pageInfo: { hasNextPage: false } } };
    const out = {}; let j = 0;
    for (const m of q.matchAll(/issue\(id: "(BRO-\d+)"\)/g)) { out[`i${j++}`] = cards.find((c) => c.identifier === m[1]); }
    return out;
  };
  const lines = []; let n = 0;
  const code = await CLI.main(['--ids=BRO-401,BRO-402', '--ask', `--ledger=${ledger}`], {
    graphql, now: new Date(NOW), log: (s) => lines.push(s), env: { ANTHROPIC_API_KEY: 'x', GITHUB_ACTIONS: 'true' }, commitSearch: () => [], workflowRuns: () => [], recheckLedger: NO_RECHECK,
    ask: async () => { if (n++ === 0) throw new Error('Anthropic 529'); return JSON.stringify({ id: 'BRO-402', verdict: 'keep', reason: 'r' }); },
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /^::warning::llm-triage: 1 of 2 cards errored/.test(l)), lines.join('\n'));
});
