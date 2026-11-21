// Guard for scripts/lib/run-test-batch-bounded.sh (BRO-7113 cousin): a test-file
// child that never exits must fail the batch within its bound and be named, while
// a batch that finishes passes its exit code through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'run-test-batch-bounded.sh');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-batch-'));
  const fast = join(dir, 'fast.test.mjs');
  const failing = join(dir, 'failing.test.mjs');
  const wedged = join(dir, 'wedged.test.mjs');
  writeFileSync(fast, "import { test } from 'node:test'; test('fast', () => {});\n");
  writeFileSync(failing, "import { test } from 'node:test'; import assert from 'node:assert'; test('boom', () => assert.equal(1, 2));\n");
  // The test itself passes; the open interval keeps the child alive forever, which
  // --test-timeout does not bound (the CI stall shape).
  writeFileSync(wedged, "import { test } from 'node:test'; test('wedged', () => { setInterval(() => {}, 1000); });\n");
  return { dir, fast, failing, wedged };
}

function run(secs, log, cmd) {
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.NODE_TEST_CONTEXT; // else the inner `node --test` reports to the outer runner and exits 0
  return spawnSync('bash', [HELPER, 'fixture', String(secs), log, '--', ...cmd], { encoding: 'utf8', env, timeout: 90_000 });
}

test('a wedged test-file child fails the batch with 124 and is named; finished files are not', () => {
  const f = fixture();
  try {
    const log = join(f.dir, 'out.log');
    const t0 = Date.now();
    const r = run(6, log, ['node', '--test', f.fast, f.wedged]);
    assert.equal(r.status, 124, r.stdout + r.stderr);
    assert.ok(Date.now() - t0 < 30_000, 'killed near its bound, not left running');
    assert.match(r.stdout, /::error title=Stalled test batch::fixture batch still running after 6s/);
    assert.match(r.stdout, /Test files still running: \S*wedged\.test\.mjs/);
    assert.doesNotMatch(r.stdout.split('Test files still running:')[1] || '', /fast\.test\.mjs/);
    // TAP-shaped stall lines, so summarize-failing-tests.sh and main-red-streak.js name the file.
    const logText = readFileSync(log, 'utf8');
    assert.match(logText, /^not ok 1 - \S*wedged\.test\.mjs \(stalled: still running after 6s, killed\)$/m);
    assert.match(logText, /^  location: '\S*wedged\.test\.mjs:1:1'$/m);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('the same wedge under npx tsx --test (the E2E batch launcher) is named too', () => {
  const f = fixture();
  try {
    const r = run(15, join(f.dir, 'out.log'), ['npx', 'tsx', '--test', f.fast, f.wedged]);
    assert.equal(r.status, 124, r.stdout + r.stderr);
    assert.match(r.stdout, /Test files still running: \S*wedged\.test\.mjs/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a batch that finishes passes its exit code through (0 and 1)', () => {
  const f = fixture();
  try {
    const ok = run(60, join(f.dir, 'ok.log'), ['node', '--test', f.fast]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.doesNotMatch(ok.stdout, /Stalled test batch/);
    const bad = run(60, join(f.dir, 'bad.log'), ['node', '--test', f.fast, f.failing]);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.doesNotMatch(bad.stdout, /Stalled test batch/);
    assert.match(readFileSync(join(f.dir, 'bad.log'), 'utf8'), /boom/, 'failing output is tee\'d to the log');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('bad arguments exit 2', () => {
  const r = spawnSync('bash', [HELPER, 'x', 'soon', '/dev/null', '--', 'true'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

// Class guard (BRO-7113): in test.yml every `node --test` / `tsx --test` command is
// wall-clock bounded (inline `timeout N` or this helper), and each job's helper
// bounds fit inside its timeout-minutes, so a never-exiting test child fails as a
// named red step instead of a cancelled job at the limit.
test('test.yml: every --test invocation is bounded, and helper bounds fit each job', () => {
  const ymlPath = join(dirname(HELPER), '..', '..', '.github', 'workflows', 'test.yml');
  const lines = readFileSync(ymlPath, 'utf8').split('\n');
  const unbounded = [];
  lines.forEach((line, i) => {
    const code = line.replace(/^\s*#.*$/, '');
    if (!/\b(node|tsx)\s+(--\S+\s+)*--test\b/.test(code)) return;
    // `timeout` as a command word (NOT the --test-timeout flag, which bounds tests,
    // not processes), with a -k kill-after so a TERM-ignoring child still dies.
    if (/(^|[\s;&|(!])timeout\s+-k\s+\d+\s+\d+\s/.test(code)) return;
    // Continuation of the helper call, or of run_batch (whose body uses the helper).
    const prev = lines[i - 1] || '';
    if (/(run-test-batch-bounded\.sh|\brun_batch\s)/.test(prev) && /\\\s*$/.test(prev)) return;
    if (/run-test-batch-bounded\.sh/.test(code)) return;
    unbounded.push(`test.yml:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  assert.deepEqual(unbounded, [], 'wrap these in `timeout N` or scripts/lib/run-test-batch-bounded.sh');

  // Per job: sum of helper bounds + 3 min setup < timeout-minutes.
  const jobs = [];
  for (const line of lines) {
    const j = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (j) { jobs.push({ name: j[1], limitMin: null, boundSec: 0 }); continue; }
    const cur = jobs[jobs.length - 1];
    if (!cur) continue;
    const t = /^    timeout-minutes:\s*(\d+)/.exec(line);
    if (t) cur.limitMin = Number(t[1]);
    const b = /run-test-batch-bounded\.sh\s+"[^"]*"\s+(\d+)\s/.exec(line);
    if (b) cur.boundSec += Number(b[1]);
  }
  const used = jobs.filter((j) => j.boundSec > 0);
  // run_batch must itself route through the helper for the continuation exemption to hold.
  const rb = lines.join('\n').match(/run_batch\(\) \{[\s\S]*?\n          \}/);
  assert.ok(rb && /run-test-batch-bounded\.sh/.test(rb[0]), 'run_batch() no longer uses run-test-batch-bounded.sh');
  assert.ok(used.length >= 3, `expected the helper in 3+ jobs, found ${used.map((j) => j.name)}`);
  for (const j of used) {
    assert.ok(j.limitMin, `${j.name} uses the helper but has no job timeout-minutes`);
    assert.ok(j.boundSec + 180 < j.limitMin * 60, `${j.name}: helper bounds ${j.boundSec}s + 180s setup exceed timeout-minutes ${j.limitMin}`);
  }
});
