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
const { MANIFESTS, TEST_FILE_EXTENSIONS, NODE_RUNNABLE_TEST_EXTENSIONS, testFileRegex } = require('./test-manifest.js');
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

/**
 * Does `runText` actually INVOKE relPath, as opposed to merely naming it?
 *
 * For a node test this stays the historical `includes()` check: the repo runs
 * those a dozen different ways (`node --test a b c`, a manifest expansion, a
 * repeat loop) and a stricter rule would produce false REDs on real coverage.
 *
 * For a shell test it does NOT. There is exactly one way a *.test.sh runs here
 * — an interpreter followed by the literal path — so the loose check bought
 * nothing and cost real assurance: with `sh` newly policed, `includes()` is the
 * SOLE coverage proof for all 17 colocated bash tests, and it would have
 * accepted `run: echo "see scripts/lib/x.test.sh"`, a commented-out step
 * resurrected as a string, or the path appearing as an argument to something
 * else entirely. That is the same forge-a-mention false-all-clear this file's
 * header describes task #1643 fixing in audit-orphan-tests.js, so it should not
 * be reintroduced through the branch that now carries the most weight.
 *
 * Deliberately anchored at a command position (line start or after ;, &&, ||, |)
 * so a path inside a quoted echo argument cannot pass.
 */
function isInvokedIn(runText, relPath, ext) {
  if (NODE_RUNNABLE_TEST_EXTENSIONS.includes(ext)) return runText.includes(relPath);
  const escaped = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const invocation = new RegExp(`(?:^|[;&|])\\s*(?:bash|sh|zsh)\\s+(?:-\\S+\\s+)*${escaped}(?![\\w./-])`, 'm');
  return invocation.test(runText);
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
    // A manifest is fed straight to `node --test`, so listing a shell script in
    // one proves nothing — it would fail at run time for the wrong reason.
    // Only node-runnable extensions may claim coverage this way.
    if (manifestEntries.has(relPath) && NODE_RUNNABLE_TEST_EXTENSIONS.includes(ext)) continue;
    if (isInvokedIn(runText, relPath, ext)) continue;
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

// The forge-a-mention cases isInvokedIn() exists to reject. Written as explicit
// adversarial fixtures rather than trusting the live corpus: the corpus is
// green today, so a regression that re-loosens the rule would not show up in
// the check above at all — it would just silently accept more.
test('a shell test only counts as covered when a run: body actually invokes it', () => {
  const P = 'scripts/lib/example.test.sh';
  const covered = [
    `bash ${P}`,
    `  bash ${P}`,
    `bash -x ${P}`,
    `sh ${P}`,
    `setup && bash ${P}`,
    `foo; bash ${P}`,
    `a || bash ${P}`,
    `bash ${P}\nnext line`,
  ];
  for (const runText of covered) {
    assert.ok(isInvokedIn(runText, P, 'sh'), `should count as invoked: ${JSON.stringify(runText)}`);
  }
  const notCovered = [
    `echo "see ${P}"`,
    `echo '${P} is unsupported'`,
    `# bash ${P}`, // shell comments are stripped upstream, but never rely on that alone
    `node --test ${P}`, // wrong interpreter — node cannot run it
    `bash ${P}.bak`, // a different file that merely starts with the same path
    `bash scripts/lib/other-${P.slice('scripts/lib/'.length)}`,
    `cat ${P}`,
    `ls ${P}`,
    P,
    '',
  ];
  for (const runText of notCovered) {
    assert.ok(!isInvokedIn(runText, P, 'sh'), `should NOT count as invoked: ${JSON.stringify(runText)}`);
  }
  // Node tests keep the historical loose rule on purpose — the repo runs them
  // a dozen ways and tightening here would produce false REDs on real coverage.
  assert.ok(isInvokedIn('node --test scripts/lib/x.test.mjs', 'scripts/lib/x.test.mjs', 'mjs'));
});

// BRO-2751: scripts/lib/run-push-audits.sh gates the local pre-push orphan-test
// audit on its own grep -E of test-file extensions. It is shell, so it cannot
// require() the canonical list — and when it drifted narrower than the audit it
// gates, a push adding a .test.sh skipped that gate entirely. Pin the two
// together here, which is the only place that can see both.
test('run-push-audits.sh gates on the same test-file extensions as the canonical list', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/run-push-audits.sh'), 'utf8');
  const m = src.match(/\\\.test\\\.\(([a-z|]+)\)\$/);
  assert.ok(
    m,
    'could not find the orphan-test gate pattern in scripts/lib/run-push-audits.sh — if it was ' +
      'restructured, update this assertion; do not delete it.'
  );
  assert.deepEqual(
    m[1].split('|').sort(),
    [...TEST_FILE_EXTENSIONS].sort(),
    'scripts/lib/run-push-audits.sh gates the pre-push orphan-test audit on a different ' +
      'extension set than scripts/lib/test-manifest.js TEST_FILE_EXTENSIONS. A push adding a ' +
      'test in the missing extension would skip that gate entirely.'
  );
});
