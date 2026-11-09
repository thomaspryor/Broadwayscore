import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stalePlans, stillNeededReason, readPlans, describeStale } = require('./pending-fixes-stale-check.js');
const { evaluate } = require('../cloud-doctor.js');

const NOW = Date.parse('2026-10-22T00:00:00Z');
const day = (n) => new Date(NOW - n * 864e5).toISOString();

test('only unresolved plans older than 7 days are stale, oldest first', () => {
  const s = stalePlans([
    { planId: 'a', status: 'pending', createdAt: day(30) },
    { planId: 'b', status: 'pending', createdAt: day(3) },
    { planId: 'c', status: 'applied', createdAt: day(60) },
    { planId: 'd', status: 'pending', createdAt: day(90) },
    { planId: 'partial', status: 'partial', createdAt: day(40) },
    { planId: 'failed', status: 'validation-failed', createdAt: day(20) },
    { planId: 'rejected', status: 'rejected', createdAt: day(60) },
    { planId: 'superseded', status: 'superseded', createdAt: day(60) },
    { planId: 'unknown', status: 'unknown', createdAt: day(60) },
  ], { now: NOW });
  assert.deepEqual(s.map((x) => x.id), ['d', 'partial', 'a', 'failed']);
});

test('unresolved plans with no usable date are not called stale', () => {
  for (const status of ['pending', 'partial', 'validation-failed']) {
    assert.deepEqual(stalePlans([{ planId: 'x', status, createdAt: 'nope' }, { planId: 'y', status }], { now: NOW }), []);
  }
});

test('the seven-day boundary is strict for every unresolved status', () => {
  for (const status of ['pending', 'partial', 'validation-failed']) {
    const plans = [
      { planId: 'boundary', status, createdAt: day(7) },
      { planId: 'just-over', status, createdAt: new Date(NOW - 7 * 864e5 - 1).toISOString() },
      { planId: 'recent', status, createdAt: day(1) },
      { planId: 'future', status, createdAt: day(-1) },
    ];
    assert.deepEqual(stalePlans(plans, { now: NOW }).map((p) => p.id), ['just-over']);
  }
});

test('evaluate skips the row when stalePendingPlans is absent', () => {
  assert.equal(evaluate({ cloud: false, showsJson: true, coreSymlink: true, reviewCopyIsCheckout: true, resolvedReviewTexts: '/x', deps: {}, ghPush: true, fixWorkflowState: 'active', secretsOk: true, hooks: { ok: true } }, { now: NOW }).find((r) => r.id === 'pending-fixes'), undefined);
});

test('describeStale is null when nothing is stale and names ids when it is', () => {
  assert.equal(describeStale([]), null);
  assert.match(describeStale(stalePlans([{ planId: '925', status: 'pending', createdAt: day(29) }], { now: NOW })), /1 unresolved fix plan.*925 \(29d: not triaged/);
});

test('readPlans reads a directory and labels each plan by its file name', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'bro-1.json'), JSON.stringify({ status: 'pending', createdAt: day(20) }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  const plans = readPlans(dir);
  assert.equal(plans.length, 1);
  assert.deepEqual(stalePlans(plans, { now: NOW }).map((x) => x.id), ['bro-1']);
});

test('cloud-doctor warns on every stale unresolved status and stays ok otherwise', () => {
  const base = { cloud: true, showsJson: true, coreSymlink: true, reviewCopyIsCheckout: true, resolvedReviewTexts: '/x', deps: {}, ghPush: true, fixWorkflowState: 'active', secretsOk: true, hooks: { ok: true }, coreClone: null, reviewClone: null };
  for (const status of ['pending', 'partial', 'validation-failed']) {
    const warn = evaluate({ ...base, stalePendingPlans: stalePlans([{ planId: status, status, createdAt: day(29) }], { now: NOW }) }, { now: NOW }).find((r) => r.id === 'pending-fixes');
    assert.equal(warn.level, 'warn');
    assert.match(warn.detail, /1 unresolved fix plan\(s\) older than 7 days/);
    assert.ok(warn.detail.includes(`${status} (29d: not triaged`));
    assert.doesNotMatch(warn.detail, /never applied/);
  }
  const ok = evaluate({ ...base, stalePendingPlans: [] }, { now: NOW }).find((r) => r.id === 'pending-fixes');
  assert.equal(ok.level, 'ok');
});

// BRO-7092: only plans whose triage still finds needed work count, each with a named reason.
test('a triaged plan counts only while its triage finds still-needed work, and names why', () => {
  const at = day(2);
  const plans = [
    { planId: 'needed', status: 'partial', createdAt: day(30), executedAt: day(29), triage: { at, verdict: 'still-needed', stillNeededReason: 'op 3: x.json is still counted' } },
    { planId: 'needed-no-reason', status: 'partial', createdAt: day(30), triage: { at, verdict: 'still-needed' } },
    { planId: 'settled', status: 'partial', createdAt: day(30), triage: { at, verdict: 'resolved' } },
    { planId: 'obsolete', status: 'pending', createdAt: day(30), triage: { at, verdict: 'obsolete' } },
    { planId: 'untriaged', status: 'partial', createdAt: day(31) },
    { planId: 'rerun-after-triage', status: 'partial', createdAt: day(32), executedAt: day(1), triage: { at, verdict: 'resolved' } },
  ];
  const s = stalePlans(plans, { now: NOW });
  assert.deepEqual(s.map((x) => x.id), ['rerun-after-triage', 'untriaged', 'needed', 'needed-no-reason']);
  assert.equal(s.find((x) => x.id === 'needed').reason, 'op 3: x.json is still counted');
  assert.match(s.find((x) => x.id === 'needed-no-reason').reason, /still-needed ops/);
  assert.match(s.find((x) => x.id === 'untriaged').reason, /not triaged/);
  assert.match(s.find((x) => x.id === 'rerun-after-triage').reason, /not triaged/);
  for (const x of s) assert.ok(x.reason && x.reason.length > 0, `${x.id} has a named reason`);
  assert.match(describeStale(s), /needed \(\d+d: op 3: x\.json is still counted\)/);
  assert.equal(stillNeededReason({ triage: { at, verdict: 'resolved' } }), null);
});

test('the real plans directory: every stale plan carries a named reason', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'pending-fixes');
  for (const s of stalePlans(readPlans(dir))) assert.ok(typeof s.reason === 'string' && s.reason.trim(), `${s.id} has no reason`);
});
