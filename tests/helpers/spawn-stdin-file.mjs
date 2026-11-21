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
// Same signatures and return values as spawnSync / execFileSync, with one
// difference: execFileSyncStdinFile always passes an explicit stdio, so the
// child's stderr is captured (err.stderr) instead of also echoed to the test
// log. Use them for any test that pipes a payload into a hook or script that
// may exit without reading it. tests/unit/spawn-stdin-file.test.mjs fails on
// new pipe callers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

function withStdinFile(run, command, args, options = {}) {
  const { input, stdio, ...rest } = options;
  if (input == null) return run(command, args, options); // spawnSync ignores input: null too
  // Only stdin changes; a caller's stdout/stderr (and any extra fds) are kept.
  const out = Array.isArray(stdio) ? stdio.slice(1) : [stdio || 'pipe', stdio || 'pipe'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdin-'));
  let fd;
  try {
    const file = path.join(dir, 'stdin');
    // spawnSync encodes string input with options.encoding; do the same.
    const enc = typeof input === 'string' && rest.encoding && rest.encoding !== 'buffer' ? rest.encoding : undefined;
    fs.writeFileSync(file, input, enc);
    fd = fs.openSync(file, 'r');
    return run(command, args, { ...rest, stdio: [fd, out[0] ?? 'pipe', out[1] ?? 'pipe', ...out.slice(2)] });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const spawnSyncStdinFile = (command, args, options) => withStdinFile(spawnSync, command, args, options);
export const execFileSyncStdinFile = (command, args, options) => withStdinFile(execFileSync, command, args, options);
