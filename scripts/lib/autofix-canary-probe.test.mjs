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
  // BRO-8094: the probe runs every core check, and the corpus checks parse the
  // 45MB reviews.json ~7x and shows.json ~13x (~5s idle). Under land-floor
  // load that hit the spawn timeout twice and refused good landings. None of
  // this test's assertions read the corpus, so serve empty stand-ins for it.
  const fs = require('node:fs');
  const CORPUS_STANDIN = /(?:^|[\\/])(reviews|shows)\.json$/;
  const realReadFileSync = fs.readFileSync;
  const corpusStandinReads = [];
  fs.readFileSync = function readFileSyncWithCorpusStandin(file, ...rest) {
    const m = typeof file === 'string' && file.match(CORPUS_STANDIN);
    if (!m) return realReadFileSync.call(fs, file, ...rest);
    corpusStandinReads.push(m[1]);
    const body = JSON.stringify({ _meta: { lastUpdated: new Date().toISOString() }, [m[1]]: [] });
    const enc = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].encoding;
    return enc ? body : Buffer.from(body);
  };
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
    console.log(JSON.stringify({ gitFetchCalls, assessmentCalls, row, deadmanRows, corpusStandinReads: corpusStandinReads.length, ms: Math.round(process.uptime() * 1000) }));
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
  const { gitFetchCalls, assessmentCalls, row, deadmanRows, corpusStandinReads, ms } = JSON.parse(result.stdout);
  // The stand-in must actually intercept, or the corpus cost (and the
  // load-dependent timeout) silently comes back.
  assert.ok(corpusStandinReads > 0, 'corpus reads must hit the stand-in');
  assert.deepEqual(assessmentCalls, { assessCanaryRow: 1, assessThroughputRow: 1 });
  assert.ok(row.status, 'the real canary health row must be evaluated');
  t.diagnostic(JSON.stringify({ row, gitFetchCalls: gitFetchCalls.length, corpusStandinReads, ms }));
  assert.deepEqual(gitFetchCalls, [], 'the side-effect-free live probe must never invoke git fetch');
  assert.deepEqual(deadmanRows, [{ unreadable: true, status: 'warn' }],
    'a ledger that cannot be fetched during a probe must remain unmeasurable');
});
