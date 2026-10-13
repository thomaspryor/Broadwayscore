// spawnSync with `input` fed from a temp FILE instead of a pipe.
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
// Same signature and return value as spawnSync. Use it for any test that
// pipes a payload into a hook or script that may exit without reading it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function spawnSyncStdinFile(command, args, options = {}) {
  const { input, stdio, ...rest } = options;
  if (input === undefined) return spawnSync(command, args, options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdin-'));
  const file = path.join(dir, 'stdin');
  fs.writeFileSync(file, input);
  const fd = fs.openSync(file, 'r');
  try {
    return spawnSync(command, args, { ...rest, stdio: [fd, 'pipe', 'pipe'] });
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
