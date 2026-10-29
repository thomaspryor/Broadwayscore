'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = { ...require('./claude-session-cost.js'), ...require('./claude-session-cost-writer.js') };
const bn = require('./board-numbers.js');

const S1 = 'session_0138fRRtkaUF3YUHfGsqT13p';
const S2 = 'session_011A8W3JdBATuDpT33Pbh8px';
const row = (o) => ({ date: '2026-10-20', session: S1, model: 'claude-opus-5-5', origin: 'board', costUsd: 10, cards: ['BRO-1'], ...o });
const NOW = Date.parse('2026-10-22T08:00:00Z');

test('validateRow / parseLedger: valid rows pass, bad rows are reported by line', () => {
  assert.deepEqual(C.validateRow(row()), []);
  assert.ok(C.validateRow(row({ costUsd: -1 })).length);
  assert.ok(C.validateRow(row({ session: 'abc' })).length);
  assert.ok(C.validateRow(row({ cards: ['nope'] })).length);
  const { rows, errors } = C.parseLedger(`${JSON.stringify(row())}\n\nnot json\n${JSON.stringify(row({ date: '10/20' }))}\n`);
  assert.equal(rows.length, 1);
  assert.deepEqual(errors.map((e) => e.line), [3, 4]);
});

test('sessionsFromGitLog: cards per Claude-Session trailer; commits without one are ignored', () => {
  const log = [
    `1761100000\tfix(BRO-5794): thing\n\nfollows BRO-4312 (cited, not landed)\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/${S1}\n`,
    `1761100500\tBRO-5886: plan; also BRO-12\n\nClaude-Session: https://claude.ai/code/${S1}\n`,
    `1761100900\tchore: data refresh BRO-99\n`,
    `1761101000\tBRO-7: x\n\nClaude-Session: https://claude.ai/code/${S2}\n`,
  ].join('\0');
  const m = C.sessionsFromGitLog(log);
  assert.deepEqual([...m.keys()].sort(), [S2, S1].sort());
  assert.deepEqual([...m.get(S1).cards].sort(), ['BRO-12', 'BRO-5794', 'BRO-5886']); // subject ids only
  assert.deepEqual([...m.get(S2).cards], ['BRO-7']);
});

test('parseGetSession: reads ccr.external_metadata.usage.cost_usd; missing cost is an error, not zero', () => {
  const ok = C.parseGetSession(JSON.stringify({ ccr: { id: S1, title: 'BRO-1: x', external_metadata: { usage: { cost_usd: 12.345678 }, model: 'claude-sonnet-5' } } }));
  assert.equal(ok.session, S1);
  assert.equal(ok.costUsd, 12.3457);
  assert.equal(ok.model, 'claude-sonnet-5');
  assert.match(C.parseGetSession({ ccr: { id: S1, session_status: 'X' } }).error, /cost_usd/);
  assert.match(C.parseGetSession('nope').error, /not JSON/);
  for (const bad of ['', false, null]) assert.match(C.parseGetSession({ ccr: { id: S1, external_metadata: { usage: { cost_usd: bad } } } }).error, /not a number/);
  // A nested tool config's model never labels the session.
  assert.equal(C.parseGetSession({ ccr: { id: S1, tools: { model: 'haiku' }, external_metadata: { usage: { cost_usd: 1 } } } }).model, 'unknown');
  assert.match(C.parseGetSession({ ccr: { external_metadata: { usage: { cost_usd: 1 } } } }).error, /session id/);
});

