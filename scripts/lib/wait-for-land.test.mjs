// BRO-4671: the land waiter must report a refused land run, not just the ref
// disappearing. Each case below is a poll result seen during real landings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { landVerdict, readLatestRun, prodPlan, prodVerdict, parseArgs, sitePathsIn, firstLine, lastLine } = require('./wait-for-land.js');
const waitForLand = require('./wait-for-land.js');
const { MAX_ATTEMPTS } = require('./land-retry-on-cancel.js');

test('diagnostic first lines are bounded before parsing large messages', () => {
  assert.equal(firstLine('request failed\nresponse body'), 'request failed');
  assert.equal(firstLine('x'.repeat(501)), 'x'.repeat(500));
  assert.equal(firstLine('x'.repeat(499) + '\nignored'), 'x'.repeat(499));
  assert.equal(firstLine('\nsecond line'), '');
  assert.equal(firstLine(null), '');
  assert.equal(firstLine(''), '');
});

test('prod diagnostics retain the final nonblank line and stdout/stderr fallback', () => {
  assert.equal(lastLine('  checking\n  not live yet\r\n\n '), '  not live yet');
  assert.equal(lastLine('  live\n'), 'live');
  assert.equal(lastLine('checking\n' + 'x'.repeat(501)), 'x'.repeat(500));
  assert.equal(lastLine(' \n '), '');
  assert.equal(lastLine(null), '');
  assert.equal(lastLine(' \n ') || lastLine('warning\nfailed\n'), 'failed');
});

test('newline-heavy diagnostics fit in a constrained heap without a line array', () => {
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', `
    const assert = require('node:assert/strict');
    const { firstLine, lastLine } = require(${JSON.stringify(require.resolve('./wait-for-land.js'))});
    const message = 'request failed\\n' + '\\n'.repeat(16 * 1024 * 1024) + 'last status\\n';
    assert.equal(firstLine(message), 'request failed');
    assert.equal(lastLine(message), 'last status');
  `], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, `child signal=${child.signal}: ${child.stderr.slice(0, 2000)}`);
});

test('the prod polling caller logs bounded final lines and falls back to stderr', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const cp = require('node:child_process');
    cp.execFileSync = (cmd, args) => {
      assert.equal(cmd, 'git');
      if (args[0] === 'ls-remote') return 'a'.repeat(40) + '\\trefs/heads/main\\n';
      if (args[0] === 'rev-parse') return 'false\\n';
      if (args[0] === 'fetch') return '';
      assert.fail('unexpected git command: ' + args.join(' '));
    };
    let result;
    cp.spawnSync = () => result;
    const { waitForProd } = require(${JSON.stringify(require.resolve('./wait-for-land.js'))});
    const logged = [];
    console.log = (s) => logged.push(s);
    (async () => {
      for (const [stdout, stderr, expected] of [
        ['checking\\nLIVE on prod\\n', '', 'LIVE on prod'],
        [' \\n ', 'checking\\nstderr verdict\\n', 'stderr verdict'],
        ['checking\\n' + 'x'.repeat(501), '', 'x'.repeat(500)],
      ]) {
        result = { status: 0, stdout, stderr };
        assert.equal(await waitForProd({ siteFiles: ['src/app/page.tsx'], prodMin: 1 }), 0);
        assert.equal(logged.at(-1).slice(16), expected);
      }
    })().catch((err) => { console.error(err); process.exitCode = 1; });
  `], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr.slice(0, 2000));
});

