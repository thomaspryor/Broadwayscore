import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { main, USAGE } = require('./autonomous-probe.js');

test('USAGE documents the probe purpose and --help', () => {
  assert.match(USAGE, /posture/);
  assert.match(USAGE, /--help\/-h/);
});

// Cousin of the 2026-07-14 bsc-conductor/bsc-prune incident (task #185):
// autonomous-probe.js had zero --help handling — a bare --help fell straight
// into claudeP() and launched two real `claude -p ... --dangerously-skip-permissions`
// sessions. execFn is stubbed to THROW so this test actually proves zero
// execFileSync('claude', ...) calls happen, rather than trusting the guard
// stayed in the right place.
test('--help / -h exit before claudeP ever calls execFn', () => {
  const execFn = () => { throw new Error('execFileSync must not be called for --help'); };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    assert.equal(main(['--help'], execFn), 0);
    assert.equal(main(['-h'], execFn), 0);
    assert.equal(main(['--help=1'], execFn), 0);
  } finally {
    console.log = origLog;
  }
  assert.equal(logged.length, 3);
  for (const line of logged) assert.match(line, /autonomous-probe\.js — proves the autonomous-session safety posture/);
});

test('without --help, main() runs both probes through execFn', () => {
  let calls = 0;
  const execFn = () => { calls++; return 'stub-out'; };
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    main([], execFn);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.equal(calls, 2);
});

// Belt-and-suspenders: run the real CLI as a subprocess with `claude` stubbed
// on PATH to record any invocation and exit nonzero. If the --help guard
// were ever removed, this would fall through to claudeP()'s real
// execFileSync('claude', ...) call and the stub marker file would appear —
// without the stub, a broken guard would instead hang this test for up to
// TIMEOUT_MS (240s) trying to reach a real claude backend.
test('node scripts/autonomous-probe.js --help never spawns claude (real process, PATH-stubbed)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-probe-help-'));
  const marker = path.join(tmp, 'spawned.txt');
  const binPath = path.join(tmp, 'claude');
  fs.writeFileSync(binPath, `#!/bin/sh\necho "$0 $*" >> "${marker}"\nexit 1\n`);
  fs.chmodSync(binPath, 0o755);
  try {
    const script = new URL('./autonomous-probe.js', import.meta.url).pathname;
    const out = execFileSync(process.execPath, [script, '--help'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
    });
    assert.match(out, /Usage:/);
    assert.equal(fs.existsSync(marker), false, 'claude stub must never be invoked for --help');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
