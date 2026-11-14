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

test('routes human-territory cards left unarmed by the enricher, at every priority', () => {
  const issues = [
    card({ identifier: 'BRO-2', title: 'Post about the site today', description: '', priority: 2 }),
    card({ identifier: 'BRO-3', title: 'A partnership kit', description: '[notion:x] P2 Later · Todo · Partnerships' }),
    card({ identifier: 'BRO-4', title: 'Prepare the account', description: '', labels: { nodes: [{ name: 'owner-action' }] } }),
  ];
  assert.deepEqual(ownerJudgmentLimboCards(issues).map(r => r.id), ['BRO-2', 'BRO-3', 'BRO-4']);
  for (const priority of [0, 1, 2, 3, 4]) {
    assert.equal(ownerJudgmentLimboCards([{ ...issues[0], priority }]).length, 1);
  }
  for (const extra of [
    { description: `VERIFY: ${CMD}` },
    { description: 'DECISION NEEDED: Which network should carry the announcement?' },
    { comments: { nodes: [comment(`VERIFY: ${CMD}`, '16')] } },
    { state: { type: 'completed' } },
    { description: 'VERIFY: retracted' },
  ]) assert.deepEqual(ownerJudgmentLimboCards([{ ...issues[0], ...extra }]), []);
  assert.deepEqual(ownerJudgmentLimboCards([card({ title: 'Fix the email parser', description: '', labels: { nodes: [{ name: 'email' }] } })]), []);
});