const TIP = '057156419a666b690b937354092729af67ceb092';
const NOW = Date.parse('2026-10-05T05:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const run = (over) => ({ id: 1, head_sha: TIP, status: 'completed', conclusion: 'success', updated_at: minsAgo(2), ...over });
const verdict = (args) => landVerdict({ nowMs: NOW, ...args });

test('ref gone after being seen means landed, unless its run went red', () => {
  assert.equal(verdict({ refSha: null, lastSha: TIP, run: run({ status: 'in_progress', conclusion: null }) }).verdict, 'landed');
  assert.equal(verdict({ refSha: null, lastSha: TIP, run: null }).verdict, 'landed');
  const byHand = verdict({ refSha: null, lastSha: TIP, run: run({ conclusion: 'failure' }) });
  assert.equal(byHand.verdict, 'unknown', 'deleted after a refusal is not a landing');
  const olderRed = verdict({ refSha: null, lastSha: TIP, run: run({ head_sha: 'f'.repeat(40), conclusion: 'failure' }) });
  assert.equal(olderRed.verdict, 'landed', 'a red run for an older tip says nothing about the tip that went');
});

test('a ref missing from the first poll needs a RECENT green run to count as landed', () => {
  assert.equal(verdict({ refSha: null, run: null }).verdict, 'unknown', 'typo');
  const before = verdict({ refSha: null, run: run() });
  assert.equal(before.verdict, 'landed');
  assert.equal(before.before, true);
  assert.equal(verdict({ refSha: null, run: run({ updated_at: minsAgo(60 * 24 * 7) }) }).verdict, 'unknown', 'reused name, weeks-old run');
  assert.equal(verdict({ refSha: null, run: run({ conclusion: 'failure' }) }).verdict, 'unknown', 'never pushed, last run red');
});

test('a red run for the current tip is a refusal (the case the ref-only loop missed for ~1h)', () => {
  for (const conclusion of ['failure', 'timed_out', 'startup_failure', 'action_required', 'stale']) {
    const v = verdict({ refSha: TIP, run: run({ conclusion }) });
    assert.equal(v.verdict, 'refused', conclusion);
    assert.match(v.why, new RegExp(conclusion));
  }
});

test('a confirmed eviction keeps waiting, names the retry, and flags it once stale', () => {
  const cancelled = { id: 37260205885, conclusion: 'cancelled', cancellation: { kind: 'eviction' } };
  const fresh = verdict({ refSha: TIP, run: run(cancelled) });
  assert.equal(fresh.verdict, 'waiting');
  assert.match(fresh.why, /land-retry-cancelled\.js --run=37260205885/);
  const stale = verdict({ refSha: TIP, run: run({ ...cancelled, updated_at: minsAgo(45) }) });
  assert.equal(stale.verdict, 'waiting');
  assert.match(stale.why, /30\+ min ago and not re-run/);
  assert.match(fresh.why, /the sweep will re-run it/);
  assert.doesNotMatch(stale.why, /retries spent/);
});

// BRO-6031: once the sweep's budget is spent, say so instead of "retries spent?".
test('an eviction on the last attempt says retries are spent and how to restart', () => {
  const spent = verdict({ refSha: TIP, run: run({ id: 1, conclusion: 'cancelled', run_attempt: MAX_ATTEMPTS, cancellation: { kind: 'eviction' } }) });
  assert.equal(spent.verdict, 'waiting');
  assert.match(spent.why, new RegExp(`attempt ${MAX_ATTEMPTS} of ${MAX_ATTEMPTS}: retries spent`));
  assert.match(spent.why, /new commit/);
  assert.doesNotMatch(spent.why, /land-retry-cancelled/);
  const early = verdict({ refSha: TIP, run: run({ id: 2, conclusion: 'cancelled', run_attempt: 2, cancellation: { kind: 'eviction' } }) });
  assert.match(early.why, /attempt 2 of \d+\); the sweep will re-run it/);
});

// BRO-6015: sessions told to hand-retry, or re-pushing a new ref, lost their place in line.
test('a parked run keeps waiting and says not to re-push or hand-retry, even when old', () => {
  const parked = { id: 39837811040, conclusion: 'cancelled', cancellation: { kind: 'eviction', why: 'land-parked-behind-deep-queue' } };
  const stuck = verdict({ refSha: TIP, run: run({ ...parked, updated_at: minsAgo(200) }) });
  assert.equal(stuck.verdict, 'waiting');
  assert.match(stuck.why, /parked 3\+ h.*--run=39837811040/);
  assert.match(stuck.why, /Do not push a new land ref/);
  for (const r of [run(parked), run({ ...parked, updated_at: minsAgo(120) })]) {
    const v = verdict({ refSha: TIP, run: r });
    assert.equal(v.verdict, 'waiting');
    assert.match(v.why, /parked in the landing line/);
    assert.match(v.why, /do not push a new land ref/);
    assert.doesNotMatch(v.why, /--run=/);
  }
});

test('a deadline cancellation is refused immediately and cannot prove a landing after ref deletion', () => {
  const timed = run({ conclusion: 'cancelled', cancellation: { kind: 'timeout', why: 'Land job exceeded its execution time limit' } });
  const v = verdict({ refSha: TIP, run: timed });
  assert.equal(v.verdict, 'refused');
  assert.match(v.why, /timed out.*Land/);
  assert.doesNotMatch(v.why, /retries spent|land-retry-cancelled/);
  assert.equal(verdict({ refSha: null, lastSha: TIP, run: timed }).verdict, 'unknown');
  assert.equal(verdict({ refSha: TIP, run: { ...timed, head_sha: 'f'.repeat(40) } }).verdict, 'waiting');
});

