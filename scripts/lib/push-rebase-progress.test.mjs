import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNoopRebase } = require('./push-rebase-progress.js');
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'push-rebase-progress.js');

// The #394 signature: a resolution reported success (historyChanged) but the
// fetched remote tip is still NOT in HEAD's history — every push will be rejected.
test('isNoopRebase: history changed but remote not incorporated → no-op (abort)', () => {
  assert.equal(isNoopRebase({ historyChanged: true, remoteInHistory: false }), true);
});

test('isNoopRebase: clean rebase that DID incorporate remote → not a no-op', () => {
  assert.equal(isNoopRebase({ historyChanged: true, remoteInHistory: true }), false);
});

test('isNoopRebase: resolution genuinely failed (no history change) → NOT loud-abort (normal retry path)', () => {
  // history_changed=false is the "all strategies failed / nothing to do" case —
  // it must take the existing backoff/exhaustion path, not the loud abort, so a
  // transient conflict is not converted into an immediate hard failure.
  assert.equal(isNoopRebase({ historyChanged: false, remoteInHistory: false }), false);
});

test('isNoopRebase: nothing to push, already up to date → not a no-op', () => {
  assert.equal(isNoopRebase({ historyChanged: false, remoteInHistory: true }), false);
});

// The bash helper shells out to the CLI; assert the exact contract it depends on.
function runCli(remoteInHistory, historyChanged) {
  try {
    const out = execFileSync('node', [CLI, `--remote-in-history=${remoteInHistory}`, `--history-changed=${historyChanged}`], { encoding: 'utf8' });
    return { out: out.trim(), code: 0 };
  } catch (e) {
    return { out: String(e.stdout || '').trim(), code: e.status };
  }
}

test('CLI: no-op inputs print NOOP and exit 3', () => {
  const { out, code } = runCli('false', 'true');
  assert.equal(out, 'NOOP');
  assert.equal(code, 3);
});

test('CLI: healthy inputs print OK and exit 0', () => {
  const { out, code } = runCli('true', 'true');
  assert.equal(out, 'OK');
  assert.equal(code, 0);
});