test('the daily audit reads high-priority human-territory comments and respects their latest safe check', async () => {
  const human = card({ title: 'Post about the site today', description: '', priority: 1 });
  const report = await auditOwnerJudgmentLimbo([human], { listIssueComments: async ids => {
    assert.deepEqual(ids, ['BRO-1']);
    return new Map([['BRO-1', [comment(`VERIFY: ${CMD}`, '16')]]]);
  } });
  assert.deepEqual(report, { total: 1, checked: 1, complete: true, cards: [] });
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

test('quoted, numbered and heading marker variants are refused like the audit counts them', async () => {
  const { createLimboReason } = await import('../../scripts/lib/owner-judgment-limbo-guard.js');
  for (const line of ['> VERIFY: owner-judgment', '1. VERIFY: owner-judgment', '## VERIFY: owner-judgment', '`VERIFY: owner-judgment`']) {
    assert.ok(createLimboReason({ body: `Do the thing.\n${line}` }), line);
  }
  assert.equal(createLimboReason({ body: 'x\nVERIFY: node scripts/audit-orphan-tests.js' }), null);
});

test('park reasons naming an owner decision or sign-off are refused', async () => {
  const { createLimboReason } = await import('../../scripts/lib/owner-judgment-limbo-guard.js');
  for (const r of ['owner decision needed', 'needs owner sign-off', 'Owner to review']) assert.ok(createLimboReason({ body: 'x', parkReason: r }), r);
});

// BRO-6478: the two filers that got past the create-time guard.
const { updateLimboReason } = require('../../scripts/lib/owner-judgment-limbo-guard.js');
const { evaluateVerifiability } = require('../../scripts/lib/verify-gate.js');
const { startNowUnpickableReason } = require('../../scripts/lib/cloud-worker-pick.js');
const { startNowEligible, buildCardNotes } = require('../../scripts/lib/owner-alert-router.js');
const { startNowLine } = require('../../scripts/lib/start-now-filing.js');
const { planFilings, cardNotes, MAX_FILINGS_PER_RUN } = require('../../scripts/lib/ux-walkthrough-filing.js');

test('park reasons saying owner taste call or owner sweep are refused (the old ux-walkthrough wording)', () => {
  for (const parkReason of [
    'Auto-filed by the nightly UX walkthrough. UX-audit card: whether the finding is worth fixing is an owner taste call (BRO-340), so it waits for a deliberate owner sweep.',
    'an owner taste call', "waits for the owner's sweep", 'left for a deliberate sweep',
  ]) assert.match(createLimboReason({ body: 'x', parkReason }), /DECISION NEEDED/, parkReason);
  assert.equal(createLimboReason({ body: 'x', parkReason: 'needs a worktree and a monitor window' }), null);
});

test('updateLimboReason refuses an edit that leaves only the bare marker, passes real routes and old limbo cards', () => {
  assert.match(updateLimboReason({ before: 'Pitch kit.', after: 'Pitch kit.\n\nVERIFY: owner-judgment' }), /DECISION NEEDED/);
  assert.equal(updateLimboReason({ before: 'Pitch kit.', after: 'Pitch kit.\n\nDECISION NEEDED: Send the kit to X?\nVERIFY: owner-judgment' }), null);
  assert.equal(updateLimboReason({ before: 'Pitch kit.', after: `Pitch kit.\n\nVERIFY: ${CMD}` }), null);
  // Already limbo before the edit: not this edit's doing, so a sanitizing rewrite is not blocked.
  assert.equal(updateLimboReason({ before: 'a\nVERIFY: owner-judgment', after: 'a (edited)\nVERIFY: owner-judgment' }), null);
  assert.equal(updateLimboReason({}), null);
});

test('enrich-card-acceptance write path refuses to store the bare marker', async () => {
  const { makeLinearWriteCard } = require('../../scripts/enrich-card-acceptance.js');
  const calls = [];
  const write = makeLinearWriteCard({ updateIssue: async (...a) => calls.push(a), findOrCreateLabel: async () => ({ id: 'l' }), addLabelToIssue: async () => {} }, 't');
  await assert.rejects(write({ id: 'i', notes: 'Pitch kit.' }, 'Pitch kit.\n\nVERIFY: owner-judgment'), /refused/);
  assert.equal(calls.length, 0);
});

test('the limbo health row files a START-NOW worker card the cloud worker will pick', () => {
  const row = ownerJudgmentLimboResults({ generatedAt: new Date().toISOString(), total: 9,
    ownerJudgmentLimbo: { complete: true, total: 9, checked: 9, cards: [{ id: 'BRO-1' }] } })[0];
  const conditionKey = `health-check:${row.name}`;
  const description = `${row.message}\n\n${row.hint}`;
  // Without the playbook flag the internal "Dispatch" category keeps it out of START-NOW; with it, it files.
  assert.equal(startNowEligible({ conditionKey, description }), false);
  assert.equal(startNowEligible({ conditionKey, description, workerFixable: true }), true);
  // The real card body, built by the router's own builder, must pass the picker.
  const notes = `${startNowLine('the Mac drain', { internal: true })}\n\n${buildCardNotes({ description, hint: 'Triage.', fields: [], conditionKey })}`;
  assert.equal(startNowUnpickableReason({ title: `BSC Daily: ${row.name}`, description: notes, priority: 2, mode: 'dispatch' }), null);
  // Owner-or-Mac rows stay out even when flagged.
  assert.equal(startNowEligible({ conditionKey: 'health-check:Credits: ScrapingBee', description: 'x', workerFixable: true }), false);
});

test('a UX walkthrough card has a runnable check, no limbo, passes the picker, and the nightly volume is capped', () => {
  const finding = { summary: 'Score badge overlaps title on mobile', severity: 'high', screenshot: 'mobile-grid', agreementCount: 2, models: ['a', 'b'] };
  const notes = cardNotes(finding, 3, 'a'.repeat(32));
  assert.ok(evaluateVerifiability(notes, []).cmd, 'needs a safe-form VERIFY');
  assert.equal(evaluateVerifiability(notes, []).cmd, `node scripts/lib/ux-walkthrough-resolution.js --key=${'a'.repeat(32)}`);
  assert.equal(createLimboReason({ body: notes, parkReason: '' }), null);
  assert.match(notes, /visual-approval\.js request/);
  assert.match(notes, /demo\.broadwayscorecard\.com/);
  assert.equal(startNowUnpickableReason({ title: 'UX audit: x', description: `START-NOW: test\n${notes}`, priority: 2, mode: 'dispatch' }), null);
  const topics = ['carousel arrows hidden', 'footer links overlap', 'tooltip clipped', 'modal scrolls twice', 'search dropdown flickers', 'avatar menu misaligned', 'poster images stretch', 'filter chips wrap'];
  const findings = topics.map(summary => ({ summary, agreementCount: 2, screenshot: 's' }));
  const plan = planFilings({ findings, existing: { ok: true, titles: [] } });
  assert.equal(plan.toFile.length, MAX_FILINGS_PER_RUN);
  assert.equal(plan.skippedOverCap.length, 8 - MAX_FILINGS_PER_RUN);
});
