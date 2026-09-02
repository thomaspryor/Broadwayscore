/**
 * Every scripts/lib/*.test.* file must actually be EXECUTED by CI.
 *
 * Why this test exists (BRO-2749). scripts/lib/ colocated tests are covered by
 * a shell glob inside test.yml's unit-tests job:
 *
 *     tests=(scripts/lib/*.test.mjs)
 *     node --test --test-timeout 300000 "${tests[@]}"
 *
 * That glob is deliberately NOT a manifest entry, and scripts/audit-orphan-tests.js
 * excludes scripts/lib/ for exactly that reason (its SCRIPTS_DIR readdir is
 * non-recursive and its REFERENCE_REGEX only matches literal filenames, so it is
 * structurally glob-blind). The result is a seam neither mechanism watches: a
 * colocated test whose EXTENSION falls outside the glob is invisible to the
 * glob AND exempt from the orphan audit, so it runs locally forever and never
 * once in CI, with both guards reporting all-clear.
 *
 * scripts/lib/title-match.test.js was in that seam — a CommonJS `.test.js`
 * covering normalizeTitle/titleTokens/jaccard, the shared helper every audience
 * scraper matches titles with. The glob is `*.test.mjs`; `.js` never matched;
 * no manifest listed it; no workflow named it.
 *
 * This test closes the seam from INSIDE the glob, so it polices the mechanism
 * that runs it.
 *
 * EVERY "is it covered?" ANSWER HERE IS DERIVED FROM EXECUTABLE `run:` TEXT
 * ONLY, via audit-orphan-tests.js's own extractRunBlocks(). Adversarial review
 * caught the naive version of this file counting a glob or filename mentioned
 * anywhere non-comment — an `env:` value, a `name:` scalar, a `paths:` trigger
 * entry, a trailing `# ...` on a code line, `run: echo "scripts/lib/*.test.js
 * is unsupported"`. That is precisely the false-all-clear bug task #1643 already
 * fixed once in audit-orphan-tests.js, so this reuses that parser rather than
 * re-deriving a weaker one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MANIFESTS, NODE_RUNNABLE_TEST_EXTENSIONS, testFileRegex } = require('./test-manifest.js');
// Guarded by `if (require.main === module)`, so requiring it does not run the CLI.
const { extractRunBlocks } = require('../audit-orphan-tests.js');

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(LIB_DIR, '..', '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

// A colocated test file, by any extension this repo writes tests in.
//
// BRO-2751: this list used to be `mjs|js|cjs|ts` — "the extensions `node --test`
// can run" — which quietly re-opened the exact seam this file exists to close,
// one extension over. scripts/lib holds 17 *.test.sh files; two of them
// (disk-floor-check.test.sh, merge-worktree-to-main.post-merge-test-gate.test.sh)
// ran in ZERO CI jobs, and this guard could not see them. A bash test IS a real
// CI-executed test here — it just runs through a literal `run: bash <path>` step
// (test.yml:3670+) rather than the node --test glob, which is precisely the
// `runText.includes(relPath)` branch below. The list is now shared with
// scripts/audit-orphan-tests.js via scripts/lib/test-manifest.js so the two
// guards cannot drift apart again.
const TEST_FILE_RE = testFileRegex();

/**
 * Strip SHELL comments from a run: body.
 *
 * extractRunBlocks() keeps every line of a `run: |` block, which is correct for
 * YAML but not for shell: a `#` line inside the block is a shell comment, not
 * code. test.yml documents this very glob in ~12 comments, several of them
 * INSIDE the run block, so without this step deleting the real glob line still
 * left a dozen matches and the guard passed. That was verified, not theorised —
 * mutation case 1 of the battery in the commit message.
 *
 * Quote state is tracked per line so a `#` inside 'single' or "double" quotes
 * is left alone.
 */
function stripShellComments(text) {
  return text
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === "'" || c === '"') {
          quote = c;
        } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

