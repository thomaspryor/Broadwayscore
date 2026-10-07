import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { main, USAGE } = require('./autonomous-run.js');

test('USAGE documents --dry-run, --live, and --help', () => {
  assert.match(USAGE, /--dry-run/);
  assert.match(USAGE, /--live/);
  assert.match(USAGE, /--help, -h/);
});

// Cousin of the 2026-07-14 bsc-conductor/bsc-prune incident (task #185):
// --help must never fall through to the real dry-run/live handlers, which
// dispatch gh workflow runs and spawn real `claude` sessions. dryRunFn/liveFn
// are stubbed to THROW so this test actually proves zero calls happen,
// rather than trusting the guard stayed in the right place.
test('--help / -h / combined-with-mode-flags exit before dry-run or live handling', () => {
  const dryRunFn = () => { throw new Error('dryRun must not be called for --help'); };
  const liveFn = () => { throw new Error('live must not be called for --help'); };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    assert.doesNotThrow(() => main(['--help'], dryRunFn, liveFn));
    assert.doesNotThrow(() => main(['-h'], dryRunFn, liveFn));
    // The actual reported risk: --help combined with a real mode flag.
    assert.doesNotThrow(() => main(['--live', '--help'], dryRunFn, liveFn));
    assert.doesNotThrow(() => main(['--dry-run', '--help'], dryRunFn, liveFn));
    assert.doesNotThrow(() => main(['--live', '--night-budget', '5', '--help'], dryRunFn, liveFn));
    assert.doesNotThrow(() => main(['--live', '--help=1'], dryRunFn, liveFn));
  } finally {
    console.log = origLog;
  }
  assert.equal(logged.length, 6);
  for (const line of logged) assert.match(line, /autonomous-run\.js — the nightly autonomous executor/);
});

test('without --help, --dry-run and --live route to the real handlers', () => {
  const calls = [];
  const dryRunFn = (args) => calls.push(['dry-run', args]);
  const liveFn = (args) => calls.push(['live', args]);
  main(['--dry-run'], dryRunFn, liveFn);
  main(['--live'], dryRunFn, liveFn);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'dry-run');
  assert.equal(calls[1][0], 'live');
});

// Belt-and-suspenders: run the real CLI as a subprocess with `claude` and
// `gh` stubbed on PATH to record any invocation and exit nonzero. If the
// --help guard were ever removed or moved after the args.live/args['dry-run']
// branch, `--live --help` would reach live()'s dispatchAndWaitMerge /
// runImplementer paths and the stub marker file would appear.
function withStubbedBins(names, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-run-help-'));
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

test('node scripts/autonomous-run.js --help never spawns claude or gh (real process, PATH-stubbed)', () => {
  withStubbedBins(['claude', 'gh'], ({ tmp, marker }) => {
    const script = new URL('./autonomous-run.js', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [script, '--help'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
    });
    assert.match(out, /Usage:/);
    assert.match(out, /--live/);
    assert.equal(fs.existsSync(marker), false, 'claude/gh stub must never be invoked for --help');
  });
});

test('node scripts/autonomous-run.js --live --help never spawns claude or gh (real process)', () => {
  withStubbedBins(['claude', 'gh'], ({ tmp, marker }) => {
    const script = new URL('./autonomous-run.js', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [script, '--live', '--help'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
    });
    assert.match(out, /Usage:/);
    assert.equal(fs.existsSync(marker), false, 'claude/gh stub must never be invoked for --live --help');
  });
});
