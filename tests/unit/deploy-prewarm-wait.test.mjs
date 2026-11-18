/**
 * BRO-7766: rebuild-fast.yml dispatches a pre-warmed vercel-deploy run at its
 * start; that run waits on the rebuild's core-data push, then builds. Locks:
 *  - decide(): proceed only on a successful push step, stop on anything final
 *  - trustPrewarm(): rebuild skips its own dispatch only for a live, young waiter
 *  - the step/job names the helper looks up exist in both workflows
 *  - the wiring: pre-warm dispatch, gate deferral, wait step, guarded cache save,
 *    alert/watchdog exclusions
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const H = require('../../scripts/lib/deploy-prewarm-wait.js');
const wd = require('../../scripts/lib/press-night-watchdog.js');
const wf = (f) => fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');
const step = (name, status, conclusion = null) => ({ name, status, conclusion });
const job = (steps, status = 'in_progress', conclusion = null) => ({ name: H.REBUILD_JOB, status, conclusion, steps });

/** The YAML block of one step, from its "- name:" line to the next one. */
function stepBlock(yml, name) {
  const lines = yml.split('\n');
  const i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `step "${name}" missing`);
  let j = i + 1;
  while (j < lines.length && !/^\s*- name: /.test(lines[j]) && !/^ {2}[a-z][\w-]*:\s*$/.test(lines[j])) j++;
  return lines.slice(i, j).join('\n');
}

test('decide: waits until the rebuild job and its push step exist and finish', () => {
  assert.equal(H.decide([]).state, 'wait');
  assert.equal(H.decide([job([step('Rebuild reviews.json', 'in_progress')])]).state, 'wait');
  assert.equal(H.decide([job([step(H.PUSH_STEP, 'queued')])]).state, 'wait');
  assert.equal(H.decide([job([step(H.PUSH_STEP, 'in_progress')])]).state, 'wait');
});

test('decide: proceeds only when the push step succeeded', () => {
  assert.equal(H.decide([job([step(H.PUSH_STEP, 'completed', 'success')])]).state, 'proceed');
  assert.equal(H.decide([job([step(H.PUSH_STEP, 'completed', 'skipped')])]).state, 'skip');
  assert.equal(H.decide([job([step(H.PUSH_STEP, 'completed', 'failure')])]).state, 'skip');
});

test('decide: a finished or cancelled job without the push stops the wait', () => {
  assert.equal(H.decide([job([], 'completed', 'cancelled')]).state, 'skip');
  assert.equal(H.decide([job([step(H.PUSH_STEP, 'pending')], 'completed', 'failure')]).state, 'skip');
});

test('trustPrewarm: only a live waiter for THIS rebuild, younger than TRUST_MIN', () => {
  const now = Date.parse('2026-11-18T16:00:00Z');
  const run = { id: 1, display_title: H.prewarmTitle(42), status: 'in_progress', created_at: '2026-11-18T15:50:00Z' };
  const jobs = (s) => [{ name: H.DEPLOY_JOB, steps: [step('Checkout', 'completed', 'success'), step(H.WAIT_STEP, s)] }];
  assert.equal(H.trustPrewarm(run, jobs('in_progress'), 42, now), true);
  assert.equal(H.trustPrewarm(run, jobs('queued'), 42, now), false, 'still in setup: may fail before waiting');
  assert.equal(H.trustPrewarm(run, jobs('completed'), 42, now), false);
  assert.equal(H.trustPrewarm(run, jobs('in_progress'), 43, now), false, 'another rebuild');
  assert.equal(H.trustPrewarm({ ...run, created_at: '2026-11-18T15:30:00Z' }, jobs('in_progress'), 42, now), false, 'near its cap');
  assert.equal(H.trustPrewarm({ ...run, status: 'completed' }, jobs('in_progress'), 42, now), false);
  assert.equal(H.trustPrewarm(run, [], 42, now), false);
});