test('unknown cancellations do not promise a queue retry; mid-work cancellations are refused', () => {
  const unknown = verdict({ refSha: TIP, run: run({ conclusion: 'cancelled' }) });
  assert.equal(unknown.verdict, 'waiting');
  assert.doesNotMatch(unknown.why, /sweep|retries spent|land-retry-cancelled/);
  const v = verdict({ refSha: TIP, run: run({ conclusion: 'cancelled', cancellation: { kind: 'other', why: 'land-started-work' } }) });
  assert.equal(v.verdict, 'refused');
  assert.match(v.why, /land-started-work/);
});

test('readLatestRun uses the timeout annotation, not elapsed time, and caches by attempt', () => {
  // Actual Land job annotation on both 38184188732 and 38197860150 (BRO-5131).
  const annotation = { message: 'The job has exceeded the maximum execution time of 15m0s' };
  const r = run({ id: 38197860150, head_branch: 'land/bro-5073-shipcheck', run_attempt: 1, conclusion: 'cancelled' });
  let land = { id: 114653977654, name: 'Land', conclusion: 'cancelled', steps: [{ conclusion: 'success' }, { conclusion: 'cancelled' }] };
  let annotations = [annotation, { message: 'The operation was canceled.' }];
  const calls = [];
  const read = (endpoint) => {
    calls.push(endpoint);
    if (endpoint.includes('event=workflow_dispatch')) return { workflow_runs: [] };
    if (endpoint.includes('/workflows/land.yml/runs?')) return { workflow_runs: [r] };
    if (endpoint.includes('/jobs?')) return { jobs: [{ name: 'Checks', conclusion: 'success' }, land] };
    if (endpoint.includes('/annotations?')) return annotations;
    assert.fail(`unexpected endpoint: ${endpoint}`);
  };
  const opts = { read, cache: new Map() };
  const poll = () => readLatestRun(r.head_branch, opts);
  assert.equal(verdict({ refSha: TIP, run: poll() }).verdict, 'refused');
  assert.equal(poll().cancellation.kind, 'timeout');
  assert.equal(calls.filter((c) => c.includes('/jobs?')).length, 1);
  assert.equal(calls.filter((c) => c.includes('/annotations?')).length, 1);

  r.run_attempt = 2;
  annotations = [{ message: 'The operation was canceled.' }];
  land = { ...land, steps: [{ conclusion: 'cancelled' }] };
  assert.equal(poll().cancellation.kind, 'eviction', 'a re-run must not inherit the old timeout');
  r.run_attempt = 3;
  land = { ...land, steps: [{ conclusion: 'success' }, { conclusion: 'cancelled' }] };
  assert.equal(poll().cancellation.kind, 'other', 'a manual mid-work cancel is not a timeout or eviction');
  r.run_attempt = 4;
  land = { ...land, conclusion: 'timed_out' };
  assert.equal(poll().cancellation.kind, 'timeout', 'explicit job timeout also counts');
  r.conclusion = 'success';
  const before = calls.length;
  assert.equal(poll().conclusion, 'success');
  assert.equal(calls.length - before, 2, 'ordinary polls list push and dispatch runs');
});

test('a red run for an OLDER tip says nothing about a fresh push', () => {
  const v = verdict({ refSha: TIP, run: run({ head_sha: 'f'.repeat(40), conclusion: 'failure' }) });
  assert.equal(v.verdict, 'waiting');
});

test('queued, in-progress, missing and green-but-ref-still-there all keep waiting', () => {
  assert.equal(verdict({ refSha: TIP, run: run({ status: 'queued', conclusion: null }) }).verdict, 'waiting');
  assert.equal(verdict({ refSha: TIP, run: run({ status: 'in_progress', conclusion: null }) }).verdict, 'waiting');
  assert.equal(verdict({ refSha: TIP, run: null }).verdict, 'waiting');
  assert.equal(verdict({ refSha: TIP, run: run({ conclusion: 'success' }) }).verdict, 'waiting');
  assert.equal(verdict({ refSha: TIP, run: run({ conclusion: 'skipped' }) }).verdict, 'waiting', 'skipped/neutral wait out the timeout');
});

