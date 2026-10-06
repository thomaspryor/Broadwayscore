import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflow } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-2358: opening-night-poller's concurrency group holds one running + one
 * pending run, so every extra dispatch cancels the older pending one. The
 * orchestrator used to give up waiting after 75min (pollers run 90-150min) and
 * dispatch again every 15min, cancelling 6 of 8 auto runs on 2026-10-04.
 */

const poller = loadWorkflow('opening-night-poller.yml');
const orch = loadWorkflow('opening-night-orchestrator.yml');

function orchestratorLoopScript() {
  for (const job of Object.values(orch.jobs)) {
    for (const step of job.steps || []) {
      if (step.run && step.run.includes('gh workflow run opening-night-poller.yml')) return step.run;
    }
  }
  throw new Error('orchestrator poll-loop step not found');
}

test('poller never cancels in-progress runs and groups per show/market', () => {
  assert.equal(poller.concurrency['cancel-in-progress'], false);
  assert.match(poller.concurrency.group, /inputs\.show_id \|\| inputs\.market/);
});

test('orchestrator loop script is valid bash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-'));
  const f = join(dir, 'loop.sh');
  // GitHub expressions are not bash; neutralise them for the syntax check.
  writeFileSync(f, orchestratorLoopScript().replace(/\$\{\{[^}]*\}\}/g, '1'));
  const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('orchestrator re-waits on a still-active previous poller run instead of dispatching', () => {
  const s = orchestratorLoopScript();
  const guard = s.indexOf('PREV_STILL_ACTIVE=false');
  const dispatch = s.indexOf('gh workflow run opening-night-poller.yml');
  assert.ok(guard > -1 && guard < dispatch, 'active-run guard must precede the first dispatch');
  for (const st of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    assert.ok(s.includes(st), `guard must treat ${st} as active`);
  }
  assert.match(s, /PREV_POLLER_RUN_ID="\$RUN_ID"/);
  // every dispatch sits inside the else branch of the guard
  const elseIdx = s.indexOf('else', s.indexOf('if [ "$PREV_STILL_ACTIVE" = "true" ]'));
  assert.ok(dispatch > elseIdx, 'dispatch must be in the not-active branch');
});

test('guard behaves: simulated active previous run skips dispatch, completed dispatches', () => {
  const s = orchestratorLoopScript();
  const start = s.indexOf('PREV_STILL_ACTIVE=false');
  const end = s.lastIndexOf('if [ -n "$RUN_ID" ]; then', s.indexOf('PREV_POLLER_RUN_ID="$RUN_ID"'));
  assert.ok(start > -1 && end > start);
  const body = s.slice(start, end).replace(/\$\{\{[^}]*\}\}/g, '1');
  const dir = mkdtempSync(join(tmpdir(), 'orchsim-'));
  const run = (status) => {
    const script = `
sleep() { :; }
gh() { if [ "$1 $2" = "run view" ]; then echo ${status}; else echo "GH:$*"; fi; }
PREV_POLLER_RUN_ID=42; POLLER_ARGS=""; SHOWS="a,b"; PRE=""
${body}
echo "RUN_ID=$RUN_ID"
`;
    const f = join(dir, `${status}.sh`);
    writeFileSync(f, script);
    return spawnSync('bash', [f], { encoding: 'utf8' }).stdout;
  };
  const active = run('in_progress');
  assert.match(active, /RUN_ID=42/);
  assert.doesNotMatch(active, /GH:workflow run/);
  const done = run('completed');
  assert.match(done, /GH:workflow run opening-night-poller\.yml/);
  // gh failure (empty status) must not fall through to a blind dispatch
  const unknown = run('""');
  assert.match(unknown, /RUN_ID=42/);
  assert.doesNotMatch(unknown, /GH:workflow run/);
});
