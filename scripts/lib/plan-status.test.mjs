// BRO-5015: an unknown plan status must refuse, not report already-applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { planStatusAction, planRunOrigin, alreadyAppliedResult } = require('./plan-status.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('pending runs, finished statuses skip, anything else refuses', () => {
  assert.equal(planStatusAction('pending'), 'run');
  for (const s of ['applied', 'partial', 'rejected', 'validation-failed', 'superseded']) assert.equal(planStatusAction(s), 'already-applied');
  for (const s of ['approved', undefined, '', 'Pending']) assert.equal(planStatusAction(s), 'error');
});

test('execute-approved-fix.js reports error for an "approved" plan', () => {
  const id = `plan-status-test-${process.pid}`;
  const plan = path.join(ROOT, 'data/pending-fixes', `${id}.json`);
  const out = path.join(os.tmpdir(), `${id}.out`);
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, JSON.stringify({ planId: 'p1', status: 'approved', plan: { actions: [] } }));
  fs.writeFileSync(out, '');
  try {
    const r = spawnSync(process.execPath, ['scripts/execute-approved-fix.js'], {
      cwd: ROOT, encoding: 'utf8',
      env: { PATH: process.env.PATH, ISSUE_NUMBER: id, PLAN_ID: 'p1', GITHUB_OUTPUT: out },
    });
    assert.match(fs.readFileSync(out, 'utf8'), /result=error/, r.stderr);
    assert.match(r.stderr, /not one the executor knows/);
  } finally {
    fs.rmSync(plan, { force: true });
    fs.rmSync(out, { force: true });
  }
});

// BRO-5647: a session plan finished outside CI must not read as done.
test('alreadyAppliedResult: a session plan a local run finished is applied-elsewhere; untagged, CI and reader plans are already-applied', () => {
  assert.equal(alreadyAppliedResult('bro-1', { status: 'applied' }), 'already-applied');
  assert.equal(alreadyAppliedResult('bro-1', { status: 'applied', executedIn: 'local' }), 'applied-elsewhere');
  assert.equal(alreadyAppliedResult('bro-1', { status: 'applied', executedIn: 'ci' }), 'already-applied');
  assert.equal(alreadyAppliedResult('925', { status: 'applied', executedIn: 'local' }), 'already-applied');
  assert.equal(alreadyAppliedResult('925-systematic', { status: 'applied' }), 'already-applied');
  assert.equal(planRunOrigin({ GITHUB_ACTIONS: 'true' }), 'ci');
  assert.equal(planRunOrigin({}), 'local');
});

test('execute-approved-fix.js reports applied-elsewhere for a session plan marked applied by a local run', () => {
  // No bro- prefix: pending-fix-plans.test.mjs reads every bro-*.json in this folder
  // in parallel, and this file would vanish under it.
  const id = `plan-status-elsewhere-test-${process.pid}`;
  const plan = path.join(ROOT, 'data/pending-fixes', `${id}.json`);
  const out = path.join(os.tmpdir(), `${id}.out`);
  fs.writeFileSync(plan, JSON.stringify({ planId: 'p1', status: 'applied', executedIn: 'local', plan: { actions: [] } }));
  fs.writeFileSync(out, '');
  try {
    const r = spawnSync(process.execPath, ['scripts/execute-approved-fix.js'], {
      cwd: ROOT, encoding: 'utf8',
      env: { PATH: process.env.PATH, ISSUE_NUMBER: id, PLAN_ID: 'p1', GITHUB_OUTPUT: out },
    });
    assert.match(fs.readFileSync(out, 'utf8'), /result=applied-elsewhere/, r.stderr);
    assert.match(r.stderr, /by a local execute-approved-fix run/);
  } finally {
    fs.rmSync(plan, { force: true });
    fs.rmSync(out, { force: true });
  }
});
