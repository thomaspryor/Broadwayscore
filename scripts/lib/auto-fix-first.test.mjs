// BRO-5477 (owner decision 2026-10-16): opening-night pipeline failures start
// an automatic fix first and email the owner only if that fix fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const afx = require('./auto-fix-first.js');
const { startNowUnpickableReason } = require('./cloud-worker-pick.js');
const { verifyCommand } = require('./linear-drain-parked.js');

const H = 3600000;
const NOW = Date.parse('2026-10-16T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
// Second-attempt cards by default (BRO-5541): the escalation rules below are
// the ones that email. first() is a first attempt, which retries instead.
const card = (o = {}) => ({ identifier: 'BRO-1', url: 'https://linear.app/x/BRO-1', title: 'Auto-fix (second try): Poller failed', description: 'x\n\nauto-fix-first-key: k\n\nauto-fix-first-attempt: 2\n', createdAt: iso(1 * H), state: { type: 'unstarted' }, comments: [], ...o });
const first = (o = {}) => card({ title: 'Auto-fix: Poller failed', description: 'x\n\nauto-fix-first-key: k\n', ...o });
const decide = (cards, redAgo, canFile = true) => afx.decide({ cards, redObservedAt: redAgo === null ? null : NOW - redAgo, nowMs: NOW, canFile }).action + ':' + afx.decide({ cards, redObservedAt: redAgo === null ? null : NOW - redAgo, nowMs: NOW, canFile }).reason;

test('decide: no card files on a fresh failure; the sweep never files', () => {
  assert.equal(decide([], 0), 'file:no-card');
  assert.equal(decide([], 0, false), 'none:no-card');
});

test('decide: an open card holds for the 3h window, then escalates if nobody started it', () => {
  assert.equal(decide([card({ createdAt: iso(2 * H) })], 0), 'hold:fix-window');
  assert.equal(decide([card({ createdAt: iso(3 * H) })], null), 'escalate:not-started');
});

test('decide: a started card escalates only on red seen after the window', () => {
  const started = card({ createdAt: iso(4 * H), startedAt: iso(3.5 * H), state: { type: 'started' } });
  assert.equal(decide([started], 0), 'escalate:still-red');
  assert.equal(decide([started], 2 * H), 'hold:fix-in-progress', 'red from inside the window is not evidence the fix failed');
  assert.equal(decide([started], null), 'hold:fix-in-progress', 'no red evidence (poller cannot be proven) never pages');
});

test('decide: a closed card escalates only on red more than 1h after it closed', () => {
  const closed = card({ createdAt: iso(5 * H), startedAt: iso(4 * H), completedAt: iso(3 * H), state: { type: 'completed' } });
  assert.equal(decide([closed], 3.5 * H), 'hold:fix-just-closed', 'red from before the fix closed is the old failure');
  assert.equal(decide([closed], 1 * H), 'escalate:red-after-fix');
  assert.equal(decide([closed], null), 'hold:fix-just-closed');
});

test('decide: red inside the grace hour after Done holds only until the hour is up, then escalates', () => {
  const justClosed = card({ createdAt: iso(3 * H), startedAt: iso(2 * H), completedAt: iso(0.5 * H), state: { type: 'completed' } });
  assert.equal(decide([justClosed], 0), 'hold:fix-just-closed', 'the gate holds a failure inside the grace hour');
  const closed = card({ createdAt: iso(5 * H), startedAt: iso(4 * H), completedAt: iso(3 * H), state: { type: 'completed' } });
  assert.equal(decide([closed], 2.5 * H), 'escalate:red-after-fix', 'the sweep pages it once the grace hour has passed');
});

test('decide: a card closed as Duplicate is not open', () => {
  const dup = card({ createdAt: iso(4 * H), canceledAt: iso(3.5 * H), state: { type: 'duplicate' } });
  const real = card({ identifier: 'BRO-2', createdAt: iso(3.9 * H), state: { type: 'started' } });
  assert.equal(decide([dup, real], null), 'hold:fix-in-progress');
});

test('decide: after the owner was told, the alert holds (no repeat emails); cards older than 24h are a past incident', () => {
  const esc = card({ createdAt: iso(4 * H), comments: [{ body: `${afx.ESCALATED_MARKER} x` }] });
  assert.equal(decide([esc], 0), 'hold:already-escalated');
  assert.equal(decide([first({ identifier: 'BRO-0', createdAt: iso(8 * H), comments: [{ body: `${afx.ESCALATED_MARKER} x` }] }), card({ createdAt: iso(1 * H) })], 0), 'hold:already-escalated', 'any escalated card in the lookback holds');
  assert.equal(decide([card({ createdAt: iso(25 * H) })], 0), 'file:no-card');
});

test('decide: the oldest open card wins when two were filed', () => {
  const a = card({ identifier: 'BRO-A', createdAt: iso(4 * H) });
  const b = card({ identifier: 'BRO-B', createdAt: iso(1 * H) });
  assert.equal(afx.decide({ cards: [b, a], redObservedAt: NOW, nowMs: NOW, canFile: true }).card.identifier, 'BRO-A');
});

test('buildCard: both card kinds are pickable by a cloud worker and carry the exact key line + a safe VERIFY', () => {
  for (const key of ['workflow-red:opening-night-poller.yml', 'opening-night-sla:pages-stuck']) {
    const c = afx.buildCard({ key, alertTitle: 'Thing failed', alertDescription: 'why', runUrl: 'https://github.com/r/actions/runs/1', nowMs: NOW });
    assert.equal(startNowUnpickableReason({ title: c.title, description: c.description, priority: 2, mode: 'dispatch' }), null, key);
    assert.equal(afx.cardKey(c), key);
    assert.ok(verifyCommand({ description: c.description }), `${key}: VERIFY must be a safe form`);
    assert.match(c.description, /Do NOT dispatch opening-night-broadcast\.yml or opening-night-poller\.yml/);
  }
  assert.equal(afx.verifyCommandFor('workflow-red:opening-night-orchestrator.yml'), 'node scripts/check-workflow-run-status.js --workflow=opening-night-orchestrator.yml --expect=success');
});

test('cardKey: a key that is only a prefix of another key does not match', () => {
  assert.equal(afx.cardKey({ description: 'x\nauto-fix-first-key: workflow-red:opening-night-poller.yml\n' }), 'workflow-red:opening-night-poller.yml');
  assert.equal(afx.cardKey({ description: 'no key here' }), null);
});

const deps = (o = {}) => ({
  filed: [], comments: [], sent: [],
  async lookupCards() { return o.cards || []; },
  async fileCard(c) { this.filed.push(c); return { identifier: 'BRO-NEW', ...c }; },
  async comment(c, body) { this.comments.push({ c, body }); },
  async latestRedAt() { return o.red === undefined ? null : o.red; },
  async sendEscalation(a) { this.sent.push(a); return o.delivered !== false; },
});

test('gate: a fresh failure files the card and sends nothing', async () => {
  const d = deps();
  const r = await afx.gate({ key: 'workflow-red:opening-night-broadcast.yml', alertTitle: 'Broadcast failed', nowMs: NOW, env: {}, deps: d });
  assert.equal(r.email, false);
  assert.equal(r.action, 'file');
  assert.equal(d.filed.length, 1);
});

test('gate: a filing error emails at once with the could-not-start preamble', async () => {
  const d = deps(); d.fileCard = async () => { throw new Error('Linear down'); };
  const r = await afx.gate({ key: 'workflow-red:opening-night-broadcast.yml', alertTitle: 'x', nowMs: NOW, env: {}, deps: d });
  assert.equal(r.email, true);
  assert.equal(r.action, 'file-failed');
  assert.match(r.preamble, /could not be started \(Linear down\).*right away/);
  const r2 = await afx.gate({ key: 'k', alertTitle: 'x', nowMs: NOW, env: {}, deps: { lookupCards: async () => { throw new Error('boom'); } } });
  assert.equal(r2.email, true, 'a lookup error fails loud too');
});

test('gate: an escalation marks the card only through markEscalated (after delivery)', async () => {
  const d = deps({ cards: [card({ createdAt: iso(4 * H) })] });
  const r = await afx.gate({ key: 'workflow-red:opening-night-poller.yml', alertTitle: 'x', nowMs: NOW, env: {}, deps: d });
  assert.equal(r.email, true);
  assert.equal(r.reason, 'not-started');
  assert.equal(d.comments.length, 0);
  await r.markEscalated();
  assert.match(d.comments[0].body, new RegExp(`^${afx.ESCALATED_MARKER}`));
});

test('kill switch AUTO_FIX_FIRST_DISABLED=true restores immediate email and stops the sweep', async () => {
  const d = deps({ cards: [card({ createdAt: iso(4 * H) })], red: NOW });
  const r = await afx.gate({ key: 'k', alertTitle: 'x', nowMs: NOW, env: { AUTO_FIX_FIRST_DISABLED: 'true' }, deps: d });
  assert.equal(r.email, true);
  assert.equal(r.preamble, undefined);
  assert.deepEqual(await afx.sweep({ nowMs: NOW, env: { AUTO_FIX_FIRST_DISABLED: 'TRUE' }, deps: d }), []);
  assert.equal(d.filed.length + d.sent.length, 0);
});

test('sweep: escalates a still-red workflow once, marks it after delivery, never files', async () => {
  const started = card({ createdAt: iso(4 * H), startedAt: iso(3 * H), state: { type: 'started' } });
  const d = deps({ cards: [started], red: NOW - 10 * 60000 });
  const out = await afx.sweep({ nowMs: NOW, env: {}, deps: d });
  assert.equal(out.length, 3, 'one row per auto-fix-first workflow with a card');
  assert.ok(out.every((r) => r.action === 'escalate'));
  assert.equal(d.sent.length, 3);
  assert.equal(d.comments.length, 3);
  assert.equal(d.filed.length, 0);
  assert.match(d.sent[0].description, /still failing 4 hours later/);
});

test('sweep: an undelivered email leaves the card unmarked; one workflow error does not stop the rest', async () => {
  const d = deps({ cards: [card({ createdAt: iso(4 * H) })], delivered: false });
  await afx.sweep({ nowMs: NOW, env: {}, deps: d });
  assert.equal(d.comments.length, 0);
  let n = 0;
  const d2 = deps({ cards: [card({ createdAt: iso(1 * H) })] });
  d2.lookupCards = async () => { if (n++ === 0) throw new Error('Linear 500'); return [card({ createdAt: iso(1 * H) })]; };
  const out = await afx.sweep({ nowMs: NOW, env: {}, deps: d2 });
  assert.equal(out[0].action, 'error');
  assert.deepEqual(out.slice(1).map((r) => r.action), ['hold', 'hold']);
});

test('latestRedFromRuns: newest failure counts, success clears, in-progress and skipped decide nothing, a cancel with unknown jobs counts (fail loud)', () => {
  const t = '2026-10-16T11:00:00Z';
  assert.equal(afx.latestRedFromRuns([{ status: 'completed', conclusion: 'failure', updated_at: t }]), Date.parse(t));
  assert.equal(afx.latestRedFromRuns([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure', updated_at: t }]), null);
  assert.equal(afx.latestRedFromRuns([{ status: 'in_progress' }, { status: 'completed', conclusion: 'skipped' }, { status: 'completed', conclusion: 'cancelled', updated_at: t }]), Date.parse(t));
  assert.equal(afx.latestRedFromRuns([]), null);
});

test('CLI gate: a workflow outside the list writes nothing, so notify-failure emails as before', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'afx-')), 'out');
  fs.writeFileSync(out, '');
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'auto-fix-first.js');
  const r = spawnSync(process.execPath, [cli, 'gate'], { env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/check-secrets-health.yml@refs/heads/main', LINEAR_API_KEY: '' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), '');
  assert.equal(spawnSync(process.execPath, [cli, 'bogus']).status, 2);
});

test('decide: a worker that gave up (card back in Todo, startedAt set) escalates as not-started after the window', () => {
  const gaveUp = card({ createdAt: iso(4 * H), startedAt: iso(3 * H), state: { type: 'unstarted' } });
  assert.equal(decide([gaveUp], null), 'escalate:not-started');
});

test('decide: canceled without a Done sibling escalates only on red after the cancel; a Done sibling (VERIFY passed) holds', () => {
  const canceled = card({ createdAt: iso(2 * H), canceledAt: iso(1 * H), state: { type: 'canceled' } });
  assert.equal(decide([canceled], 0.5 * H), 'escalate:fix-canceled');
  assert.equal(decide([canceled], null), 'hold:fix-canceled-green', 'green pipeline: a canceled card is no reason to page or retry');
  assert.equal(decide([canceled], 1.5 * H), 'hold:fix-canceled-green', 'red only before the cancel');
  const done = card({ identifier: 'BRO-2', createdAt: iso(2 * H), completedAt: iso(0.5 * H), state: { type: 'completed' } });
  assert.equal(decide([canceled, done], null), 'hold:fix-just-closed', 'a duplicate canceled beside a Done card is not a failed fix');
});

test('sweep: unreadable GitHub runs count as still red (fail loud); not-started emails say the fix never ran; every escalation routes under a per-card page-worthy key', async () => {
  const started = card({ createdAt: iso(4 * H), state: { type: 'started' } });
  const d = deps({ cards: [started] });
  d.latestRedAt = async () => { throw new Error('HTTP 502'); };
  const out = await afx.sweep({ nowMs: NOW, env: {}, deps: d });
  assert.ok(out.every((r) => r.action === 'escalate' && r.reason === 'still-red'));
  assert.equal(d.sent[0].conditionKey, 'auto-fix-first:escalation:BRO-1');
  // The escalation goes through routeAlert(), so its key must be page-worthy or it is downgraded to the digest.
  const policy = require('./page-worthy-alerts.js');
  assert.ok(policy.isPageWorthy(d.sent[0].conditionKey), 'escalation key is page-worthy');
  const d2 = deps({ cards: [card({ createdAt: iso(4 * H) })] });
  await afx.sweep({ nowMs: NOW, env: {}, deps: d2 });
  assert.match(d2.sent[0].title, /no automatic fix has started/);
});

test('buildCard: the key line survives a markdown round-trip (own paragraph)', () => {
  const c = afx.buildCard({ key: 'opening-night-sla:pages-stuck', alertTitle: 't', nowMs: NOW });
  assert.match(c.description, /\n\nauto-fix-first-key: opening-night-sla:pages-stuck\n/);
});

test('decide: a fix stuck In Progress for 6h with no new red escalates as stalled', () => {
  const stuck = (ago) => card({ createdAt: iso(ago), state: { type: 'started' } });
  assert.equal(decide([stuck(5 * H)], 5 * H), 'hold:fix-in-progress');
  assert.equal(decide([stuck(6 * H)], 6 * H), 'escalate:stalled');
  assert.equal(decide([stuck(6 * H)], null), 'hold:fix-in-progress', 'the newest run passed: nothing to page');
});

test('the gate and the sweep send one escalation per card: same Resend key as routeAlert() derives for the escalation condition', () => {
  const router = require('./owner-alert-router.js');
  const c = { identifier: 'BRO-7' };
  const key = afx.escalationIdempotencyKey(c, NOW);
  assert.equal(key, router.alertIdempotencyKey('auto-fix-first:escalation:BRO-7', router.DEFAULT_COOLDOWN_HOURS, NOW));
  assert.notEqual(key, afx.escalationIdempotencyKey({ identifier: 'BRO-8' }, NOW), 'one key per card');
});

// ---- BRO-5541: one definition of a failing run, a second attempt, owner copy ----

const FIXTURE = require('./fixtures/auto-fix-first/poller-runs-2026-10-17T0756Z.json');

test('replay 2026-10-17 07:56Z (real poller runs): Express-preempted cancels are not failures, so the sweep sends nothing', async () => {
  const nowMs = Date.parse(FIXTURE.asOf);
  const poller = afx.workflowKey(FIXTURE.workflow);
  // The real BRO-5494 card (first attempt, Done 20:03Z) with its real key line.
  const bro5494 = { ...FIXTURE.card, id: 'x', url: 'https://linear.app/x/BRO-5494', title: 'Auto-fix: Opening Night Poller Failed', description: afx.buildCard({ key: poller, alertTitle: 'Opening Night Poller Failed', nowMs: Date.parse(FIXTURE.card.createdAt) }).description, comments: [] };
  const fetched = [];
  const d = deps();
  d.lookupCards = async (key) => (key === poller ? [bro5494] : []);
  d.latestRedAt = async (wf) => afx.latestRedAtFromRuns(wf === FIXTURE.workflow ? FIXTURE.runs : [], async (id) => { fetched.push(id); return FIXTURE.jobs[id]; });
  const out = await afx.sweep({ nowMs, env: {}, deps: d });
  assert.deepEqual(out.map((r) => `${r.action}:${r.reason}`), ['hold:fix-just-closed']);
  assert.equal(d.sent.length, 0, 'no owner email');
  assert.equal(d.filed.length, 0, 'no second attempt either: nothing failed');
  assert.equal(fetched.length, 5, 'jobs read only for the five cancels before the first deciding run');
  // The incident itself: counting every cancel as red (no jobs known) is what paged.
  const oldRed = afx.latestRedFromRuns(FIXTURE.runs);
  assert.equal(oldRed, Date.parse('2026-10-17T06:19:47Z'));
  assert.notEqual(afx.decide({ cards: [bro5494], redObservedAt: oldRed, nowMs, canFile: false }).action, 'hold');
});

test('runIsRed: a cancel is red only when its Notify step ran or was cut off; superseded, preempted and unfinished runs are not', () => {
  const run = (conclusion) => ({ status: 'completed', conclusion });
  const job = (...steps) => [{ steps: steps.map(([name, conclusion]) => ({ name, conclusion })) }];
  const N = afx.NOTIFY_STEP_NAME;
  assert.equal(afx.runIsRed(run('failure')), true);
  assert.equal(afx.runIsRed(run('timed_out')), true);
  assert.equal(afx.runIsRed(run('success')), false);
  assert.equal(afx.runIsRed(run('skipped')), false);
  assert.equal(afx.runIsRed({ status: 'in_progress', conclusion: null }), false);
  assert.equal(afx.runIsRed(run('cancelled'), job(['Check for Express preemption', 'success'], [N, 'skipped'])), false, 'Express takeover');
  assert.equal(afx.runIsRed(run('cancelled'), job([N, 'success'])), true, 'timeout-minutes hang: the pager paged');
  assert.equal(afx.runIsRed(run('cancelled'), job([N, 'cancelled'])), true, 'Notify cut off mid-send still counts');
  assert.equal(afx.runIsRed(run('cancelled'), []), false, 'pending run replaced in the concurrency queue');
  assert.equal(afx.runIsRed(run('cancelled'), [{ steps: [] }]), false, 'job never started a step');
  assert.equal(afx.runIsRed(run('cancelled'), job(['Set up job', 'success'])), true, 'no Notify step found: fail loud');
  assert.equal(afx.runIsRed(run('cancelled')), true, 'jobs unknown: fail loud');
  for (const id of Object.keys(FIXTURE.jobs)) assert.equal(afx.runIsRed({ status: 'completed', conclusion: 'cancelled' }, FIXTURE.jobs[id]), false, `real run ${id}`);
});

test('latestRedAtFromRuns: a jobs fetch error counts the cancel as red; a preempted cancel is passed over to the run below it', async () => {
  const t = '2026-10-16T11:00:00Z';
  const cancel = { id: 1, status: 'completed', conclusion: 'cancelled', updated_at: t };
  const fail = { id: 2, status: 'completed', conclusion: 'failure', updated_at: '2026-10-16T10:00:00Z' };
  assert.equal(await afx.latestRedAtFromRuns([cancel], async () => { throw new Error('HTTP 502'); }), Date.parse(t));
  const skipped = [{ steps: [{ name: afx.NOTIFY_STEP_NAME, conclusion: 'skipped' }] }];
  assert.equal(await afx.latestRedAtFromRuns([cancel, fail], async () => skipped), Date.parse(fail.updated_at));
  assert.equal(await afx.latestRedAtFromRuns([cancel, { status: 'completed', conclusion: 'success' }], async () => skipped), null);
});

test('decide: a first fix that did not hold files a second attempt; not-started and second attempts escalate', () => {
  assert.equal(decide([first({ createdAt: iso(4 * H), state: { type: 'started' } })], 0), 'retry:still-red');
  assert.equal(decide([first({ createdAt: iso(6 * H), state: { type: 'started' } })], 6 * H), 'retry:stalled');
  assert.equal(decide([first({ createdAt: iso(2 * H), canceledAt: iso(1 * H), state: { type: 'canceled' } })], 0.5 * H), 'retry:fix-canceled');
  assert.equal(decide([first({ createdAt: iso(5 * H), completedAt: iso(3 * H), state: { type: 'completed' } })], 1 * H), 'retry:red-after-fix');
  assert.equal(decide([first({ createdAt: iso(4 * H) })], null), 'escalate:not-started', 'no worker picked it up: a second card in the same pool would only delay the owner');
  assert.equal(afx.decide({ cards: [first({ createdAt: iso(4 * H), state: { type: 'started' } })], redObservedAt: NOW, nowMs: NOW, canFile: false }).attempt, 2);
  // Once attempt 2 exists, attempt 1 no longer decides anything.
  const old = first({ identifier: 'BRO-0', createdAt: iso(8 * H), canceledAt: iso(1 * H), state: { type: 'canceled' } });
  assert.equal(decide([old, card({ createdAt: iso(1 * H) })], 0), 'hold:fix-window');
  assert.equal(decide([old, card({ createdAt: iso(5 * H), completedAt: iso(3 * H), state: { type: 'completed' } })], 1 * H), 'escalate:red-after-fix');
});

test('buildCard: a second attempt is pickable, names the first card, carries its own attempt paragraph and the same key', () => {
  const key = 'workflow-red:opening-night-poller.yml';
  const c = afx.buildCard({ key, alertTitle: 'Poller failed', nowMs: NOW, attempt: 2, previous: { url: 'https://linear.app/x/BRO-1' } });
  assert.equal(startNowUnpickableReason({ title: c.title, description: c.description, priority: 2, mode: 'dispatch' }), null);
  assert.equal(c.title, 'Auto-fix (second try): Poller failed');
  assert.equal(afx.cardKey(c), key);
  assert.equal(afx.cardAttempt(c), 2);
  assert.match(c.description, /\n\nauto-fix-first-attempt: 2\n/);
  assert.match(c.description, /BRO-1/);
  assert.ok(verifyCommand({ description: c.description }));
  assert.equal(afx.alertTitleOf(c), 'Poller failed');
  assert.equal(afx.cardAttempt(afx.buildCard({ key, alertTitle: 't', nowMs: NOW })), 1);
});

const retryDeps = (o) => { const d = deps(o); d.superseded = []; d.supersede = async (c, body) => { d.superseded.push({ c, body }); }; return d; };

test('gate: a fresh failure after a failed first fix files the second attempt on Opus, retires the first card, sends nothing', async () => {
  const d = retryDeps({ cards: [first({ createdAt: iso(5 * H), completedAt: iso(3 * H), state: { type: 'completed' } })] });
  const r = await afx.gate({ key: 'workflow-red:opening-night-poller.yml', alertTitle: 'Poller failed', runUrl: 'https://github.com/r/actions/runs/9', nowMs: NOW, env: {}, deps: d });
  assert.equal(r.email, false);
  assert.equal(r.action, 'retry');
  assert.equal(d.filed.length, 1);
  assert.equal(d.filed[0].model, 'opus');
  assert.equal(afx.cardAttempt(d.filed[0]), 2);
  assert.match(d.superseded[0].body, new RegExp(`^${afx.SUPERSEDED_MARKER}.*attempt 2`));
  const d2 = retryDeps({ cards: [first({ createdAt: iso(5 * H), completedAt: iso(3 * H), state: { type: 'completed' } })] });
  d2.fileCard = async () => { throw new Error('Linear down'); };
  const r2 = await afx.gate({ key: 'workflow-red:opening-night-poller.yml', alertTitle: 'Poller failed', nowMs: NOW, env: {}, deps: d2 });
  assert.equal(r2.email, true, 'a second attempt that cannot be filed emails at once');
  assert.match(r2.preamble, /could not be started \(Linear down\)/);
});

test('gate: after the escalation email, later failures send nothing more (held)', async () => {
  const d = deps({ cards: [card({ createdAt: iso(4 * H), comments: [{ body: `${afx.ESCALATED_MARKER} x` }] })] });
  const r = await afx.gate({ key: 'workflow-red:opening-night-orchestrator.yml', alertTitle: 'x', nowMs: NOW, env: {}, deps: d });
  assert.equal(r.email, false);
  assert.equal(r.reason, 'already-escalated');
});

test('sweep: a first fix still red files the second attempt and emails nothing; a failed filing emails at once', async () => {
  const started = first({ createdAt: iso(4 * H), state: { type: 'started' } });
  const d = retryDeps({ cards: [started], red: NOW - 10 * 60000 });
  const out = await afx.sweep({ nowMs: NOW, env: {}, deps: d });
  assert.ok(out.every((r) => r.action === 'retry' && r.reason === 'still-red'));
  assert.equal(d.sent.length, 0);
  assert.equal(d.filed.length, 3);
  assert.equal(d.filed[0].title, 'Auto-fix (second try): Poller failed');
  assert.equal(d.superseded.length, 3);
  const d2 = retryDeps({ cards: [started], red: NOW - 10 * 60000 });
  d2.fileCard = async () => { throw new Error('Linear 500'); };
  const out2 = await afx.sweep({ nowMs: NOW, env: {}, deps: d2 });
  assert.ok(out2.every((r) => r.action === 'escalate' && r.reason === 'file-failed'));
  assert.equal(d2.sent.length, 3);
  assert.match(d2.sent[0].description, /could not be started \(Linear 500\)/);
  assert.match(d2.comments[0].body, new RegExp(`^${afx.ESCALATED_MARKER}`));
});

test('owner copy (owner 2026-10-16): never asks him to open Claude or do what a computer can do, no em dashes, says what broke and what happens next', () => {
  const banned = /claude|paste|open a session/i;
  const reasons = ['not-started', 'still-red', 'stalled', 'fix-canceled', 'red-after-fix', 'file-failed'];
  const texts = [];
  for (const reason of reasons) {
    for (const c of [card({ createdAt: iso(5 * H), completedAt: iso(2 * H) }), first({ createdAt: iso(5 * H), completedAt: iso(2 * H) })]) {
      for (const key of [...require('./page-worthy-alerts.js').AUTO_FIX_FIRST_WORKFLOWS].map(afx.workflowKey)) {
        const t = afx.escalationPreamble({ reason, card: c, error: 'Linear down', nowMs: NOW, what: afx.plainName(key) });
        assert.match(t, /^The (opening-night|nightly)/, `${reason}: says what broke first`);
        assert.match(t, /\nThe automation (has stopped|will not|tries)/, `${reason}: says what happens next`);
        texts.push(t);
      }
    }
  }
  const { OWNER_ACTIONS } = require('./page-worthy-alerts.js');
  for (const k of ['auto-fix-first:escalation:', 'opening-night-orchestrator.yml', 'opening-night-poller.yml']) texts.push(OWNER_ACTIONS[k]);
  for (const t of texts) {
    assert.doesNotMatch(t, banned, t);
    assert.ok(!t.includes('—'), `em dash in: ${t}`);
  }
  assert.match(afx.escalationPreamble({ reason: 'red-after-fix', card: card({ createdAt: iso(5 * H), completedAt: iso(2 * H) }), nowMs: NOW, what: 'X' }),
    /^X is still failing\. Two automatic fixes were tried\. The second finished at 2026-10-16T10:00:00Z, but it failed again afterwards\.\nThe automation has stopped retrying for now and will not email you about this again before 2026-10-17T07:00:00Z\. If it is still failing after that, it starts a new automatic fix by itself\.$/);
});

// BRO-5835: replay of the 2026-10-20 false escalation. BRO-5716 was filed
// 19:14:41Z, claimed 20:53Z, fix landed 21:06Z, parked to Backlog with a paused
// report + RECHECK-AFTER at 21:33Z. At 00:10Z the poller was green (no red).
test('replay BRO-5716 2026-10-20T00:10Z: a card parked with its fix landed holds, it is not "not-started"', () => {
  const at = (s) => Date.parse(s);
  const parkedCard = {
    identifier: 'BRO-5716', url: 'https://linear.app/x/BRO-5716', title: 'Auto-fix (second try): Opening Night Poller Failed',
    description: 'x\n\nauto-fix-first-key: workflow-red:opening-night-poller.yml\n\nauto-fix-first-attempt: 2\n',
    createdAt: '2026-10-19T19:14:41.374Z', startedAt: '2026-10-19T20:53:00.337Z', state: { type: 'backlog' },
    comments: [
      { body: '**Session report (paused)**\n\nFix landed. RECHECK-AFTER: 2026-10-20 recheck: node scripts/check-workflow-run-status.js', createdAt: '2026-10-19T21:33:03.691Z' },
      { body: 'Claimed by https://claude.ai/code/session_x at 2026-10-19T20:53:00.418Z', createdAt: '2026-10-19T20:53:00.601Z' },
    ],
  };
  const run = (redAt, nowMs = at('2026-10-20T00:10:00Z')) => {
    const v = afx.decide({ cards: [parkedCard], redObservedAt: redAt === null ? null : at(redAt), nowMs, canFile: false });
    return `${v.action}:${v.reason}`;
  };
  assert.equal(run(null), 'hold:fix-parked-awaiting-proof', 'poller green: nothing to page');
  assert.equal(run('2026-10-19T18:08:00Z'), 'hold:fix-parked-awaiting-proof', 'red from before the fix landed is the old failure');
  assert.equal(run('2026-10-19T22:20:00Z', at('2026-10-19T22:30:00Z')), 'hold:fix-parked-awaiting-proof', 'grace hour after the park');
  assert.equal(run('2026-10-19T23:00:00Z'), 'escalate:still-red', 'a run red after the fix landed is a failed fix (attempt 2 is the last try)');
});

test('decide: a paused report without RECHECK-AFTER, or one older than the card, is not a landed fix', () => {
  const base = { createdAt: iso(4 * H), startedAt: iso(3 * H), state: { type: 'backlog' } };
  const noStamp = card({ ...base, comments: [{ body: '**Session report (paused)**\n\ngave up', createdAt: iso(2 * H) }] });
  assert.equal(decide([noStamp], null), 'escalate:not-started');
  const stale = card({ ...base, comments: [{ body: '**Session report (paused)**\n\nRECHECK-AFTER: 2026-10-01', createdAt: iso(5 * H) }] });
  assert.equal(decide([stale], null), 'escalate:not-started');
});

test('escalationPreamble: a handed-back card (startedAt set) does not claim nobody picked it up', () => {
  const gaveUp = card({ createdAt: iso(4 * H), startedAt: iso(3 * H), state: { type: 'unstarted' } });
  const text = afx.escalationPreamble({ reason: 'not-started', card: gaveUp, nowMs: NOW });
  assert.match(text, /started on it but stopped without a fix/);
  assert.doesNotMatch(text, /no fix session picked it up/);
  assert.match(afx.escalationPreamble({ reason: 'not-started', card: card({ createdAt: iso(4 * H) }), nowMs: NOW }), /no fix session picked it up/);
});

test('decide: parked-fix edge cases (colon-less stamp, newest report wins, re-claimed card, attempt 1 retries on red)', () => {
  const parked = (o = {}) => ({ createdAt: iso(6 * H), startedAt: iso(5 * H), state: { type: 'backlog' }, comments: [{ body: '**Session report (paused)**\n\nFix landed. RECHECK-AFTER 2026-10-20', createdAt: iso(4 * H) }], ...o });
  assert.equal(decide([card(parked())], null), 'hold:fix-parked-awaiting-proof', 'colon-less stamp (shared parser) counts');
  const two = parked({ comments: [{ body: '**Session report (paused)**\n\nRECHECK-AFTER: 2026-10-20', createdAt: iso(5.5 * H) }, { body: '**Session report (paused)**\n\nRECHECK-AFTER: 2026-10-21', createdAt: iso(2 * H) }] });
  assert.equal(decide([card(two)], 3 * H), 'hold:fix-parked-awaiting-proof', 'red from before the NEWEST park is the old failure');
  assert.equal(decide([card(two)], 0.5 * H), 'escalate:still-red');
  assert.equal(decide([card(parked({ state: { type: 'started' } }))], null), 'hold:fix-in-progress', 're-claimed card takes the started path');
  assert.equal(decide([first(parked())], 0.5 * H), 'retry:still-red', 'a first attempt that goes red after parking files attempt 2');
});