test('parseArgs takes a land/ ref and a positive whole-minute timeout', () => {
  assert.deepEqual(parseArgs(['land/bro-4619-welcome-onboarding']), { ref: 'land/bro-4619-welcome-onboarding', timeoutMin: 60, prodMin: null });
  assert.deepEqual(parseArgs(['land/job/linear-BRO-2067-muuqf9tn', '30']), { ref: 'land/job/linear-BRO-2067-muuqf9tn', timeoutMin: 30, prodMin: null });
  assert.equal(parseArgs([]), null);
  assert.equal(parseArgs(['bro-4619-welcome-onboarding']), null, 'bare branch name, the same mistake that broke a land.yml dispatch');
  assert.equal(parseArgs(['land/x', '0']), null);
  assert.equal(parseArgs(['land/x', '08']), null);
  assert.equal(parseArgs(['land/x;rm -rf /']), null);
});

// BRO-5836: --prod keeps waiting past LANDED until the change is live, so a
// session does not stop at LANDED and idle NOT SAFE TO EXIT for days.
test('parseArgs takes --prod anywhere, with an optional whole-minute budget', () => {
  assert.deepEqual(parseArgs(['land/x', '60', '--prod']), { ref: 'land/x', timeoutMin: 60, prodMin: 40 });
  assert.deepEqual(parseArgs(['--prod=25', 'land/x']), { ref: 'land/x', timeoutMin: 60, prodMin: 25 });
  assert.equal(parseArgs(['land/x', '--prod=0']), null);
  assert.equal(parseArgs(['land/x', '--prod=abc']), null);
  assert.equal(parseArgs(['land/x', '60', '30']), null, 'a stray positional is a typo, not ignored');
});

test('prodPlan skips the wait only when the branch provably changes no deploy-gate path', () => {
  const main = 'b'.repeat(40);
  const none = prodPlan({ mainSha: main, siteFiles: [] });
  assert.equal(none.watch, false);
  assert.equal(none.nothingToDeploy, true, 'a hooks/docs-only landing never deploys before the 6h backstop');
  assert.equal(prodPlan({ mainSha: main, siteFiles: ['src/app/page.tsx'] }).watch, true);
  assert.equal(prodPlan({ mainSha: main, siteFiles: null }).watch, true, 'ref never seen (landed before the wait) or diff failed: wait');
  const noMain = prodPlan({ mainSha: null, siteFiles: [] });
  assert.equal(noMain.watch, false);
  assert.notEqual(noMain.nothingToDeploy, true, 'no main tip is unchecked, never "nothing to deploy"');
});

test('prodVerdict: live, not yet, and can-not-tell are three different things', () => {
  const at = { nowMs: 0, deadlineMs: 1000 };
  assert.equal(prodVerdict({ checkExit: 0, errors: 0, ...at }).verdict, 'live');
  assert.equal(prodVerdict({ checkExit: 1, errors: 0, ...at }).verdict, 'waiting');
  assert.equal(prodVerdict({ checkExit: 2, errors: 1, ...at }).verdict, 'waiting', 'one failed check is retried');
  assert.equal(prodVerdict({ checkExit: 2, errors: 3, ...at }).verdict, 'gave-up', 'a 403 loop stops early instead of burning the budget');
  assert.equal(prodVerdict({ checkExit: -1, errors: 3, ...at }).verdict, 'gave-up', 'a killed check counts as can-not-tell');
  assert.equal(prodVerdict({ checkExit: 1, errors: 0, nowMs: 1000, deadlineMs: 1000 }).verdict, 'gave-up');
  assert.equal(prodVerdict({ checkExit: 0, errors: 0, nowMs: 5000, deadlineMs: 1000 }).verdict, 'live', 'live on the last check still counts');
});

test('sitePathsIn reads SITE_PATHS as git pathspecs and refuses a possibly-cut file list', () => {
  assert.deepEqual(sitePathsIn(['.claude/hooks/verify-edits.sh', 'docs/x.md', '.github/workflows/land.yml']), [], 'hooks/docs/workflows never deploy');
  assert.deepEqual(sitePathsIn(['src/app/page.tsx', 'docs/x.md']), ['src/app/page.tsx']);
  assert.deepEqual(sitePathsIn(['scripts/lib/wait-for-land.js']), ['scripts/lib/wait-for-land.js'], 'scripts/ is a deploy path (prebuild)');
  assert.deepEqual(sitePathsIn(['package.json', 'package.json.bak', 'srcs/x']), ['package.json'], 'files match exactly, directories by prefix');
  assert.equal(sitePathsIn(Array.from({ length: 300 }, (_, i) => `docs/${i}.md`)), null, 'the compare API caps files at 300');
  assert.equal(sitePathsIn(null), null);
});