test('appendRows: same (date, session) replaces, other rows kept; invalid rows refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csc-'));
  const file = path.join(dir, 'a', 'ledger.jsonl');
  assert.deepEqual(C.appendRows([row()], { file }), { written: 1, replaced: 0 });
  C.appendRows([row({ session: S2 })], { file });
  assert.deepEqual(C.appendRows([row({ costUsd: 15 })], { file }), { written: 1, replaced: 1 });
  const { rows, errors } = C.parseLedger(fs.readFileSync(file, 'utf8'));
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.session === S1).costUsd, 15);
  assert.throws(() => C.appendRows([row({ costUsd: 'x' })], { file }), /invalid ledger row/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('summarizeCost: cumulative cost is differenced across the window edge, by model family', () => {
  const rows = [
    row({ date: '2026-10-14', costUsd: 4 }), // before the window: baseline for S1
    row({ date: '2026-10-20', costUsd: 9, cards: ['BRO-1'] }),
    row({ date: '2026-10-21', costUsd: 14, cards: ['BRO-2'] }),
    row({ date: '2026-10-21', session: S2, model: 'claude-sonnet-5', costUsd: 3, cards: ['BRO-2', 'BRO-3'] }),
    row({ date: '2026-10-01', session: 'session_0000000000old', costUsd: 50 }), // out of window entirely
  ];
  const s = C.summarizeCost(rows, { nowMs: NOW, days: 7 });
  assert.equal(s.totalUsd, 13); // S1 14-4, S2 3
  assert.equal(s.sessions, 2);
  assert.equal(s.cards, 3);
  assert.equal(s.perCardUsd, 13 / 3);
  assert.deepEqual(s.byModel, { opus: { usd: 10, sessions: 1 }, sonnet: { usd: 3, sessions: 1 } });
  assert.equal(C.summarizeCost([], { nowMs: NOW }).perCardUsd, null);
});

test('summarizeCodexCheck: reads the runner summary lines inside the window only', () => {
  const body = (usd, landed) => `## Codex runner 2026-10-21: 3 card(s)\n- Landed and Done: ${landed}\n- Landed part, back to Todo with what is left: BRO-9\n- Claude check: 3 review(s), $${usd} API cost\n`;
  const s = C.summarizeCodexCheck([
    { createdAt: '2026-10-21T01:00:00Z', body: body('2.50', 'BRO-1, BRO-2') },
    { createdAt: '2026-10-20T01:00:00Z', body: body('1.50', 'none') },
    { createdAt: '2026-10-01T01:00:00Z', body: body('99', 'BRO-5') },
    { createdAt: '2026-10-21T02:00:00Z', body: 'Claimed by a session' },
  ], { nowMs: NOW });
  assert.equal(s.runs, 2);
  assert.equal(s.usd, 4);
  assert.equal(s.cards, 3); // BRO-1, BRO-2, BRO-9
  assert.equal(s.perCardUsd, 4 / 3);
});

test('renderCostLine: full, empty ledger and unread halves', () => {
  const claude = C.summarizeCost([row({ date: '2026-10-21', costUsd: 20, cards: ['BRO-1', 'BRO-2'] })], { nowMs: NOW });
  assert.equal(C.renderCostLine({ claude, codex: { usd: 3, perCardUsd: 1.5 } }),
    'Claude cost, 7 days: $20.00 over 2 cards ($10.00/card); Opus $20.00; Codex check $3.00 ($1.50/card)');
  assert.equal(C.renderCostLine({ claude: C.summarizeCost([], { nowMs: NOW }), codex: null }), 'Claude cost, 7 days: nothing recorded; Codex check n/a');
  assert.equal(C.renderCostLine({ claude: null, codex: { usd: 0, perCardUsd: null } }), 'Claude cost, 7 days: n/a; Codex check $0.00 (n/a)');
});

test('board-numbers: cost line renders from fetchClaudeCost, and a failed read renders n/a', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csc-bn-'));
  fs.mkdirSync(path.join(dir, 'data/audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, C.LEDGER_REL), `${JSON.stringify(row({ date: '2026-10-21', costUsd: 8, cards: ['BRO-1'] }))}\n`);
  const graphql = async () => ({ issue: { comments: { nodes: [{ createdAt: '2026-10-21T01:00:00Z', body: '- Landed and Done: BRO-4\n- Claude check: 1 review(s), $1.19 API cost' }] } } });
  const cost = await bn.fetchClaudeCost({ graphql, now: new Date(NOW), cwd: dir });
  const lines = bn.renderBoardNumbersLines(bn.buildBoardNumbers({ data: { cost } }));
  assert.ok(lines.includes('Claude cost, 7 days: $8.00 over 1 cards ($8.00/card); Opus $8.00; Codex check $1.19 ($1.19/card)'), lines.join('\n'));
  const failed = bn.renderBoardNumbersLines(bn.buildBoardNumbers({ data: { cost: { error: 'boom' } } }));
  assert.ok(failed.includes('Claude cost, 7 days: n/a'));
  const noLedger = await bn.fetchClaudeCost({ graphql: async () => { throw new Error('down'); }, now: new Date(NOW), cwd: path.join(dir, 'missing') });
  assert.equal(noLedger.claude.sessions, 0); // no ledger yet = nothing recorded
  assert.equal(noLedger.codex, null); // unread = n/a
  // A paged walk that breaks off is unknown, never a partial (smaller) sum.
  let calls = 0;
  const paged = async () => (++calls === 1
    ? { issue: { comments: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ createdAt: '2026-10-21T01:00:00Z', body: '- Claude check: 1 review(s), $1 API cost' }] } } }
    : { issue: null });
  assert.equal((await bn.fetchClaudeCost({ graphql: paged, now: new Date(NOW), cwd: dir })).codex, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseGetSession: model comes from session_context.model / configured_model (real get_session shape)', () => {
  const a = C.parseGetSession({ ccr: { id: S1, session_context: { model: 'claude-opus-5-5' }, external_metadata: { usage: { cost_usd: 1 } } } });
  assert.equal(a.model, 'claude-opus-5-5');
  const b = C.parseGetSession({ ccr: { id: S1, configured_model: 'claude-sonnet-5-5', external_metadata: { usage: { cost_usd: 1 } } } });
  assert.equal(b.model, 'claude-sonnet-5-5');
});
