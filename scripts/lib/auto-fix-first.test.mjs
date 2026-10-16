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
const card = (o = {}) => ({ identifier: 'BRO-1', url: 'https://linear.app/x/BRO-1', createdAt: iso(1 * H), state: { type: 'unstarted' }, comments: [], ...o });
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

test('decide: an escalated card passes (alert emails as before), and cards older than 24h are a past incident', () => {
  const esc = card({ createdAt: iso(4 * H), comments: [{ body: `${afx.ESCALATED_MARKER} x` }] });
  assert.equal(decide([esc], 0), 'pass:already-escalated');
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

test('latestRedFromRuns: newest failure or cancel (a timed-out hang pages as cancelled) counts, success clears, in-progress and skipped decide nothing', () => {
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

test('decide: canceled without a Done sibling escalates even with no new red; a Done sibling (VERIFY passed) holds', () => {
  const canceled = card({ createdAt: iso(2 * H), canceledAt: iso(1 * H), state: { type: 'canceled' } });
  assert.equal(decide([canceled], null), 'escalate:fix-canceled');
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
  assert.match(d2.sent[0].title, /automatic fix never ran/);
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