// BRO-6257 (BRO-6040 recurrence): wait-for-land.js OOMed in Runtime_StringSplit
// on 2026-10-25. The split was landIdentityFromChecks() splitting and mapping a
// whole Checks job log (gh's maxBuffer is 64 MB) for every hand-dispatched land
// run on every poll. Reproduced pre-fix: a 60 MB log needed >128 MB of heap,
// and the old parser OOMs on the 24 MB log below in this 64 MB heap.
const { forEachLine, firstLine: sharedFirstLine } = require('./log-lines.js');

test('BRO-6257: forEachLine matches split semantics, stops early and caps long lines', () => {
  const walk = (text, opts) => { const out = []; forEachLine(text, (l, n, t) => { out.push([l, n, t]); }, opts); return out; };
  for (const text of ['', 'a', 'a\n', '\nb', 'a\n\nb\n', 'x\r\ny']) {
    assert.deepEqual(walk(text).map(([l]) => l), text.split('\n'), JSON.stringify(text));
  }
  assert.deepEqual(walk(null).map(([l]) => l), ['']);
  assert.deepEqual(walk('abcdef\nxy', { maxLineLength: 3 }), [['abc', 0, true], ['xy', 1, false]]);
  const seen = [];
  assert.equal(forEachLine('a\nb\nc', (l) => { seen.push(l); return l === 'b'; }), true);
  assert.deepEqual(seen, ['a', 'b'], 'returning true stops the walk');
  assert.equal(forEachLine('a\nb', () => undefined), false);
  assert.equal(sharedFirstLine, firstLine, 'wait-for-land and check-prod-deploy share one firstLine');
});

