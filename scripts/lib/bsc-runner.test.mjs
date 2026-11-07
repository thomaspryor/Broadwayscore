// bsc-runner.js killSwitchEnv contract (BRO-286): each dispatcher is governed
// by ITS OWN kill switch at the runner level. bsc-next-path callers keep the
// default BSC_RUNNER_DISABLED; linear-next passes LINEAR_NEXT_DISABLED — so
// the morning-digest plist's BSC_RUNNER_DISABLED=1 (which only exists to keep
// the retired Notion-side auto-fix loop off, task #1311) cannot silently kill
// the Linear dispatch path. Tests require() the real runJob (CLAUDE.md §15).
//
// Test strategy: the kill-switch check is the FIRST statement in runJob, and
// the `if (!taskId || !prompt) throw` guard is the SECOND. Calling with no
// prompt therefore distinguishes the two outcomes without ever reaching the
// lease/worktree machinery: a kill-switch hit returns { stage:
// 'runner-disabled' }; passing the switch throws the requires-prompt error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseDispatchFloorGB, runJob, pidStartedNear, leaseLooksLive, PID_NULL_GRACE_MS } = require('./bsc-runner.js');
const { scanFile } = require('../audit-alert-senders.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('runJob: default kill switch is BSC_RUNNER_DISABLED', async () => {
  await withEnv({ BSC_RUNNER_DISABLED: '1', LINEAR_NEXT_DISABLED: undefined }, async () => {
    const res = await runJob({ taskId: 'test:kill-default' /* no prompt on purpose */ });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'runner-disabled');
  });
});

test('runJob: killSwitchEnv override — BSC_RUNNER_DISABLED=1 does NOT gate a linear-next dispatch', async () => {
  await withEnv({ BSC_RUNNER_DISABLED: '1', LINEAR_NEXT_DISABLED: undefined }, async () => {
    // Passing the check means execution reaches the requires-prompt throw —
    // that throw IS the proof the old kill switch was ignored.
    await assert.rejects(
      () => runJob({ taskId: 'test:kill-override', killSwitchEnv: 'LINEAR_NEXT_DISABLED' }),
      /requires taskId and prompt/
    );
  });
});

test('runJob: killSwitchEnv override — LINEAR_NEXT_DISABLED=1 gates the linear-next dispatch', async () => {
  await withEnv({ BSC_RUNNER_DISABLED: undefined, LINEAR_NEXT_DISABLED: '1' }, async () => {
    const res = await runJob({ taskId: 'test:kill-linear', killSwitchEnv: 'LINEAR_NEXT_DISABLED' });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'runner-disabled');
  });
});

// BRO-2421 regression: bsc-runner.js's disk-pressure path used to call
// sendAlert(email:true) directly, bypassing owner-alert-router.js's
// ACTION-only bar + dedup (fixed under BRO-417 by swapping to
// routeAlert(disposition:'digest')). Calls the SAME regex scanner
// audit-alert-senders.js's CI gate runs (not a reimplementation, CLAUDE.md
// §15) so a future direct sendAlert() bypass reintroduced into this file
// fails here too, not just in the separate CI lint job.
test('bsc-runner.js: no direct sendAlert(email:true) bypass of owner-alert-router (BRO-2421)', () => {
  const absPath = path.join(__dirname, 'bsc-runner.js');
  const findings = scanFile(absPath, 'scripts/lib/bsc-runner.js');
  const direct = findings.filter((f) => f.classification === 'direct');
  assert.deepEqual(direct, [], `expected no direct sendAlert bypass, found: ${JSON.stringify(direct)}`);

  const routed = findings.filter((f) => f.kind === 'routeAlert');
  assert.ok(routed.length >= 1, 'expected bsc-runner.js to route its alert(s) through routeAlert()');
});

// BRO-2465: exercise the shared implementation, including ps elapsed formats.
const IDENTITY_NOW = Date.parse('2026-10-20T12:00:00Z');
const identityLease = { pid: 4242, acquiredAt: new Date(IDENTITY_NOW - 3600_000).toISOString() };

test('pidStartedNear: matching process starts in portable ps elapsed formats', () => {
  for (const [elapsed, age] of [['01:00', 60_000], ['01:02:03', 3723_000], ['2-01:02:03', 176523_000]]) {
    const acquired = new Date(IDENTITY_NOW - age).toISOString();
    assert.equal(pidStartedNear(4242, acquired, IDENTITY_NOW, (command, args) => {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-o', 'etime=', '-p', '4242']);
      return elapsed;
    }), true, elapsed);
  }
});

