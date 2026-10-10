// BRO-2845: ~/.claude/hooks/linear-issue-verify.sh writes the "reported"
// sentinel that linear-issue-required-stop.sh gates Stop on. Its terminal-state
// allowlist omitted `Duplicate`, so a session that closed its card with
// `linear-brain.js update BRO-N --state Duplicate` was blocked at Stop.
//
// Runs the REAL hook with PostToolUse JSON on stdin. The hook lives in ~/.claude
// (a separate repo, absent on CI runners), so when it or jq is missing this
// skips LOUDLY rather than passing green (BRO-2312 precedent).
//
// TERMINAL_NAMES mirrors the state NAMES the hook must accept. Bash cannot
// require() scripts/lib/linear-state-types.js, and names are not types (Paused
// is not a terminal type), so this is a deliberate hand-kept fixture: adding a
// terminal state means adding it here AND in the hook, and this test fails if
// only one side moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const HOOK = path.join(homedir(), '.claude/hooks/linear-issue-verify.sh');
const TERMINAL_NAMES = ['Done', 'Paused', 'Canceled', 'Duplicate'];

function haveJq() {
  try { execFileSync('jq', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function runHook(sessionId, state) {
  const sentinel = `/tmp/linear-issue-reported-${sessionId}`;
  rmSync(sentinel, { force: true });
  const input = JSON.stringify({
    session_id: sessionId,
    tool_input: { command: 'node scripts/linear-brain.js update BRO-9999 --state ' + state },
    // linear-brain.js prints ISSUE-UPDATED on stderr (scripts/linear-brain.js).
    tool_response: { stdout: '{}', stderr: `ISSUE-UPDATED: BRO-9999 — state=${state} — commented` },
  });
  try {
    const r = spawnSync('bash', [HOOK], { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const wrote = existsSync(sentinel);
    return { wrote, body: wrote ? readFileSync(sentinel, 'utf8').trim() : null };
  } finally {
    rmSync(sentinel, { force: true });
  }
}

for (const state of [...TERMINAL_NAMES, 'In Progress']) {
  test(`linear-issue-verify hook: state=${state}`, (t) => {
    if (!existsSync(HOOK) || !haveJq()) {
      console.warn(`SKIP: ${HOOK} or jq not present (expected on CI — ~/.claude is a separate repo)`);
      t.skip('hook or jq not present on this machine');
      return;
    }
    const sid = `test-bro2845-${process.pid}-${state.replace(/\W/g, '')}`;
    const { wrote, body } = runHook(sid, state);
    if (state === 'In Progress') {
      assert.equal(wrote, false, 'a non-terminal state move must not count as a report');
    } else {
      assert.equal(wrote, true, `${state} close must write the reported sentinel`);
      assert.equal(body, 'BRO-9999');
    }
  });
}
