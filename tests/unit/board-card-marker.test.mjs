// tests/unit/board-card-marker.test.mjs — S1-T4/S1-T5 of the Notion→Linear
// cutover (sprint-plan-notion-linear-cutover.md).
//
// The gate hooks (~/.claude/hooks/notion-card-required-commit.sh and its four
// siblings) currently grep stderr for `__NOTION_CARD_ID__=`. Sprint 4 rewrites
// them to grep a board-NEUTRAL `__BOARD_CARD_ID__=` instead, so that one hook
// contract covers both boards and a future third board touches zero hooks.
// That only holds if BOTH CLIs really emit the marker, with the SAME prefix,
// to stderr. This test is what keeps them from drifting apart.
//
// Two levels of assurance, deliberately different:
//   * linear-brain.js is exercised for real — spawned as a child process with
//     its single I/O dependency (./lib/linear-issue-create) stubbed via a
//     --require preload. Nothing is faked about the CLI itself.
//   * notion-brain.js is asserted at the source level. It instantiates a
//     @notionhq/client Client at module load and its create path fans out
//     through the verifiability gate, disposition resolution and the tasks-sync
//     map; a stub deep enough to drive it would assert more about the stub than
//     about the CLI. The source contract still fails loudly on the regression
//     that actually threatens Sprint 4 — someone deleting or renaming one side.
//
// The marker prefix is derived ONCE here and applied to both CLIs, so the test
// cannot pass by having two different "correct" answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The single source of truth for this test. Both CLIs are checked against this
// exact string, and so is the shape the bash hooks will grep for.
const MARKER = '__BOARD_CARD_ID__';

// What the hooks will run: `grep -o '__BOARD_CARD_ID__=[A-Za-z0-9-]*'`. Kept
// permissive on the value because the two boards legitimately carry different
// id shapes — a Notion page UUID vs a Linear `BRO-123` identifier — and the
// only thing a hook does with the value is write it to a sentinel file.
const HOOK_GREP_RE = new RegExp(`${MARKER}=[A-Za-z0-9-]+`);

function emissionsIn(relPath) {
  const src = readFileSync(path.join(REPO, relPath), 'utf8');
  // Only count real emissions: the marker inside a console.error template
  // literal. A mention in a comment (both files have several) must not count,
  // or deleting the emission and leaving the comment would still pass.
  const re = new RegExp(String.raw`console\.error\(\s*\`(${MARKER}=)\$\{[^}]+\}\``, 'g');
  return [...src.matchAll(re)].map((m) => m[1]);
}

test('notion-brain.js emits the neutral board marker to stderr exactly once', () => {
  const found = emissionsIn('scripts/notion-brain.js');
  assert.equal(found.length, 1, `expected exactly one console.error ${MARKER} emission, got ${found.length}`);
  assert.equal(found[0], `${MARKER}=`);
});

test('linear-brain.js emits the neutral board marker to stderr exactly once', () => {
  const found = emissionsIn('scripts/linear-brain.js');
  assert.equal(found.length, 1, `expected exactly one console.error ${MARKER} emission, got ${found.length}`);
  assert.equal(found[0], `${MARKER}=`);
});

test('both CLIs emit the identical marker prefix', () => {
  assert.deepEqual(emissionsIn('scripts/notion-brain.js'), emissionsIn('scripts/linear-brain.js'));
});

test('notion-brain.js keeps the legacy __NOTION_CARD_ID__ marker alongside it', () => {
  // Additive-only is the whole point: notion-create-verify.sh:46,
  // audit-opening-dates.js:144 and audit-closing-dates.js:335 still read the
  // old marker, and it does not go away until Sprint 8 retires Notion.
  const src = readFileSync(path.join(REPO, 'scripts/notion-brain.js'), 'utf8');
  assert.match(src, /console\.error\(\s*`__NOTION_CARD_ID__=\$\{/);
});

// --- behavioural: actually run linear-brain.js with its one dep stubbed ------

// Spawns the REAL linear-brain.js with exactly one module intercepted
// (./lib/linear-issue-create). Arg parsing, the dispatch/park branch and both
// marker lines are the actual CLI. Returns only what it wrote to stderr, since
// that is what the gate hooks read — execFileSync hands back stdout, so this
// goes through /bin/sh to swap the two streams.
function stderrOf(extraArgs) {
  const dir = mkdtempSync(path.join(tmpdir(), 'board-marker-'));
  const preload = path.join(dir, 'stub.cjs');
  writeFileSync(
    preload,
    `const Module = require('module');
const target = require('path').resolve(${JSON.stringify(REPO)}, 'scripts/lib/linear-issue-create.js');
const origResolve = Module._resolveFilename;
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try { resolved = origResolve.call(Module, request, parent, isMain); } catch (e) {}
  if (resolved === target) {
    return {
      createLinearIssue: async ({ title, dispatch }) => ({
        issue: { id: '11111111-2222-3333-4444-555555555555', identifier: 'BRO-999', title, url: 'https://linear.app/x/issue/BRO-999' },
        mode: dispatch ? 'dispatch' : 'park',
        stateName: 'Todo',
      }),
    };
  }
  return orig.apply(this, arguments);
};
`
  );
  const r = execFileSync(
    '/bin/sh',
    [
      '-c',
      `${JSON.stringify(process.execPath)} --require ${JSON.stringify(preload)} ${JSON.stringify(path.join(REPO, 'scripts/linear-brain.js'))} create "Marker probe" --notes n ${extraArgs} 2>&1 1>/dev/null`,
    ],
    { encoding: 'utf8', cwd: REPO }
  );
  return r;
}

test('linear-brain.js --dispatch prints a hook-greppable BRO- marker on stderr', () => {
  const err = stderrOf('--dispatch');
  assert.match(err, HOOK_GREP_RE);
  assert.match(err, new RegExp(`${MARKER}=BRO-\\d+`));
  // The pre-existing marker must survive untouched.
  assert.match(err, /ISSUE-FILED: BRO-999/);
});

test('linear-brain.js --park also prints the marker (parking still files a card)', () => {
  // The gate hooks ask "does a card exist for this session", not "is it being
  // worked" — so a parked issue must satisfy the marker contract or `--park`
  // would wedge the commit gate for anyone who used it.
  const err = stderrOf('--park "not now"');
  assert.match(err, new RegExp(`${MARKER}=BRO-\\d+`));
  assert.match(err, /PARKED: BRO-999/);
});