test('pidStartedNear: recycled Claude pid with a different start time is dead', () => {
  assert.equal(pidStartedNear(4242, identityLease.acquiredAt, IDENTITY_NOW, () => '00:10'), false);
  assert.equal(pidStartedNear(4242, new Date(IDENTITY_NOW).toISOString(), IDENTITY_NOW, () => '01:00:00'), false);
});

test('pidStartedNear: missing pid, invalid timestamps, unreadable or malformed ps fail closed', () => {
  const never = () => { throw new Error('ps unavailable'); };
  for (const timestamp of [undefined, '', 'invalid']) {
    assert.equal(pidStartedNear(4242, timestamp, IDENTITY_NOW, never), false);
  }
  assert.equal(pidStartedNear(null, identityLease.acquiredAt, IDENTITY_NOW, never), false);
  assert.equal(pidStartedNear(4242, identityLease.acquiredAt, IDENTITY_NOW, never), false);
  assert.equal(pidStartedNear(4242, identityLease.acquiredAt, IDENTITY_NOW, () => 'unknown'), false);
});

test('pidStartedNear: real process-table data accepts this process and rejects an old lease', () => {
  assert.equal(pidStartedNear(process.pid, new Date().toISOString()), true);
  assert.equal(pidStartedNear(process.pid, '2020-01-01T00:00:00Z'), false);
});

test('leaseLooksLive: argv alone cannot validate a recycled Claude pid', () => {
  assert.equal(leaseLooksLive(identityLease, () => true, IDENTITY_NOW,
    (pid, acquiredAt, now) => pidStartedNear(pid, acquiredAt, now, () => '00:10')), false);
  assert.equal(leaseLooksLive(identityLease, () => true, IDENTITY_NOW,
    (pid, acquiredAt, now) => pidStartedNear(pid, acquiredAt, now, () => '01:00:00')), true);
  assert.equal(leaseLooksLive(identityLease, () => false, IDENTITY_NOW,
    () => { throw new Error('dead pid must not query start time'); }), false);
});

test('leaseLooksLive: recorded spawn time survives slow provisioning and rejects mismatches', () => {
  const lease = { ...identityLease, pidStartedAt: new Date(IDENTITY_NOW - 10_000).toISOString() };
  const startedNear = (pid, timestamp, now) => pidStartedNear(pid, timestamp, now, () => '00:10');
  assert.equal(leaseLooksLive(lease, () => true, IDENTITY_NOW, startedNear), true);
  assert.equal(leaseLooksLive({ ...lease, pidStartedAt: identityLease.acquiredAt }, () => true, IDENTITY_NOW, startedNear), false);
  assert.equal(leaseLooksLive({ ...lease, pidStartedAt: 'invalid' }, () => true, IDENTITY_NOW, startedNear), false);
});

test('leaseLooksLive: null-pid startup grace never queries process identity', () => {
  const never = () => { throw new Error('startup must not inspect ps'); };
  for (const [age, live] of [[1000, true], [PID_NULL_GRACE_MS, false]]) {
    assert.equal(leaseLooksLive({ pid: null, acquiredAt: new Date(IDENTITY_NOW - age).toISOString() }, never, IDENTITY_NOW, never), live);
  }
});

// BRO-4297: a blank env var is "unset", not 0 (which silently disabled the disk floor).
test('parseDispatchFloorGB: blank and whitespace fall back to the default, not 0', () => {
  const warnings = [];
  const warn = m => warnings.push(m);
  assert.equal(parseDispatchFloorGB('', warn), 5);
  assert.equal(parseDispatchFloorGB('   ', warn), 5);
  assert.equal(parseDispatchFloorGB(undefined, warn), 5);
  assert.equal(warnings.length, 0, 'unset/blank is not a typo, no warning');
  assert.equal(parseDispatchFloorGB('0', warn), 0, 'an explicit 0 still disables the floor');
  assert.equal(parseDispatchFloorGB(' 12 ', warn), 12);
  assert.equal(parseDispatchFloorGB('abc', warn), 5);
  assert.equal(parseDispatchFloorGB('-3', warn), 5);
  assert.equal(warnings.length, 2);
});
