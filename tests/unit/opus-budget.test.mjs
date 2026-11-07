// BRO-6684: daily Opus budget, its use in pickLinearModel, claim dedupe, and the create_session Opus check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('../../scripts/lib/opus-budget.js');
const { pickLinearModel } = require('../../scripts/lib/bsc-next-model.js');
const { opusClaimEntries } = require('../../scripts/lib/cloud-worker-pick.js');
const L = require('../../scripts/lib/opus-launch-check.js');

const NOW = Date.parse('2026-10-31T04:00:00Z');
const H = 3_600_000;

test('default cap is 4 a day; unknown count fails open', () => {
  assert.deepEqual(B.decideOpusBudget({ opusLaunches24h: 1, usage: null, nowMs: NOW }).remaining, 3);
  assert.equal(B.decideOpusBudget({ opusLaunches24h: 9, usage: null, nowMs: NOW }).remaining, 0);
  assert.equal(B.decideOpusBudget({ opusLaunches24h: null, usage: null, nowMs: NOW }).remaining, B.OPUS_DAILY_CAP);
});

test('weekly warning stops non-P0 Opus; room near the reset lifts the cap', () => {
  const far = { status: 'allowed', resetsAt: (NOW + 100 * H) / 1000 };
  const near = { status: 'allowed', resetsAt: (NOW + 20 * H) / 1000 };
  assert.equal(B.decideOpusBudget({ opusLaunches24h: 0, usage: { ...near, status: 'allowed_warning' }, nowMs: NOW }).remaining, 0);
  assert.equal(B.decideOpusBudget({ opusLaunches24h: 9, usage: far, nowMs: NOW }).remaining, 0);
  const lifted = B.decideOpusBudget({ opusLaunches24h: 9, usage: near, nowMs: NOW });
  assert.equal(lifted.cap, null);
  assert.equal(lifted.remaining, Infinity);
  assert.equal(B.decideOpusBudget({ opusLaunches24h: 0, usage: { status: 'something_new', resetsAt: far.resetsAt }, nowMs: NOW }).remaining, 4, 'unknown status = default cap');
  // A reset already in the past is stale data, not a lift.
  assert.equal(B.decideOpusBudget({ opusLaunches24h: 9, usage: { status: 'allowed', resetsAt: (NOW - H) / 1000 }, nowMs: NOW }).remaining, 0);
});

test('recorded usage is read back, and ignored once stale', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opus-budget-')), 'u.json');
  B.recordUsage({ status: 'allowed', resetsAt: '1793905200', type: 'seven_day', file, now: new Date(NOW) });
  assert.deepEqual(B.readUsage({ file, nowMs: NOW + H }), { status: 'allowed', resetsAt: 1793905200 });
  assert.equal(B.readUsage({ file, nowMs: NOW + 7 * H }), null);
  assert.throws(() => B.recordUsage({ status: 'allowed', resetsAt: 'x', type: 'seven_day', file }));
  // A five-hour limit always resets within 30h: recording it would lift the cap all week.
  assert.throws(() => B.recordUsage({ status: 'allowed', resetsAt: '1793905200', type: 'five_hour', file }), /seven_day/);
});

const card = (o = {}) => ({ identifier: 'BRO-1', priority: 3, description: '', comments: { nodes: [] }, ...o });
const pick = (issue, opusBudget) => pickLinearModel({ explicitFlag: null, issue, taskId: `linear:${issue.identifier}`, readEntries: () => [], opusBudget });

test('a card Opus line spends the budget, then runs on Sonnet', () => {
  const budget = { remaining: 1, reason: 'test' };
  const opusLine = card({ description: 'Do it.\n\nModel: Opus' });
  assert.equal(pick(opusLine, budget).model, 'opus');
  assert.equal(budget.remaining, 0);
  const second = pick(opusLine, budget);
  assert.equal(second.model, 'sonnet');
  assert.match(second.reason, /Opus budget is spent/);
  assert.equal(pick(opusLine, null).model, 'opus', 'no budget passed = old behavior');
});

test('P0s and retries keep Opus with the budget spent', () => {
  const spent = { remaining: 0, reason: 'test' };
  assert.equal(pick(card({ priority: 1 }), spent).model, 'opus');
  assert.equal(pick(card({ priority: 1, description: 'Model: Opus' }), spent).model, 'opus');
  const one = { remaining: 1, reason: 't' };
  pick(card({ priority: 1, description: 'Model: Opus' }), one);
  assert.equal(one.remaining, 1, 'a P0 does not spend the budget');
  assert.equal(pick(card({ comments: { nodes: [{ body: 'Dispatched to a worker' }] } }), spent).model, 'opus');
  assert.equal(pick(card(), spent).model, 'sonnet');
});

test('Opus claims count once per card', () => {
  const c = (id, ts) => ({ body: 'Claimed\nWorker model: opus', createdAt: ts, issue: { identifier: id } });
  const rows = opusClaimEntries([c('BRO-1', '2026-10-31T01:00:00Z'), c('BRO-1', '2026-10-31T01:05:00Z'), c('BRO-2', '2026-10-31T02:00:00Z')]);
  assert.deepEqual(rows.map((r) => r.taskId), ['linear:BRO-1', 'linear:BRO-2']);
});

const input = (ti) => ({ tool_name: 'mcp__claude-code-remote__create_session', tool_input: { model: 'claude-opus-5-5', title: 'BRO-1: x', prompt: 'MODEL-REASON: x\nBUDGET: 3h', ...ti } });
const deps = (issue, budget = { remaining: 4, reason: 't' }) => ({ env: {}, getIssue: async () => issue, loadBudget: async () => budget });

test('launch check: Sonnet sessions and the kill switch are untouched', async () => {
  assert.equal(await L.evaluate(input({ model: 'claude-sonnet-5-5' }), deps(card())), null);
  assert.equal(await L.evaluate(input({}), { ...deps(card()), env: { OPUS_BUDGET_DISABLED: '1' } }), null);
});

test('launch check: a P2 card with no Opus line cannot start an Opus session', async () => {
  const r = await L.evaluate(input({}), deps(card()));
  assert.match(r.deny, /card policy puts this session on Sonnet/);
  assert.ok(L.toHookOutput(r).hookSpecificOutput.permissionDecision === 'deny');
});

test('launch check: Opus allowed by the card policy, or when the owner asked', async () => {
  assert.equal(await L.evaluate(input({}), deps(card({ priority: 1 }))), null);
  assert.equal(await L.evaluate(input({}), deps(card({ description: 'Model: Opus' }))), null);
  assert.match((await L.evaluate(input({}), deps(card({ description: 'Model: Opus' }), { remaining: 0, reason: 't' }))).deny, /budget is spent/);
  assert.equal(await L.evaluate(input({ prompt: 'OWNER-ASKED-OPUS: "use opus for this"\nBUDGET: 2h' }), deps(card())), null);
});

test('launch check: no card, long budget, unreadable card', async () => {
  assert.match((await L.evaluate(input({ title: 'Some work' }), deps(card()))).deny, /names no card/);
  assert.match((await L.evaluate(input({ prompt: 'OWNER-ASKED-OPUS: yes\nBUDGET: 6h' }), deps(card()))).deny, /at most BUDGET: 4h/);
  assert.equal(await L.evaluate(input({}), deps(null)), null, 'fails open');
  assert.deepEqual(L.cardIds({ title: 'BRO-12: a', tags: ['bro-12', 'bro-7'] }), ['BRO-12', 'BRO-7']);
  assert.deepEqual(L.cardIds({ title: 'BRO-5: follow-up to BRO-3', tags: ['config:x'] }), ['BRO-5']);
});
