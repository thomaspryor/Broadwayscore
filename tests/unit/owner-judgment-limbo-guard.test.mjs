import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ownerJudgmentLimboCards, auditOwnerJudgmentLimbo, ownerJudgmentLimboResults, createLimboReason } = require('../../scripts/lib/owner-judgment-limbo-guard.js');
const { classifyHealthCheck } = require('../../scripts/lib/digest-audience.js');

const CMD = 'node --test tests/unit/owner-judgment-limbo-guard.test.mjs';
const card = (extra = {}) => ({
  identifier: 'BRO-1', title: 'Technical task', priority: 3,
  state: { name: 'Todo', type: 'unstarted' },
  description: 'VERIFY: owner-judgment', ...extra,
});
const comment = (body, day) => ({ body, createdAt: `2026-10-${day}T00:00:00Z` });

test('flags marker-only P2/P3 Todo/Backlog cards, including comment markers without an enricher label', () => {
  const issues = [card(), card({ identifier: 'BRO-2', priority: 4, state: { type: 'backlog' }, description: '',
    comments: { nodes: [comment('VERIFY: owner-judgment', '15')] } })];
  const before = structuredClone(issues);
  const rows = ownerJudgmentLimboCards(issues);
  assert.deepEqual(rows.map(r => [r.id, r.source]), [['BRO-1', 'description'], ['BRO-2', 'comment:0']]);
  assert.deepEqual(issues, before);
});

test('uses the effective VERIFY, with newest comments winning over description and earlier comments', () => {
  assert.equal(ownerJudgmentLimboCards([card({ comments: { nodes: [
    comment(`VERIFY: ${CMD}`, '16'), comment('VERIFY: owner-judgment', '15'),
  ] } })]).length, 0);
  assert.equal(ownerJudgmentLimboCards([card({ description: `VERIFY: ${CMD}`, comments: { nodes: [
    comment('VERIFY: owner-judgment', '16'), comment(`VERIFY: ${CMD}`, '15'),
  ] } })]).length, 1);
  for (const description of [`VERIFY: owner-judgment\nVERIFY: ${CMD}`, 'VERIFY: retracted']) {
    assert.equal(ownerJudgmentLimboCards([card({ description })]).length, 0);
  }
});

test('excludes real owner-notification routes, closed/active cards and other priorities', () => {
  const excluded = [
    card({ description: 'DECISION NEEDED: Pick A or B?\nVERIFY: owner-judgment' }),
    card({ labels: { nodes: [{ name: 'awaiting-owner' }] } }),
    ...['started', 'completed', 'canceled', 'duplicate'].map(type => card({ state: { type } })),
    ...[0, 1, 2].map(priority => card({ priority })),
  ];
  assert.deepEqual(ownerJudgmentLimboCards(excluded), []);
});

test('mentions, templates, settled and code examples do not masquerade as owner notification', () => {
  for (const text of ['no DECISION NEEDED here', 'DECISION NEEDED: <question>',
    'DECISION NEEDED: resolved: chose A', '`DECISION NEEDED: example`', '```\nDECISION NEEDED: example\n```']) {
    assert.equal(ownerJudgmentLimboCards([card({ description: `${text}\nVERIFY: owner-judgment` })]).length, 1, text);
  }
  // notify-owner-decisions only discovers questions in descriptions or via its label.
  assert.equal(ownerJudgmentLimboCards([card({ comments: { nodes: [comment('DECISION NEEDED: Pick A?', '16')] } })]).length, 1);
});

test('public report contains routing metadata only and redacts email addresses in titles', () => {
  const [row] = ownerJudgmentLimboCards([card({ title: 'Ask person@example.com', description: 'private body\nVERIFY: owner-judgment' })]);
  assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'priority', 'source', 'url']);
  assert.doesNotMatch(JSON.stringify(row), /person@example.com|private body/);
});

test('audit reads comments for all in-scope cards, including safe/owner-armed descriptions', async () => {
  const issues = [card(), card({ identifier: 'BRO-2', description: `VERIFY: ${CMD}` }), card({ identifier: 'BRO-3', priority: 1 })];
  const before = structuredClone(issues);
  const report = await auditOwnerJudgmentLimbo(issues, { listIssueComments: async (ids) => {
    assert.deepEqual(ids, ['BRO-1', 'BRO-2']);
    return new Map([['BRO-1', [comment(`VERIFY: ${CMD}`, '16')]], ['BRO-2', [comment('VERIFY: owner-judgment', '16')]]]);
  } });
  assert.equal(report.complete, true);
  assert.equal(report.checked, 2);
  assert.deepEqual(report.cards.map(r => r.id), ['BRO-2']);
  assert.deepEqual(issues, before);
});

