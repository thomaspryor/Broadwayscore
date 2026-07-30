// Unit + integration tests for scripts/lib/opening-night-monitor.js — the
// headless replacement for the cmux-based opening-night monitor launch path
// (card #650). Run: node --test scripts/lib/opening-night-monitor.test.mjs
//
// Card #650 root cause, proven not guessed: cmux refuses connections from
// launchd-parented process ancestry — `cmux list-workspaces` from a
// double-fork+setsid orphan (PPID=1, matching launchd's process shape)
// reproduces "ERROR: Access denied — only processes started inside cmux can
// connect" / "Failed to write to socket (Broken pipe, errno 32)" every time,
// while the identical command from inside a real cmux workspace succeeds.
// The integration test below reproduces that EXACT ancestry (double-fork +
// setsid, verified orphaned to PPID=1) and proves the headless path
// completes successfully under it, with the fake `claude` binary asserting
// it was never asked to touch cmux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runMonitorPass, isModelAllowed } from './opening-night-monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'on-monitor-test-'));
}

function writeFakeClaude(dir, { resultText = 'ok', exitCode = 0, sawCmux = false } = {}) {
  const scriptPath = path.join(dir, 'claude');
  // A real `cmux` call would appear as an invocation of a binary named
  // "cmux" on PATH — this fake claude records whether IT was ever asked to
  // shell out to one (it isn't, by design, but the assertion is here so a
  // future regression that pipes cmux calls through the monitor path would
  // fail loudly instead of silently).
  const envelope = JSON.stringify({
    is_error: exitCode !== 0,
    result: resultText,
    session_id: 'fake-session-123',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  fs.writeFileSync(scriptPath, `#!/bin/bash\ncommand -v cmux >/dev/null 2>&1 && echo "SAW_CMUX_ON_PATH" >&2\ncat > /dev/null\necho '${envelope.replace(/'/g, "'\\''")}'\nexit ${exitCode}\n`);
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test('isModelAllowed refuses fable/mythos (the old interactive-only default) and allows opus/sonnet', () => {
  assert.equal(isModelAllowed('fable'), false);
  assert.equal(isModelAllowed('mythos'), false);
  assert.equal(isModelAllowed('opus'), true);
  assert.equal(isModelAllowed('sonnet'), true);
});

test('runMonitorPass: happy path against a fake claude binary — no cmux involved', async () => {
  const dir = mkTmp();
  try {
    writeFakeClaude(dir, { resultText: 'pass complete: 3 reviews live' });
    const result = await runMonitorPass({
      prompt: 'be the opening night monitor',
      cwd: REPO_ROOT,
      model: 'opus',
      maxWallMin: 1,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(result.ok, true);
    assert.equal(result.resultText, 'pass complete: 3 reviews live');
    assert.equal(result.usd, 0.0123);
    assert.ok(result.wallMin >= 0);
    assert.ok(!/Access denied|Broken pipe/.test(JSON.stringify(result)), 'no cmux ancestry error should ever appear on this path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runMonitorPass: refuses fable before ever spawning a process', async () => {
  const dir = mkTmp();
  try {
    // No fake claude written — if runMonitorPass tried to spawn anything
    // named "claude" here it would ENOENT, not hit the forbidden-model gate.
    const result = await runMonitorPass({
      prompt: 'x', cwd: REPO_ROOT, model: 'fable', maxWallMin: 1,
      env: { ...process.env, PATH: dir },
    });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'forbidden-model');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runMonitorPass: a nonzero exit surfaces as a failed stage, not a thrown exception', async () => {
  const dir = mkTmp();
  try {
    writeFakeClaude(dir, { exitCode: 1, resultText: 'boom' });
    const result = await runMonitorPass({
      prompt: 'x', cwd: REPO_ROOT, model: 'opus', maxWallMin: 1,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(result.ok, false);
    assert.ok(result.stage);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The money test: launchd-shaped ancestry ────────────────────────────────
//
// A perl double-fork+setsid orphan is the exact reproduction the card's own
// evidence used to prove cmux's ancestry gate ("ERROR: Access denied — only
// processes started inside cmux can connect"). This spawns runMonitorPass
// from inside that SAME ancestry (verified via the orphan's own PPID, which
// must land on launchd/init — never this test process) and asserts the pass
// completes cleanly. No `perl`/POSIX::setsid → skip rather than false-fail on
// an unrelated host.
test('runMonitorPass completes successfully when invoked from launchd-shaped (double-fork+setsid orphan) ancestry', { skip: spawnSync('perl', ['-e', 'use POSIX qw(setsid); 1'], { stdio: 'ignore' }).status !== 0 ? 'perl/POSIX::setsid unavailable on this host' : false }, async () => {
  const dir = mkTmp();
  const outFile = path.join(dir, 'result.json');
  const ppidFile = path.join(dir, 'ppid.txt');
  try {
    writeFakeClaude(dir, { resultText: 'orphan pass ok' });

    const runnerScript = path.join(dir, 'runner.js');
    fs.writeFileSync(runnerScript, `
      const fs = require('fs');
      const { runMonitorPass } = require(${JSON.stringify(path.join(__dirname, 'opening-night-monitor.js'))});
      fs.writeFileSync(${JSON.stringify(ppidFile)}, String(process.ppid));
      runMonitorPass({ prompt: 'x', cwd: ${JSON.stringify(REPO_ROOT)}, model: 'opus', maxWallMin: 1 })
        .then(r => fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(r)))
        .catch(e => fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ ok: false, crashed: String(e && e.stack || e) })));
    `);

    const nodeBin = process.execPath;
    const childEnv = `PATH=${dir}:${process.env.PATH}`;
    // Same shape as the card's proof repro: fork, parent exits immediately,
    // setsid() in the child (new session, no controlling terminal), second
    // fork so the final process's parent (the first child) exits too —
    // orphaning it to init/launchd (PPID becomes 1 on macOS).
    const perlScript = `
      use POSIX qw(setsid);
      defined(my $pid = fork) or die "fork: $!";
      exit 0 if $pid;
      setsid();
      defined($pid = fork) or die "fork2: $!";
      exit 0 if $pid;
      $ENV{PATH} = "${dir}:" . $ENV{PATH};
      exec("${nodeBin}", "${runnerScript}") or die "exec failed: $!";
    `;
    const r = spawnSync('perl', ['-e', perlScript], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, `perl double-fork launcher itself failed: ${r.stderr}`);

    const deadline = Date.now() + 15000;
    while (!fs.existsSync(outFile) && Date.now() < deadline) {
      spawnSync('sleep', ['0.1']);
    }
    assert.ok(fs.existsSync(outFile), 'orphaned process never wrote a result — pass did not complete');

    const ppid = fs.existsSync(ppidFile) ? Number(fs.readFileSync(ppidFile, 'utf8').trim()) : null;
    assert.notEqual(ppid, process.pid, 'the runner must be reparented away from THIS test process, not a direct child of it');

    const result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(result.crashed, undefined, `runner crashed: ${result.crashed}`);
    assert.equal(result.ok, true, `expected a successful pass under orphan ancestry, got: ${JSON.stringify(result)}`);
    assert.equal(result.resultText, 'orphan pass ok');
    assert.ok(!/Access denied|Broken pipe|only processes started inside cmux/.test(JSON.stringify(result)), 'the cmux ancestry error must never appear on the headless path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
