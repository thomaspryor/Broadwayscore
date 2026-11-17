/**
 * LIVE acceptance test for the Codex runner parity gates (BRO-7636).
 *
 * Drives the runner's own helpers (daily-runner.js `.live` seam) against REAL commits in the runner's
 * real worktree, with the real keyless build sandbox:
 *   A. a UI edit (src/components/show-cards/ScoreBadge.tsx) is held for visual approval, naming the file
 *   B. a prompt-only edit is not held
 *   C. a compiling src/ edit passes the site build (siteBuildFailure -> null)
 *   D. a src/ edit with a broken import fails the site build and the tail names the module,
 *      while fresh main builds clean (siteBuildFailure compares against main)
 *
 * It needs Linux, root, fs.protected_hardlinks=1, the private core data files and ~15 minutes (three
 * full `next build`s), so it is in tests/live/ and in NO unit manifest. It skips itself when the sandbox
 * or data is missing. It rewrites the runner worktree (.claude/worktrees/codex-runner): run it from a
 * worktree that is not running the real runner.
 *
 *   node --test --test-timeout=2400000 tests/live/codex-parity-live.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../../scripts/codex/daily-runner.js');
const L = D.live;

let ready = false;
let skipWhy = '';
try {
  const e = L.SB.ensure();
  if (!e || e.ok === false) skipWhy = `sandbox unavailable: ${JSON.stringify(e)}`;
  else if (!fs.existsSync(path.join(process.cwd(), 'data', 'shows.json'))) skipWhy = 'core data files are missing (./scripts/setup-local-data.sh)';
  else ready = true;
} catch (e) { skipWhy = `sandbox unavailable: ${e.message.split('\n')[0]}`; }

const g = (a) => L.git(a, L.WT);
function reset() {
  if (!fs.existsSync(path.join(L.WT, '.git'))) L.addWorktree(L.WT);
  L.linkNodeModules(L.WT);
  g(['fetch', '-q', 'origin', 'main']);
  g(['checkout', '-q', '-f', '--detach', 'origin/main']);
  g(['clean', '-qfd', '-e', 'data', '-e', 'node_modules']);
  L.applyTreeMode(L.WT);
  D.provideData(L.WT);
}
function commit(file, edit, msg) {
  const p = path.join(L.WT, file);
  fs.writeFileSync(p, edit(fs.readFileSync(p, 'utf8')));
  g(['add', file]);
  g(['-c', 'user.name=live-test', '-c', 'user.email=live-test@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', msg]);
}

const opts = { skip: ready ? false : skipWhy, timeout: 25 * 60_000 };

test('A: a UI edit is held and names the file', opts, () => {
  reset();
  commit('src/components/show-cards/ScoreBadge.tsx', (s) => `${s}\n// bro-7636 live test\n`, 'ui');
  const hold = L.uiHold();
  assert.ok(hold, 'a UI diff must be held');
  assert.deepEqual(hold.files, ['src/components/show-cards/ScoreBadge.tsx']);
  assert.ok(L.uiHold({ pr: true }), 'the --pr path holds it too');
});

test('B: a prompt-only edit is not held', opts, () => {
  reset();
  commit('scripts/codex/runner-prompt.md', (s) => `${s}\n<!-- live test -->\n`, 'docs');
  assert.equal(L.uiHold(), null);
});

test('C: a compiling src/ edit passes the site build', opts, () => {
  reset();
  commit('src/lib/data-core.ts', (s) => `${s}\n// bro-7636 live test (compiles)\n`, 'src ok');
  assert.equal(L.uiHold(), null, 'src/lib is not a UI path');
  assert.equal(L.siteBuildFailure(), null);
});

test('D: a src/ edit with a broken import fails the site build, naming the module', opts, () => {
  reset();
  commit('src/lib/data-core.ts', (s) => `import __bro7636 from './does-not-exist-bro7636';\n${s}\nvoid __bro7636;\n`, 'src broken import');
  const failure = L.siteBuildFailure();
  assert.ok(failure, 'a build that fails on the branch and not on fresh main must be returned');
  assert.match(failure, /Module not found/);
  assert.match(failure, /does-not-exist-bro7636/);
  assert.match(failure, /src\/lib\/data-core\.ts/);
});

test.after(() => { if (ready) { try { reset(); } catch {} } });