/** Executable shell of every workflow: `run:` bodies, shell comments removed. */
function executableWorkflowText() {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => stripShellComments(extractRunBlocks(fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8'))))
    .join('\n');
}

// A glob only counts when it appears where this repo actually RUNS tests:
// collected into a shell array (`tests=(scripts/lib/*.test.mjs)`, the form
// test.yml uses) or passed straight to a test runner on the same line. Naming
// it in `run: echo 'scripts/lib/*.test.js is unsupported'` is not execution,
// and adversarial review specifically raised that shape.
//
// KNOWN, DELIBERATE: an indirected form (`dir=scripts/lib; tests=("$dir"/*.test.mjs)`)
// reads as NOT covered. That is a false RED — the safe direction — and the
// failure message says to keep the literal glob.
const ARRAY_ASSIGN_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*=\(/;
const RUNNER_RE = /(?:node|tsx)\s+(?:--\S+\s+)*--test\b|--test\b.*\bscripts\/lib\//;

/**
 * Extensions covered by a scripts/lib glob that is actually EXECUTED.
 * Brace form `scripts/lib/*.test.{mjs,js}` is read as both extensions.
 */
function executedGlobExtensions(runText) {
  const extensions = new Set();
  for (const line of runText.split('\n')) {
    if (!ARRAY_ASSIGN_RE.test(line) && !RUNNER_RE.test(line)) continue;
    for (const m of line.matchAll(/scripts\/lib\/\*\.test\.\{([a-z,\s]+)\}/g)) {
      for (const ext of m[1].split(',')) extensions.add(ext.trim());
    }
    for (const m of line.matchAll(/scripts\/lib\/\*\.test\.([a-z]+)\b/g)) {
      extensions.add(m[1]);
    }
  }
  return extensions;
}

test('every scripts/lib/*.test.* file is executed by CI (glob, consumed manifest or literal run:)', () => {
  const runText = executableWorkflowText();
  const globExts = executedGlobExtensions(runText);

  // The glob is the primary mechanism. If it ever disappears, every colocated
  // test silently stops running and this assertion is the only thing that says
  // so — absence of a signal must not read as success.
  assert.ok(
    globExts.has('mjs'),
    'no EXECUTED scripts/lib/*.test.mjs glob found in any workflow\'s run: body ' +
      `(globs found: ${[...globExts].sort().join(', ') || 'none'}). Every colocated ` +
      "test just lost its CI coverage — restore the glob in test.yml's unit-tests job."
  );

  // A manifest entry only proves execution if CI actually READS that manifest.
  // Registering a test in a file nothing consumes is the same false all-clear
  // in a different costume, so each manifest has to earn its trust here.
  //
  // "Mentioned" is not "read": test.yml names every manifest a second time in
  // an error string (`echo "::error::tests/unit-test-manifest.txt is empty or
  // missing"`), so a bare includes() stayed true even after the mapfile was
  // repointed at another file. The manifest must appear on a line that actually
  // consumes it — a `<` redirect, cat, or xargs. (Mutation case 4.)
  const CONSUMES_RE = /<|\bcat\b|\bxargs\b/;
  const consumedManifests = MANIFESTS.filter((m) =>
    runText.split('\n').some((line) => line.includes(m) && CONSUMES_RE.test(line))
  );
  const manifestEntries = new Set();
  for (const manifest of consumedManifests) {
    const p = path.join(ROOT, manifest);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const entry = line.trim();
      if (entry) manifestEntries.add(entry);
    }
  }

  // RECURSIVE on purpose. test.yml's glob is `scripts/lib/*.test.mjs` — one
  // level only — so a test in scripts/lib/<subdir>/ is not run by it either.
  // There are none today; walking the tree means the first one added fails
  // here instead of joining title-match.test.js in the seam. Only the top
  // level gets the glob-extension pass; deeper files must be named explicitly.
  const walk = (dir, rel) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name), `${rel}/${e.name}`) : [`${rel}/${e.name}`]
    );

  const uncovered = [];
  for (const relPath of walk(LIB_DIR, 'scripts/lib').sort()) {
    const file = path.basename(relPath);
    if (!TEST_FILE_RE.test(file)) continue;
    if (file.startsWith('_skip-')) continue; // the repo-wide opt-out convention
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const atTopLevel = relPath === `scripts/lib/${file}`;
    if (atTopLevel && globExts.has(ext)) continue;
    if (manifestEntries.has(relPath)) continue;
    if (runText.includes(relPath)) continue;
    uncovered.push(relPath);
  }

  // The remedy differs by extension and the message has to say which, or it
  // hands the reader impossible advice. A *.test.sh can NEVER be fixed by
  // widening the node --test glob or by a manifest entry (both feed
  // `node --test`, which cannot execute a shell script) — its only route to
  // coverage is a literal `run: bash <path>` step. Telling a bash test's author
  // to "add the extension to the glob" would send them to make CI red.
  const shellUncovered = uncovered.filter((p) => !NODE_RUNNABLE_TEST_EXTENSIONS.includes(p.slice(p.lastIndexOf('.') + 1)));
  const nodeUncovered = uncovered.filter((p) => !shellUncovered.includes(p));
  const remedies = [];
  if (nodeUncovered.length) {
    remedies.push(
      "  node tests — either add the extension to test.yml's scripts/lib glob, or list the " +
        'file in tests/unit-test-manifest.txt (the glob is ONE level deep, so ' +
        'scripts/lib/<subdir>/ tests always need an explicit entry):\n    ' +
        nodeUncovered.join('\n    ')
    );
  }
  if (shellUncovered.length) {
    remedies.push(
      '  bash tests — add a literal `run: bash <path>` step to the unit-tests job in ' +
        'test.yml, next to the existing bash integration steps. A manifest entry and the ' +
        'node --test glob BOTH feed `node --test` and cannot run a shell script:\n    ' +
        shellUncovered.join('\n    ')
    );
  }
  assert.deepEqual(
    uncovered,
    [],
    'these scripts/lib tests run in NO CI job — the executed glob covers only ' +
      `${[...globExts].sort().join('/')}, no consumed manifest lists them, and no run: ` +
      'body names them.\n' +
      remedies.join('\n')
  );
});

