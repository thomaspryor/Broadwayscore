import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Use a fresh process so every module captures the subprocess spies before
// loading. Run the real probe and assessments, with external transports offline.
function runOfflineProbe() {
  const cp = require('node:child_process');
  const gitFetchCalls = [];
  for (const method of ['execSync', 'execFileSync']) {
    cp[method] = (command, args) => {
      if ((command === 'git' && args.includes('fetch')) ||
          (method === 'execSync' && /\bgit\s+(?:\S+\s+)*fetch\b/.test(command))) {
        gitFetchCalls.push(method);
      }
      // No real subprocesses, including Git's implicit partial-clone fetches.
      return '';
    };
  }
  global.fetch = async () => { throw new Error('offline probe'); };
  require('node:https').request = () => { throw new Error('offline probe'); };
  const gh = require('./scripts/lib/gh-api-cache.js');
  gh.cachedShell = () => '[]';
  gh.cachedFetch = async () => [];
  gh.hasLowHeadroom = () => true;
  // Linear can also load credentials from .env. Stub its read transports
  // directly so an offline failure does not wait through network retries.
  const linear = require('./scripts/lib/linear-client.js');
  linear.listOpenIssuesWithDescriptions = async () => [];
  linear.getIssue = async () => null;
  linear.listIssueComments = async () => [];

  const canary = require('./scripts/lib/autofix-canary.js');
  const assessmentCalls = { assessCanaryRow: 0, assessThroughputRow: 0 };
  for (const name of Object.keys(assessmentCalls)) {
    const real = canary[name];
    canary[name] = (...args) => {
      assessmentCalls[name]++;
      return real(...args);
    };
  }
  const deadman = require('./scripts/lib/push-retry-deadman.js');
  const realAssessDeadman = deadman.assessPushRetryDeadman;
  const deadmanRows = [];
  deadman.assessPushRetryDeadman = (...args) => {
    const row = realAssessDeadman(...args);
    deadmanRows.push({ unreadable: args[0] === null, status: row.status });
    return row;
  };
  const { probeHealthRowLive } = require('./scripts/lib/health-row-probe.js');
  return (async () => {
    const name = 'Autofix: daily canary (dispatch pipeline proof)';
    const result = await probeHealthRowLive(name);
    const row = { name, verdict: result.verdict, status: result.matched?.status };
    console.log(JSON.stringify({ gitFetchCalls, assessmentCalls, row, deadmanRows }));
  })();
}

test('BRO-3823: the real live probe assesses the autofix canary without git fetch', (t) => {
  const result = spawnSync(process.execPath, ['-e', `(${runOfflineProbe.toString()})().catch(() => { process.exitCode = 1; });`], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    // Keep credentials out of the child so credential-gated checks stay offline.
    env: { PATH: process.env.PATH, GIT_NO_LAZY_FETCH: '1' },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error || 'probe failed'));
  const { gitFetchCalls, assessmentCalls, row, deadmanRows } = JSON.parse(result.stdout);
  assert.deepEqual(assessmentCalls, { assessCanaryRow: 1, assessThroughputRow: 1 });
  assert.ok(row.status, 'the real canary health row must be evaluated');
  t.diagnostic(JSON.stringify({ row, gitFetchCalls: gitFetchCalls.length }));
  assert.deepEqual(gitFetchCalls, [], 'the side-effect-free live probe must never invoke git fetch');
  assert.deepEqual(deadmanRows, [{ unreadable: true, status: 'warn' }],
    'a ledger that cannot be fetched during a probe must remain unmeasurable');
});
