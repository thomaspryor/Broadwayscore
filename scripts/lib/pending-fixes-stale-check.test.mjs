import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stalePlans, readPlans, describeStale } = require('./pending-fixes-stale-check.js');
const { evaluate } = require('../cloud-doctor.js');

const NOW = Date.parse('2026-10-22T00:00:00Z');
const day = (n) => new Date(NOW - n * 864e5).toISOString();

test('only pending plans older than 7 days are stale, oldest first', () => {
  const s = stalePlans([
    { planId: 'a', status: 'pending', createdAt: day(30) },
    { planId: 'b', status: 'pending', createdAt: day(3) },
    { planId: 'c', status: 'applied', createdAt: day(60) },
    { planId: 'd', status: 'pending', createdAt: day(90) },
  ], { now: NOW });
  assert.deepEqual(s.map((x) => x.id), ['d', 'a']);
});

test('a pending plan with no usable date is not called stale', () => {
  assert.deepEqual(stalePlans([{ planId: 'x', status: 'pending', createdAt: 'nope' }, { planId: 'y', status: 'pending' }], { now: NOW }), []);
});

test('evaluate skips the row when stalePendingPlans is absent', () => {
  assert.equal(evaluate({ cloud: false, showsJson: true, coreSymlink: true, reviewCopyIsCheckout: true, resolvedReviewTexts: '/x', deps: {}, ghPush: true, fixWorkflowState: 'active', secretsOk: true, hooks: { ok: true } }, { now: NOW }).find((r) => r.id === 'pending-fixes'), undefined);
});

test('describeStale is null when nothing is stale and names ids when it is', () => {
  assert.equal(describeStale([]), null);
  assert.match(describeStale(stalePlans([{ planId: '925', status: 'pending', createdAt: day(29) }], { now: NOW })), /1 pending fix plan.*925 \(29d\)/);
});

test('readPlans reads a directory and labels each plan by its file name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  fs.writeFileSync(path.join(dir, 'bro-1.json'), JSON.stringify({ status: 'pending', createdAt: day(20) }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  const plans = readPlans(dir);
  assert.equal(plans.length, 1);
  assert.deepEqual(stalePlans(plans, { now: NOW }).map((x) => x.id), ['bro-1']);
});

test('cloud-doctor warns on stale pending plans and stays ok otherwise', () => {
  const base = { cloud: true, showsJson: true, coreSymlink: true, reviewCopyIsCheckout: true, resolvedReviewTexts: '/x', deps: {}, ghPush: true, fixWorkflowState: 'active', secretsOk: true, hooks: { ok: true }, coreClone: null, reviewClone: null };
  const warn = evaluate({ ...base, stalePendingPlans: stalePlans([{ planId: '925', status: 'pending', createdAt: day(29) }], { now: NOW }) }, { now: NOW }).find((r) => r.id === 'pending-fixes');
  assert.equal(warn.level, 'warn');
  const ok = evaluate({ ...base, stalePendingPlans: [] }, { now: NOW }).find((r) => r.id === 'pending-fixes');
  assert.equal(ok.level, 'ok');
});