test('the wait cap outlasts the trust window, so a trusted waiter cannot time out first', () => {
  assert.ok(H.CAP_MIN > H.TRUST_MIN);
});

test('step and job names the helper reads exist in the workflows', () => {
  const rf = wf('rebuild-fast.yml');
  const vd = wf('vercel-deploy.yml');
  assert.match(rf, new RegExp(`^    name: ${H.REBUILD_JOB}$`, 'm'));
  assert.match(rf, new RegExp(`- name: ${H.PUSH_STEP}\\n`));
  assert.match(vd, new RegExp(`^  ${H.DEPLOY_JOB}:\\n    needs: should-deploy`, 'm'));
  assert.match(vd, new RegExp(`- name: ${H.WAIT_STEP}\\n`));
  // run-name produces exactly the title trustPrewarm/findPrewarm match on
  assert.match(vd, /format\('Deploy to Vercel \(pre-warm for run \{0\}\)', inputs\.wait_for_run\)/);
  assert.equal(H.prewarmTitle(7), 'Deploy to Vercel (pre-warm for run 7)');
});

test('rebuild-fast dispatches the pre-warm early and skips its own dispatch only via --find-prewarm', () => {
  const rf = wf('rebuild-fast.yml');
  const pre = stepBlock(rf, 'Pre-warm the deploy');
  assert.match(pre, /wait_for_run="\$GITHUB_RUN_ID"/);
  assert.match(pre, /continue-on-error: true/);
  assert.match(pre, /vars\.DEPLOY_PREWARM_DISABLED != 'true'/, 'kill switch');
  assert.ok(rf.indexOf('- name: Pre-warm the deploy') < rf.indexOf('- name: Rebuild reviews.json'));
  const trig = stepBlock(rf, 'Trigger deploy (core data changed)');
  assert.match(trig, /--find-prewarm "\$GITHUB_RUN_ID" \|\| true/);
  assert.match(trig, /gh workflow run vercel-deploy\.yml \|\|/);
});