test('BRO-6257: every job-log parser on the wait-for-land path runs a 24 MB log in a 64 MB heap', () => {
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', `
    const assert = require('node:assert/strict');
    const lib = (f) => require(${JSON.stringify(path.dirname(require.resolve('./wait-for-land.js')))} + '/' + f);
    const { landIdentityFromChecks } = lib('land-run-identity.js');
    const { prodProofFromLog } = lib('deploy-log-proof.js');
    const { firstFailingTestNameInJobLog, firstFailingTestFileInJobLog } = lib('main-red-streak.js');
    const sha = 'a'.repeat(40);
    const head = '2026-10-22T18:23:35.7452531Z   BRANCH: land/x\\n2026-10-22T18:24:35.2144324Z [command]/usr/bin/git log -1 --format=%H\\n2026-10-22T18:24:35.2173902Z ' + sha + '\\n';
    const filler = '2026-10-22T18:25:00.0000000Z ok 1 - test\\n'.repeat(Math.floor(24e6 / 43));
    // Markers at the top (early exit), at the bottom (full walk), and absent.
    assert.deepEqual(landIdentityFromChecks(head + filler), { branch: 'land/x', sha });
    assert.deepEqual(landIdentityFromChecks(filler + head), { branch: 'land/x', sha });
    assert.equal(landIdentityFromChecks(filler), null);
    const deploy = '2026-10-22T18:30:00.0000000Z deployment h.vercel.app: ready (state=READY, x)\\n2026-10-22T18:30:01.0000000Z Deployed to production: https://h.vercel.app\\n';
    assert.equal(prodProofFromLog(filler + deploy).url, 'h.vercel.app');
    assert.equal(prodProofFromLog(filler), null);
    const tap = '2026-10-22T18:31:00.0000000Z not ok 7 - broke\\n2026-10-22T18:31:00.0000000Z   location: /w/scripts/lib/x.test.mjs:1:1\\n';
    assert.equal(firstFailingTestNameInJobLog(filler + tap), 'broke');
    assert.equal(firstFailingTestFileInJobLog(filler + tap), 'scripts/lib/x.test.mjs');
    assert.equal(firstFailingTestNameInJobLog(filler), null);
    // One giant line is never copied whole either.
    assert.equal(landIdentityFromChecks('  BRANCH: land/' + 'y'.repeat(24e6)), null);
  `], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, `child signal=${child.signal}: ${child.stderr.slice(0, 2000)}`);
});

test('BRO-6257: wait-for-land and the libs that parse gh/log output never split it whole', () => {
  // Guard for the class: a whole-text split on gh/log output is how BRO-6040
  // and BRO-6257 OOMed. Walk lines with log-lines.js forEachLine instead.
  const dir = path.dirname(require.resolve('./wait-for-land.js'));
  for (const f of ['wait-for-land.js', 'land-run-identity.js', 'land-retry-on-cancel.js', 'deploy-log-proof.js', 'log-lines.js', '../check-prod-deploy.js']) {
    const code = readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /\.split\(/, `${f}: use forEachLine/firstLine from log-lines.js, not .split(`);
  }
  const red = readFileSync(path.join(dir, 'main-red-streak.js'), 'utf8');
  assert.doesNotMatch(red, /jobLogText[^\n]*\.split\(/, 'main-red-streak.js job-log parsers must walk lines lazily');
});

test('BRO-6257: cached dispatch identities do not pin their Checks logs (real readLatestLandRun cache)', () => {
  // Live 2026-10-26: Checks logs are ~15.6 MB each and a waiter resolves every
  // hand dispatch newer than the ref's push run. A cached SHA sliced from a log
  // kept that whole log alive, so 12 x 8 MB logs here need ~100 MB pre-fix.
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', `
    const assert = require('node:assert/strict');
    const { readLatestLandRun } = require(${JSON.stringify(path.join(path.dirname(require.resolve('./wait-for-land.js')), 'land-run-identity.js'))});
    const runs = Array.from({ length: 12 }, (_, i) => ({ id: 1000 - i, event: 'workflow_dispatch', run_attempt: 1, status: 'completed', conclusion: 'success', created_at: '2026-10-25T00:00:00Z', updated_at: 'u' + i }));
    const cache = new Map();
    const read = (endpoint) => {
      if (endpoint.includes('event=push')) return { workflow_runs: [] };
      if (endpoint.includes('event=workflow_dispatch')) return { workflow_runs: runs };
      return { jobs: [{ id: Number(endpoint.match(/runs\\/(\\d+)/)[1]), name: 'Checks', conclusion: 'success' }] };
    };
    const readText = (endpoint) => {
      const id = endpoint.match(/jobs\\/(\\d+)/)[1];
      const head = 'T0Z   BRANCH: land/r-' + id + '\\nT0Z [command]/usr/bin/git log -1 --format=%H\\nT0Z ' + id.padStart(40, 'a') + '\\n';
      return Buffer.from(head + 'T0Z ok 1 - filler line\\n'.repeat(Math.floor(8e6 / 24))).toString(); // fresh flat string, like gh output
    };
    const latest = readLatestLandRun('land/r-995', { repo: 'o/r', read, readText, cache });
    assert.equal(latest.id, 995);
    assert.equal(latest.head_sha, '995'.padStart(40, 'a'));
    assert.equal([...cache.keys()].filter((k) => k.startsWith('checks:')).length, 12);
  `], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, `child signal=${child.signal}: ${child.stderr.slice(0, 2000)}`);
});

// BRO-6638: after LANDED the waiter prints the main sha the tip became.
function fakeIo({ rowsSeq, fetchOk = true }) {
  let t = 0; let n = 0; const waits = [];
  return {
    waits,
    io: {
      fetch: () => fetchOk,
      rows: () => { const r = rowsSeq[Math.min(n, rowsSeq.length - 1)]; n += 1; if (r instanceof Error) throw r; return r; },
      wait: async (ms) => { waits.push(ms); t += ms; },
      now: () => t,
    },
  };
}

test('reportLandedSha: finds the row after the ledger commit lags one look', async () => {
  const { io, waits } = fakeIo({ rowsSeq: [[], [{ tip: 'aaa111', sha: 'bbb222' }]] });
  assert.equal(await waitForLand.reportLandedSha('aaa111', { io }), 'bbb222');
  assert.deepEqual(waits, [60_000]);
});

test('reportLandedSha: stays inside its budget when no row ever appears (train rider)', async () => {
  const { io, waits } = fakeIo({ rowsSeq: [[]] });
  assert.equal(await waitForLand.reportLandedSha('aaa111', { io }), null);
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 150_000, `waited ${waits}`);
});

test('reportLandedSha: null tip, failed fetch and unreadable ledger never throw', async () => {
  assert.equal(await waitForLand.reportLandedSha(null), null);
  assert.equal(await waitForLand.reportLandedSha('aaa111', { io: fakeIo({ rowsSeq: [[]], fetchOk: false }).io }), null);
  const { io, waits } = fakeIo({ rowsSeq: [new Error('path does not exist')] });
  assert.equal(await waitForLand.reportLandedSha('aaa111', { io }), null);
  assert.deepEqual(waits, []);
});
