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
 * non-recursive and its REFERENCE_REGEX only sees literal filenames, so it is
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
 * that runs it. A new colocated test in any extension is covered, or this fails
 * and names the file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MANIFESTS } = require('./test-manifest.js');

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(LIB_DIR, '..', '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

// A colocated test file, by any of the extensions `node --test` can run.
const TEST_FILE_RE = /\.test\.(mjs|js|cjs|ts)$/;

/**
 * Shell globs over scripts/lib/ that a workflow actually EXECUTES.
 *
 * Matched against non-comment lines only: test.yml explains this glob in ~12
 * separate `#` comments, and counting one of those as execution is precisely
 * the mistake this test is here to make impossible.
 */
function executedGlobExtensions(workflowSource) {
  const extensions = new Set();
  for (const line of workflowSource.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    // e.g. `tests=(scripts/lib/*.test.mjs)` or a direct
    // `node --test scripts/lib/*.test.mjs`. Brace form
    // `scripts/lib/*.test.{mjs,js}` is read as both extensions.
    for (const m of line.matchAll(/scripts\/lib\/\*\.test\.\{([a-z,]+)\}/g)) {
      for (const ext of m[1].split(',')) extensions.add(ext.trim());
    }
    for (const m of line.matchAll(/scripts\/lib\/\*\.test\.([a-z]+)\b/g)) {
      extensions.add(m[1]);
    }
  }
  return extensions;
}

function readWorkflows() {
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  return files.map((f) => fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8')).join('\n');
}

test('every scripts/lib/*.test.* file is executed by CI (glob, manifest or literal)', () => {
  const workflowSource = readWorkflows();
  const globExts = executedGlobExtensions(workflowSource);

  // The glob is the primary mechanism; if it ever disappears, every colocated
  // test silently stops running and this assertion is the only thing that says
  // so. Absence of a signal must not read as success.
  assert.ok(
    globExts.size > 0,
    'no scripts/lib/*.test.<ext> glob is EXECUTED by any workflow — every colocated ' +
      'test just lost its CI coverage. Restore the glob in test.yml\'s unit-tests job.'
  );
  assert.ok(
    globExts.has('mjs'),
    `the scripts/lib glob no longer covers .mjs (covers: ${[...globExts].join(', ') || 'nothing'})`
  );

  const manifestEntries = new Set();
  for (const manifest of MANIFESTS) {
    const p = path.join(ROOT, manifest);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const entry = line.trim();
      if (entry) manifestEntries.add(entry);
    }
  }

  // Literal `scripts/lib/<name>` mentions in a workflow, comments excluded for
  // the same reason as above.
  const workflowCode = workflowSource
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  const uncovered = [];
  for (const file of fs.readdirSync(LIB_DIR).sort()) {
    if (!TEST_FILE_RE.test(file)) continue;
    if (file.startsWith('_skip-')) continue; // the repo-wide opt-out convention
    const ext = file.slice(file.lastIndexOf('.') + 1);
    if (globExts.has(ext)) continue;
    if (manifestEntries.has(`scripts/lib/${file}`)) continue;
    if (workflowCode.includes(`scripts/lib/${file}`)) continue;
    uncovered.push(file);
  }

  assert.deepEqual(
    uncovered,
    [],
    `these scripts/lib tests run in NO CI job — the glob covers only ` +
      `${[...globExts].sort().join('/')}, and nothing else names them. Either add the ` +
      `extension to test.yml's scripts/lib glob, or list the file in ` +
      `tests/unit-test-manifest.txt:\n  ${uncovered.join('\n  ')}`
  );
});
