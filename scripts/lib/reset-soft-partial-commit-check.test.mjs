import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { findResetSoftPartialCommitIssues } = require('./reset-soft-partial-commit-check.js');

// Reproduces record-push-ledger.js's PRE-FIX shape (commit 613c6bd8eeb^):
// a --soft reset in one helper, called before a scoped add + commit in the
// caller — must flag.
const PRE_FIX_FIXTURE = `
function fastForwardHeadToOrigin(branch) {
  git(['reset', '--soft', \`origin/\${branch}\`]);
}

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      fastForwardHeadToOrigin(branch);
      fs.writeFileSync(LEDGER_ABS_PATH, entryLine);
      git(['add', LEDGER_REL_PATH]);
      git(['commit', '-m', 'chore: record push ledger entry']);
      git(['push', 'origin', \`HEAD:\${branch}\`]);
    } catch (err) {
      unwindAttempt(preAttemptHead);
    }
  }
}
`;

// record-push-ledger.js's POST-FIX shape: fastForwardHeadToOrigin uses
// --mixed, and unwindAttempt's own --soft reset (used to rewind a failed
// attempt) is never followed by a scoped add + commit — must NOT flag.
const POST_FIX_FIXTURE = `
function unwindAttempt(preAttemptHead) {
  const postAttemptHead = safeRevParse();
  if (preAttemptHead && postAttemptHead && postAttemptHead !== preAttemptHead) {
    try { git(['reset', '--soft', preAttemptHead]); } catch { /* best effort */ }
  }
  try { git(['reset', '--quiet', 'HEAD', '--', LEDGER_REL_PATH]); } catch { /* not staged */ }
  try {
    git(['checkout', '--quiet', 'HEAD', '--', LEDGER_REL_PATH]);
  } catch {
    try { fs.unlinkSync(LEDGER_ABS_PATH); } catch { /* already gone */ }
  }
}

function fastForwardHeadToOrigin(branch) {
  git(['reset', '--mixed', \`origin/\${branch}\`]);
}

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const preAttemptHead = safeRevParse();
    try {
      fastForwardHeadToOrigin(branch);
      fs.writeFileSync(LEDGER_ABS_PATH, entryLine);
      git(['add', LEDGER_REL_PATH]);
      git(['commit', '-m', 'chore: record push ledger entry']);
      git(['push', 'origin', \`HEAD:\${branch}\`]);
    } catch (err) {
      unwindAttempt(preAttemptHead);
    }
  }
}
`;

// A --soft reset followed by a broad `git add -A` (or `.`) then commit is a
// different (much less surprising) risk profile — not this check's target.
const BROAD_ADD_FIXTURE = `
function sync(ref) {
  git(['reset', '--soft', ref]);
  git(['add', '-A']);
  git(['commit', '-m', 'sync']);
}
`;

// Shell-string style (execSync with a plain command string) must also be
// caught, not just the array-call style.
const SHELL_STRING_FIXTURE = `
function sync(ref) {
  execSync('git reset --soft ' + ref);
  fs.writeFileSync(LEDGER_PATH, entry);
  execSync('git add ' + LEDGER_PATH);
  execSync('git commit -m "sync"');
}
`;

// A --soft reset followed by a --mixed/--hard resync before any add+commit
// must not flag — the resync neutralizes the stale-index risk.
const RESYNC_CLEARS_FIXTURE = `
function sync(ref, branch) {
  git(['reset', '--soft', ref]);
  git(['reset', '--mixed', \`origin/\${branch}\`]);
  git(['add', LEDGER_REL_PATH]);
  git(['commit', '-m', 'sync']);
}
`;

// A --soft reset with no add/commit anywhere nearby (the common, safe use —
// just rewinding HEAD) must not flag.
const BARE_SOFT_RESET_FIXTURE = `
function rewind(sha) {
  git(['reset', '--soft', sha]);
}
`;

test('flags record-push-ledger.js PRE-FIX shape (helper reset --soft, caller scoped add+commit)', () => {
  const violations = findResetSoftPartialCommitIssues(PRE_FIX_FIXTURE);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /phantom-staged-revert/);
  assert.match(violations[0], /#687/);
});

test('clean: record-push-ledger.js POST-FIX shape (--mixed + safe unwindAttempt --soft)', () => {
  assert.deepEqual(findResetSoftPartialCommitIssues(POST_FIX_FIXTURE), []);
});

test('clean: --soft reset followed by a broad `git add -A` + commit', () => {
  assert.deepEqual(findResetSoftPartialCommitIssues(BROAD_ADD_FIXTURE), []);
});

test('flags shell-string style `git reset --soft` + scoped `git add` + `git commit`', () => {
  const violations = findResetSoftPartialCommitIssues(SHELL_STRING_FIXTURE);
  assert.equal(violations.length, 1);
});

test('clean: a --mixed/--hard resync between --soft and the add+commit clears the risk', () => {
  assert.deepEqual(findResetSoftPartialCommitIssues(RESYNC_CLEARS_FIXTURE), []);
});

test('clean: bare --soft reset with no add/commit anywhere', () => {
  assert.deepEqual(findResetSoftPartialCommitIssues(BARE_SOFT_RESET_FIXTURE), []);
});

test('does not self-trigger on this check\'s own header comments/messages', () => {
  const ownSource = fs.readFileSync(path.join(__dirname, 'reset-soft-partial-commit-check.js'), 'utf8');
  assert.deepEqual(findResetSoftPartialCommitIssues(ownSource), []);
});

test('every real scripts/**/*.js file is clean (excluding this check + its test)', () => {
  const scriptsDir = path.join(__dirname, '..');
  const failures = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        if (full === path.join(__dirname, 'reset-soft-partial-commit-check.js')) continue;
        const text = fs.readFileSync(full, 'utf8');
        const violations = findResetSoftPartialCommitIssues(text);
        if (violations.length) failures.push(`${path.relative(scriptsDir, full)}: ${violations.join('; ')}`);
      }
    }
  }
  walk(scriptsDir);

  assert.deepEqual(failures, []);
});