test('failed or partial comment reads never claim a clean sweep', async () => {
  for (const listIssueComments of [async () => { throw new Error('offline'); }, async () => new Map()]) {
    const report = await auditOwnerJudgmentLimbo([card()], { listIssueComments });
    assert.equal(report.complete, false);
    assert.equal(report.checked, 0);
    const [row] = ownerJudgmentLimboResults({ generatedAt: new Date().toISOString(), total: 1, ownerJudgmentLimbo: report });
    assert.equal(row.status, 'warn');
    assert.match(row.message, /incomplete/i);
  }
});

test('empty scope costs no requests; health rows warn on flags, missing, stale or incomplete buckets', async () => {
  const empty = await auditOwnerJudgmentLimbo([], { listIssueComments: () => assert.fail('empty scope') });
  const now = Date.parse('2026-10-26T12:00:00Z');
  const report = { generatedAt: new Date(now).toISOString(), total: 1, ownerJudgmentLimbo: empty };
  assert.equal(ownerJudgmentLimboResults(report, now)[0].status, 'pass');
  const cards = ownerJudgmentLimboCards([card()]);
  const [flagged] = ownerJudgmentLimboResults({ ...report, ownerJudgmentLimbo: { total: 1, checked: 1, complete: true, cards } }, now);
  assert.equal(flagged.status, 'warn');
  assert.equal(classifyHealthCheck(flagged), 'internal');
  assert.match(flagged.message, /1.*BRO-1/);
  assert.match(flagged.hint, /description/);
  for (const stale of [null, {}, { ...report, total: 0 }, { ...report, generatedAt: 'bad' },
    { ...report, generatedAt: '2026-10-20T00:00:00Z' }, { ...report, ownerJudgmentLimbo: undefined },
    { ...report, ownerJudgmentLimbo: { complete: true, cards: [] } }]) {
    assert.equal(ownerJudgmentLimboResults(stale, now)[0].status, 'warn');
  }
});

// ── create-time guard (BRO-5371) ─────────────────────────────────────────────
test('createLimboReason refuses a bare marker and an owner-review park, passes a real question or a runnable check', () => {
  assert.match(createLimboReason({ body: 'Do the thing.\n\nVERIFY: owner-judgment' }), /DECISION NEEDED/);
  assert.match(createLimboReason({ body: 'Do the thing.', parkReason: "Auto-filed; awaiting owner's manual look." }), /owner review/);
  assert.match(createLimboReason({ body: '- **VERIFY: owner-judgment**' }), /DECISION NEEDED/);
  assert.equal(createLimboReason({ body: 'Pick one.\nDECISION NEEDED: Should the site charge for X?\nVERIFY: owner-judgment' }), null);
  assert.equal(createLimboReason({ body: `VERIFY: ${CMD}\nVERIFY: owner-judgment` }), null);
  assert.equal(createLimboReason({ body: 'Mentions VERIFY: owner-judgment in prose only.' }), null);
  assert.equal(createLimboReason({ body: 'x', parkReason: 'needs the owner login cookie renewed on the Mac' }), null);
  assert.equal(createLimboReason({ body: 'DECISION NEEDED: <question>\nVERIFY: owner-judgment' }) !== null, true);
  assert.equal(createLimboReason({}), null);
});

test('the real createLinearIssue chokepoint refuses limbo cards before anything is filed, and the kill switch lifts it', async (t) => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limbo-ledger-'));
  process.env.INTAKE_LEDGER_PATH = path.join(dir, 'ledger.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createLinearIssue } = require('../../scripts/lib/linear-issue-create.js');
  const created = [];
  const client = { createIssue: async (i) => { created.push(i); return { id: 'i', identifier: 'BRO-1', title: i.title }; }, listOpenIssues: async () => [], searchIssues: async () => [], listIssues: async () => [] };
  const cases = [
    { title: 'Marker only card one', description: 'x\n\nVERIFY: owner-judgment', park: 'a worker cannot judge this outcome yet' },
    { title: 'Owner review park card two', description: 'x', park: "Auto-filed by a script; awaiting owner's manual look." },
    { title: 'Marker dispatch card three', description: 'x\n\nVERIFY: owner-judgment', dispatch: true },
  ];
  for (const c of cases) {
    await assert.rejects(createLinearIssue({ ...c, client, reuseTwin: false, source: 'workflow:test' }), (e) => e.code === 'OWNER_JUDGMENT_LIMBO' && /DECISION NEEDED/.test(e.message));
  }
  assert.equal(created.length, 0);
  process.env.OWNER_JUDGMENT_LIMBO_REFUSE = '0';
  t.after(() => { delete process.env.OWNER_JUDGMENT_LIMBO_REFUSE; });
  try { await createLinearIssue({ ...cases[2], client, reuseTwin: false, source: 'workflow:test' }); } catch (e) { assert.notEqual(e.code, 'OWNER_JUDGMENT_LIMBO'); }
});

test('park reason naming an owner-* script is not an owner-review park', async () => {
  const { createLimboReason } = await import('../../scripts/lib/owner-judgment-limbo-guard.js');
  assert.equal(createLimboReason({ body: 'x', parkReason: 'blocked on a fix for owner-alert-router dedupe first' }), null);
});
