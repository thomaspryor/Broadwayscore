import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

// Same incident class as the 2026-07-14 bsc-conductor bug and the
// autonomous-run.js/autonomous-probe.js/autonomous-merge.js --help fixes
// (tasks #260/#264): scripts/audit-show-review-gap.js spawns real `gh`
// subprocesses (workflow dispatch in dispatchGatherFor, repo-variable
// read/write in the self-proving auto-enable block) with no --help guard
// (task #266). Patch child_process.execFileSync to THROW before requiring
// the module under test, so this proves zero gh (or any execFileSync) calls
// happen for --help — not just that a guard exists somewhere in the source.
const childProcess = require('node:child_process');
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = () => {
  throw new Error('execFileSync must not be called for --help');
};
let main;
let USAGE;
try {
  ({ main, USAGE } = require('./audit-show-review-gap.js'));
} finally {
  childProcess.execFileSync = originalExecFileSync;
}

test('USAGE documents --show, --dispatch-gather, --ingest-missing, and --help', () => {
  assert.match(USAGE, /--show=ID/);
  assert.match(USAGE, /--dispatch-gather/);
  assert.match(USAGE, /--ingest-missing/);
  assert.match(USAGE, /--help, -h/);
});

test('--help / -h / combined-with-real-action-flags exit before any execFileSync call', async () => {
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    // main() is async — await the returned promise (not just doesNotThrow on
    // the synchronous call) so a future regression that moves the
    // hasHelpFlag check after an await would surface as a rejected promise
    // here too (the stubbed execFileSync throws synchronously).
    await assert.doesNotReject(main(['--help']));
    await assert.doesNotReject(main(['-h']));
    // The actual reported risk: --help combined with a real dispatch/ingest flag.
    await assert.doesNotReject(main(['--window=21', '--dispatch-gather', '--help']));
    await assert.doesNotReject(main(['--show=some-show-2026', '--ingest-missing', '--help']));
    await assert.doesNotReject(main(['--window=21', '--dispatch-gather', '--help=1']));
  } finally {
    console.log = origLog;
  }
  assert.equal(logged.length, 5);
  for (const line of logged) assert.match(line, /audit-show-review-gap\.js — show-centric review gap audit/);
});

// Belt-and-suspenders: run the real CLI as a subprocess with `gh` stubbed on
// PATH to record any invocation and exit nonzero. If the --help guard were
// ever removed or moved after loadShows()/dispatchGatherFor, a combined
// `--dispatch-gather --help` invocation would reach the real gh call and the
// stub marker file would appear.
function withStubbedBins(names, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-show-review-gap-help-'));
  const marker = path.join(tmp, 'spawned.txt');
  for (const bin of names) {
    const binPath = path.join(tmp, bin);
    fs.writeFileSync(binPath, `#!/bin/sh\necho "$0 $*" >> "${marker}"\nexit 1\n`);
    fs.chmodSync(binPath, 0o755);
  }
  try {
    fn({ tmp, marker });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('node scripts/audit-show-review-gap.js --help never spawns gh (real process, PATH-stubbed)', () => {
  withStubbedBins(['gh'], ({ tmp, marker }) => {
    const script = new URL('./audit-show-review-gap.js', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [script, '--help'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
    });
    assert.match(out, /Usage:/);
    assert.equal(fs.existsSync(marker), false, 'gh stub must never be invoked for --help');
  });
});

test('node scripts/audit-show-review-gap.js --window=21 --dispatch-gather --help never spawns gh (real process)', () => {
  withStubbedBins(['gh'], ({ tmp, marker }) => {
    const script = new URL('./audit-show-review-gap.js', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [
      script, '--window=21', '--dispatch-gather', '--help',
    ], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
    });
    assert.match(out, /Usage:/);
    assert.equal(fs.existsSync(marker), false, 'gh stub must never be invoked for --window=21 --dispatch-gather --help');
  });
});
