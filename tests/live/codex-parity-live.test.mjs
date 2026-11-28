/**
 * LIVE acceptance test for the Codex runner parity gates (BRO-7636).
 *
 * Drives the runner's own helpers (daily-runner.js `.live` seam) against REAL commits in the runner's
 * real worktree, with the real keyless build sandbox:
 *   A. a UI edit (src/components/show-cards/ScoreBadge.tsx) is held for visual approval, naming the file
 *   B. a prompt-only edit is not held
 *   C. a compiling src/ edit builds on the branch in the sandbox (buildIn -> null)
 *   D. a src/ edit with a broken import fails the site build and the tail names the module,
 *      while fresh main builds clean (siteBuildFailure compares against main)
 *
 * It needs Linux, root, fs.protected_hardlinks=1, the private core data files and ~15 minutes (three
 * full `next build`s), so it is in tests/live/ and in NO unit manifest. It is destructive to the runner
 * worktree (<this checkout>/.claude/worktrees/codex-runner: force checkout + clean) and creates the
 * sandbox user, so it runs ONLY with CODEX_PARITY_LIVE=1, ONLY from a git worktree under
 * .claude/worktrees/ (never the primary checkout, where a real runner owns that path), and skips
 * itself (before touching anything) when the sandbox or data is missing.
 *
 *   CODEX_PARITY_LIVE=1 node --test --test-timeout=2400000 tests/live/codex-parity-live.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const D = require('../../scripts/codex/daily-runner.js');
const L = D.live;

// The runner's ROOT is where daily-runner.js lives, so judge that, not process.cwd().
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let ready = false;
let skipWhy = '';
if (process.env.CODEX_PARITY_LIVE !== '1') skipWhy = 'opt-in: set CODEX_PARITY_LIVE=1 (destructive to .claude/worktrees/codex-runner)';
else if (!ROOT.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)) skipWhy = 'run it from a throwaway worktree under .claude/worktrees/, never the primary checkout';
else if (!fs.existsSync(path.join(ROOT, 'data', 'shows.json'))) skipWhy = 'core data files are missing (./scripts/setup-local-data.sh)';
else {
  try {
    const e = L.SB.ensure(); // may create the sandbox user: only after every opt-in check above
    if (!e || e.ok === false) skipWhy = `sandbox unavailable: ${JSON.stringify(e)}`;
    else ready = true;
  } catch (e) { skipWhy = `sandbox unavailable: ${e.message.split('\n')[0]}`; }
}

let pinned = null; // one base for every scenario, so a push to main mid-run cannot change what is compared

const g = (a) => L.git(a, L.WT);
const g0 = (a) => L.git(a, ROOT);
function reset() {
  if (!fs.existsSync(path.join(L.WT, '.git'))) { try { g0(['worktree', 'prune']); } catch {} L.addWorktree(L.WT); }
  L.linkNodeModules(L.WT);
  if (!pinned) { g(['fetch', '-q', 'origin', 'main']); pinned = g(['rev-parse', 'origin/main']).trim(); }
  g(['checkout', '-q', '-f', '--detach', pinned]);
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

test('C: a compiling src/ edit builds on the branch itself', opts, () => {
  reset();
  commit('src/lib/data-core.ts', (s) => `${s}\n// bro-7636 live test (compiles)\n`, 'src ok');
  assert.equal(L.uiHold(), null, 'src/lib is not a UI path');
  // buildIn, not siteBuildFailure: that one also returns null when the branch AND fresh main both fail
  // (a missing dependency or data file would then read as a pass).
  assert.equal(L.buildIn(L.WT), null, 'the branch must build in the sandbox');
});

test('D: a src/ edit with a broken import fails the site build, naming the module', opts, () => {
  reset();
  commit('src/lib/data-core.ts', (s) => `import __bro7636 from './does-not-exist-bro7636';\n${s}\nvoid __bro7636;\n`, 'src broken import');
  const failure = L.siteBuildFailure();
  assert.ok(failure, 'a build that fails on the branch and not on fresh main must be returned (null also means fresh main itself is red: check that first)');
  assert.match(failure, /Module not found/);
  assert.match(failure, /does-not-exist-bro7636/);
  assert.match(failure, /src\/lib\/data-core\.ts/);
});

test.after(() => { if (ready) { try { reset(); } catch (e) { console.warn(`live test cleanup failed: ${e.message.split('\n')[0]}`); } } });