// BRO-2751 regression pin. The check above is only as wide as TEST_FILE_RE, and
// the whole class of bug this file exists to catch is an extension quietly
// falling OUT of that pattern — which is exactly how 2 bash tests ran in zero
// CI jobs while this guard reported all-clear. A narrowed regex makes the check
// above pass with fewer files examined, i.e. the failure is silent and looks
// like success. Pin the two properties that matter explicitly.
test('the policed extension set covers bash tests, and node-runnable excludes them', () => {
  assert.ok(
    TEST_FILE_RE.test('x.test.sh'),
    'TEST_FILE_RE no longer matches *.test.sh — colocated bash tests just became ' +
      'invisible to the check above, which will keep passing while they run nowhere. ' +
      'Restore `sh` in TEST_FILE_EXTENSIONS (scripts/lib/test-manifest.js).'
  );
  for (const ext of ['mjs', 'js', 'cjs', 'ts']) {
    assert.ok(TEST_FILE_RE.test(`x.test.${ext}`), `TEST_FILE_RE stopped matching .test.${ext}`);
  }
  assert.ok(!TEST_FILE_RE.test('x.test.txt'), 'TEST_FILE_RE became too broad');

  // The remedy-branching in the assertion above, and audit-orphan-tests.js's
  // --list-exempt guard, both depend on `sh` being absent here. If `sh` ever
  // joins this list, a bash test would be told to add itself to a manifest —
  // advice that sends the reader to make CI red.
  assert.ok(
    !NODE_RUNNABLE_TEST_EXTENSIONS.includes('sh'),
    '`sh` must never be node-runnable: node --test cannot execute a shell script'
  );
  assert.ok(NODE_RUNNABLE_TEST_EXTENSIONS.includes('mjs'), 'mjs must stay node-runnable');
});
