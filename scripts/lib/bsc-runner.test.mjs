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

const require = createRequire(import.meta.url);
const { runJob } = require('./bsc-runner.js');

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
