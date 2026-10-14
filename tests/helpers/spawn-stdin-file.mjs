// spawnSync / execFileSync with `input` fed from a temp FILE instead of a pipe.
//
// Why: spawnSync({ input }) writes stdin through a pipe. A hook that exits
// before reading stdin (a self-skip or kill-switch prelude, e.g.
// .claude/hooks/pre-push-visual-gate.sh exits at line 28 and first reads stdin
// at line 34) closes the pipe, and the write fails with EPIPE some of the time.
// spawnSync then returns r.error = EPIPE and the test fails on a race, not on
// behaviour (main test.yml run 38367466885, pre-push-visual-gate-fixture
// "negative control: HOME self-skip"). A file on stdin cannot EPIPE: the child
// reads it or ignores it.
//
// Same signatures and return values as spawnSync / execFileSync. Use them for
// any test that pipes a payload into a hook or script that may exit without
// reading it. tests/unit/spawn-stdin-file.test.mjs fails on new pipe callers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

function withStdinFile(run, command, args, options = {}) {
  const { input, stdio, ...rest } = options;
  if (input === undefined) return run(command, args, options);
  // Only stdin changes; a caller's stdout/stderr choice is kept.
  const out = Array.isArray(stdio) ? stdio.slice(1, 3) : [stdio || 'pipe', stdio || 'pipe'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdin-'));
  let fd;
  try {
    const file = path.join(dir, 'stdin');
    fs.writeFileSync(file, input);
    fd = fs.openSync(file, 'r');
    return run(command, args, { ...rest, stdio: [fd, out[0] ?? 'pipe', out[1] ?? 'pipe'] });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const spawnSyncStdinFile = (command, args, options) => withStdinFile(spawnSync, command, args, options);
export const execFileSyncStdinFile = (command, args, options) => withStdinFile(execFileSync, command, args, options);