test('vercel-deploy: gate deferred for pre-warm, wait step before core data, cache save skipped on stop', () => {
  const vd = wf('vercel-deploy.yml');
  assert.match(stepBlock(vd, 'Content-aware deploy gate'), /if: inputs\.wait_for_run == ''/);
  assert.match(vd, /proceed: \$\{\{ steps\.check\.outputs\.proceed \|\| steps\.prewarm-gate\.outputs\.proceed \}\}/);
  const wait = stepBlock(vd, H.WAIT_STEP);
  assert.match(wait, /id: prewarm\n/);
  assert.match(wait, /deploy-prewarm-wait\.js "\$WAIT_FOR_RUN"/);
  assert.match(wait, /gh run cancel "\$GITHUB_RUN_ID"/);
  assert.match(wait, /sleep \d+/, 'self-cancel must block so no later step runs');
  assert.match(wait, /GATE_EVENT_NAME=workflow_dispatch node scripts\/lib\/should-deploy-gate\.js/);
  assert.match(wait, /SETUP=\$\(grep -E '\^\(package/);
  assert.match(wait, /\[ -z "\$SETUP" \] \|\| handoff/);
  const order = ['Install dependencies', 'Restore Next.js build + prebuild artifacts cache', H.WAIT_STEP, 'Checkout core data', 'Build', 'Deploy to Production', 'Save Next.js build + prebuild artifacts cache']
    .map((n) => vd.indexOf(`- name: ${n}\n`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'deploy job step order');
  for (const n of ['Save Next.js build + prebuild artifacts cache', 'Prune stale Next.js cache entries']) {
    assert.match(stepBlock(vd, n), /if: always\(\) && steps\.prewarm\.outputs\.go != 'false'/);
  }
  assert.match(stepBlock(vd, 'Dispatch async watermark + stage-latency update'), /deploy_sha="\$\(git rev-parse HEAD\)"/);
  assert.match(stepBlock(vd, 'Check if newer deploy is already queued'), /includes\('pre-warm'\)/);
});

test('watchdog: a pre-warm run is not mistaken for its own deploy dispatch', () => {
  const since = Date.parse('2026-11-18T16:00:00Z');
  const runs = [{ workflow: 'vercel-deploy.yml', displayTitle: H.prewarmTitle(5), createdAt: '2026-11-18T16:01:00Z' }];
  assert.equal(wd.findDispatchedRun(runs, { workflow: 'vercel-deploy.yml', showId: 'x', sinceMs: since }), undefined);
  runs.push({ workflow: 'vercel-deploy.yml', displayTitle: 'Deploy to Vercel', createdAt: '2026-11-18T16:02:00Z' });
  assert.equal(wd.findDispatchedRun(runs, { workflow: 'vercel-deploy.yml', showId: 'x', sinceMs: since }).displayTitle, 'Deploy to Vercel');
});

test('a pre-warm run gets the wait cap on top of the normal 45-min job budget', () => {
  const vd = wf('vercel-deploy.yml');
  const m = /timeout-minutes: \$\{\{ inputs\.wait_for_run && (\d+) \|\| 45 \}\}/.exec(vd);
  assert.ok(m, 'deploy job timeout must depend on wait_for_run');
  assert.ok(Number(m[1]) >= 45 + H.CAP_MIN + 3, 'setup (~3 min) + wait cap + the old budget');
});

test('only a definite "no push" stops quietly; doubt hands off, a failed hand-off fails loudly', () => {
  const wait = stepBlock(wf('vercel-deploy.yml'), H.WAIT_STEP);
  assert.match(wait, /if \[ "\$RC" -eq 10 \]; then stop_here/);
  assert.match(wait, /\[ "\$RC" -eq 0 \] \|\| handoff/);
  assert.match(wait, /proceed=false' "\$GATE_OUT"; then handoff/);
  assert.match(wait, /gh workflow run vercel-deploy\.yml \|\| \{ echo "::error::[^}]*exit 1; \}/);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/lib/deploy-prewarm-wait.js'), 'utf8'), /gave up after \$\{CAP_MIN\} min`\); process\.exit\(11\)/);
});

test('consumers that read vercel-deploy runs ignore pre-warm runs', () => {
  const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  assert.match(rd('.github/workflows/check-cron-health.yml'), /contains\("pre-warm"\) \| not/);
  assert.match(rd('.github/actions/dispatch-deploy/action.yml'), /contains\("pre-warm"\) \| not/);
  assert.match(rd('scripts/deploy-heartbeat.sh'), /includes\('pre-warm'\)/);
  assert.match(rd('scripts/check-prod-deploy.js'), /includes\('pre-warm'\)\) continue/);
  assert.match(rd('scripts/lib/gh-runs-query.sh'), /displayTitle: \.display_title/);
});

test('hand-off set covers every script the pre-wait deploy steps run', () => {
  const vd = wf('vercel-deploy.yml');
  const dep = vd.slice(vd.indexOf('\n  deploy:\n'));
  const pre = dep.slice(0, dep.indexOf(`- name: ${H.WAIT_STEP}\n`));
  const wait = stepBlock(vd, H.WAIT_STEP);
  const re = new RegExp(/SETUP=\$\(grep -E '([^']+)'/.exec(wait)[1]);
  for (const f of new Set(pre.match(/scripts\/[\w./-]+\.(?:js|sh|mjs)/g))) assert.ok(re.test(f), `${f} runs before the wait but is not in the hand-off set`);
  for (const f of ['package-lock.json', '.github/workflows/vercel-deploy.yml', 'src/config/feature-flags.ts']) assert.ok(re.test(f), f);
  for (const f of ['src/app/page.tsx', '.github/workflows/llm-ensemble-score.yml', 'data/shows.json']) assert.ok(!re.test(f), f);
});
