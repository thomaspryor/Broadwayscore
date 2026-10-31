import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'run-push-audits.sh');
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT = join(LIB_DIR, '..', 'lint-write-routing.sh');

// --list mode selects without running (card #835) — fast + deterministic,
// doesn't pay for real audit runs against live repo state.
function listAudits(files, tipMessage = '') {
  const out = execFileSync('bash', [SCRIPT, '--list'], {
    input: files.join('\n'),
    encoding: 'utf8',
    // BRO-3014: pin the tip message so a real HEAD commit mentioning
    // [skip-cron-audit] cannot change selection under test.
    env: { ...process.env, PUSH_AUDITS_TIP_MESSAGE: tipMessage },
  });
  // conflict-markers (BRO-6687) selects on every non-empty list; it has its own tests below.
  return out.trim().split('\n').filter((l) => l && l !== 'conflict-markers').sort();
}

// BRO-5621: cheap CI-parity unit tests selected by any scripts/ source edit;
// the ~10s top-level coverage test only for a top-level non-test script.
const PARITY = ['ci-parity-autonomous-eligibility', 'ci-parity-sibling-matchers-diacritics'];
const PARITY_TOP = 'ci-parity-toplevel-script-test-yml';
const plus = (list, ...extra) => [...list, ...extra].sort();

test('empty file list selects no audits', () => {
  assert.deepEqual(listAudits([]), []);
});

test('unrelated file selects no audits', () => {
  assert.deepEqual(listAudits(['README.md']), []);
});

test('tests/unit/*.test.mjs selects the full test-registration audit set (BRO-3239)', () => {
  assert.deepEqual(
    listAudits(['tests/unit/push-ledger-store.test.mjs']),
    ['colocated-test-ci-coverage', 'orphan-tests', 'test-yml-manifest-paths', 'tests-vs-derived-data', 'toplevel-script-test-yml-coverage']
  );
});

// BRO-3239 HOLE 1: scripts/lib/**/*.test.* never triggered the test-
// registration block at all before this card — the old `[^/]*` trigger only
// matched a file directly under tests/unit/ or scripts/. Nested, not just
// top-level, proves the `.*` widening is actually recursive. Each fixture
// also lands the existing (unrelated to this card) scripts/**.{js,mjs,cjs,ts,sh}
// triggers — unbounded-fetch always, cmux-spawn-credential for non-.sh — so
// those are asserted here too rather than the test only proving the new
// block in isolation.
test('scripts/lib/**/*.test.* selects the full test-registration audit set (BRO-3239 HOLE 1)', () => {
  assert.deepEqual(
    listAudits(['scripts/lib/push-with-retry.stall-diagnostics.test.sh']),
    plus(['colocated-test-ci-coverage', 'orphan-tests', 'set-u-expansions', 'test-yml-manifest-paths', 'tests-vs-derived-data', 'toplevel-script-test-yml-coverage', 'unbounded-fetch'])
  );
  assert.deepEqual(
    listAudits(['scripts/lib/nested/deeper/x.test.mjs']),
    plus(['cmux-spawn-credential', 'colocated-test-ci-coverage', 'orphan-tests', 'test-yml-manifest-paths', 'tests-vs-derived-data', 'toplevel-script-test-yml-coverage', 'unbounded-fetch'], ...PARITY)
  );
});

// An unrelated scripts/lib/*.js (not a test file) must still select nothing
// from the test-registration block specifically — the widened trigger must
// stay anchored to .test.* files, not scripts/lib/ generally (which the
// pre-existing unbounded-fetch/cmux-spawn-credential triggers already cover).
test('a non-test scripts/lib/*.js file does not select the test-registration audits', () => {
  assert.deepEqual(listAudits(['scripts/lib/some-helper.js']), plus(['cmux-spawn-credential', 'unbounded-fetch'], ...PARITY));
});

// Adversarial review (BRO-3239): each of the 3 new audits require()s one or
// both of these as its canonical source (TEST_FILE_EXTENSIONS/MANIFESTS,
// push-path glob translation). Editing either alone, with no *.test.* file in
// the same push, must still re-trigger the block — otherwise a broken change
// to the canonical list ships without its own gate ever firing.
test('editing a canonical dependency (test-manifest.js / test-yml-push-paths.js) alone still selects the test-registration audits', () => {
  // BRO-2483: unit-test-collection.js decides the node unit batch, so it is a canonical dependency too.
  for (const dep of ['scripts/lib/test-manifest.js', 'scripts/lib/test-yml-push-paths.js', 'scripts/lib/unit-test-collection.js']) {
    const labels = listAudits([dep]);
    assert.ok(
      labels.includes('colocated-test-ci-coverage'),
      `editing ${dep} alone did not select colocated-test-ci-coverage — got: ${labels.join(', ')}`
    );
  }
});

test('scripts/*.js selects unbounded-fetch + write-routing + help-flag-safety', () => {
  assert.deepEqual(
    listAudits(['scripts/recover-wsj-browser.js']),
    plus(['cmux-spawn-credential', 'help-flag-safety', 'unbounded-fetch', 'write-routing'], ...PARITY, PARITY_TOP)
  );
});

// The help-flag audit is the most frequent recurring cause of a red main here, so
// its selection is asserted on its own input too, not only via the scripts/*.js
// case above: the baseline file can change without any script changing.
test('help-flag baseline change alone selects help-flag-safety', () => {
  assert.deepEqual(
    listAudits(['scripts/.help-flag-safety-baseline.json']),
    ['help-flag-safety']
  );
});

test('tests/e2e/*.ts selects playwright-evaluate-click only', () => {
  assert.deepEqual(listAudits(['tests/e2e/foo.spec.ts']), ['playwright-evaluate-click']);
});

test('.github/workflows/*.yml selects unbounded-fetch + the workflow-subject guards (BRO-2785) + the full test-registration set (BRO-3239, test.yml itself gates push-path coverage)', () => {
  assert.deepEqual(listAudits(['.github/workflows/test.yml']), [
    'blanket-sweep-audit-writes',
    'colocated-test-ci-coverage',
    'cron-health-coverage',
    'data-gate-heal-paths',
    'gate-corpus-guard-coverage',
    'orphan-tests',
    'push-retry-budgets',
    'reconcile-coverage',
    'test-yml-manifest-paths',
    'tests-vs-derived-data',
    'toplevel-script-test-yml-coverage',
    'unbounded-fetch',
    'workflow-actionlint',
    'workflow-concurrency',
    'workflow-hygiene',
    'workflow-line-length',
  ]);
});

// A change to the GUARD files themselves (not just their .yml subject) must
// still select them — same "or the guard script / its inputs" pattern the
// other blocks in this file already follow (see the unbounded-fetch and
// write-routing triggers above). Both fixture paths also happen to match
// pre-existing scripts/*.js triggers (unbounded-fetch, help-flag-safety,
// write-routing) — that overlap is correct, not a bug this card introduces.
test('a change to workflow-line-length.js alone selects workflow-line-length (plus its own scripts/*.js triggers)', () => {
  assert.deepEqual(listAudits(['scripts/lib/workflow-line-length.js']), plus([
    'cmux-spawn-credential',
    'unbounded-fetch',
    'workflow-actionlint',
    'workflow-concurrency',
    'workflow-line-length',
  ], ...PARITY));
});

test('a change to audit-workflow-concurrency.js alone selects workflow-concurrency (plus its own scripts/*.js triggers)', () => {
  assert.deepEqual(listAudits(['scripts/audit-workflow-concurrency.js']), plus([
    'cmux-spawn-credential',
    'gate-corpus-guard-coverage', // BRO-3014: it reads every scripts/audit-*.js
    'help-flag-safety',
    'unbounded-fetch',
    'workflow-actionlint',
    'workflow-concurrency',
    'workflow-line-length',
    'write-routing',
  ], ...PARITY, PARITY_TOP));
});

// BRO-3014: blocking CI audits wired into the lane, each on its own inputs.
test('BRO-3014: a non-test.yml workflow selects the workflow-content audits but not gate-corpus-guard-coverage', () => {
  const got = listAudits(['.github/workflows/rebuild-reviews.yml']);
  for (const a of ['workflow-hygiene', 'cron-health-coverage', 'data-gate-heal-paths', 'reconcile-coverage',
    'push-retry-budgets', 'blanket-sweep-audit-writes']) {
    assert.ok(got.includes(a), `${a} missing from ${got.join(',')}`);
  }
  assert.ok(!got.includes('gate-corpus-guard-coverage'), 'only test.yml carries the gated steps it reads');
});

test('BRO-3014: narrow triggers select exactly their audit', () => {
  assert.deepEqual(listAudits(['scripts/launchd/com.bsc.nightly.plist']), ['launchd-stale-sync-guard']);
  assert.deepEqual(listAudits(['scripts/.duplicate-of-floor.json']), ['duplicate-of-floor']);
  assert.deepEqual(listAudits(['src/app/page.tsx']), ['nft-excluded-runtime-reads']);
  assert.deepEqual(listAudits(['next.config.js']), ['nft-excluded-runtime-reads']);
  assert.ok(listAudits(['scripts/sweep-we-aggregators.js']).includes('verifier-wiring'));
  assert.ok(listAudits(['scripts/lib/push-with-retry.sh']).includes('push-retry-budgets'));
  assert.ok(listAudits(['scripts/lib/stage-data-changes.sh']).includes('blanket-sweep-audit-writes'));
});

test('BRO-3014: a [skip-cron-audit] tip commit skips cron-health-coverage, like CI', () => {
  assert.ok(listAudits(['.github/workflows/x.yml']).includes('cron-health-coverage'));
  assert.ok(!listAudits(['.github/workflows/x.yml'], 'chore: retime cron\n\n[skip-cron-audit]\n').includes('cron-health-coverage'));
  // Mentioning the tag in prose (a subject or body line) must not skip it.
  assert.ok(listAudits(['.github/workflows/x.yml'], 'chore: retime cron [skip-cron-audit]').includes('cron-health-coverage'));
  assert.ok(listAudits(['.github/workflows/x.yml'], 'fix: honour [skip-cron-audit] like CI').includes('cron-health-coverage'));
});

test('BRO-3014: the scripts/** source scanners stay CI-only (no --scope-stdin yet)', () => {
  const got = listAudits(['scripts/some-new-script.js']);
  for (const a of ['linear-issuecreate-chokepoint', 'digest-clip-safety', 'alert-senders', 'invisible-verification',
    'direct-provider-calls', 'venue-write-guard', 'text-quality', 'new-gate-arming']) {
    assert.ok(!got.includes(a), `${a} must not be in the push lane`);
  }
});

test('BRO-3014 end-to-end: the newly wired audits pass on the live repo', () => {
  execFileSync('bash', [SCRIPT, '.github/workflows/test.yml', 'scripts/launchd/x.plist', 'scripts/.duplicate-of-floor.json',
    'scripts/sweep-we-aggregators.js', 'next.config.js'], { encoding: 'utf8', stdio: 'pipe' });
});

test('argv form (no stdin) matches piped-stdin form', () => {
  const out = execFileSync(
    'bash',
    [SCRIPT, '--list', 'scripts/recover-wsj-browser.js'],
    { encoding: 'utf8' }
  );
  assert.deepEqual(out.trim().split('\n').filter(Boolean).sort(), plus([
    'cmux-spawn-credential',
    'help-flag-safety',
    'unbounded-fetch',
    'write-routing',
  ], ...PARITY, PARITY_TOP, 'conflict-markers'));
});

test('scripts/*.mjs and scripts/*.ts also select write-routing (not just .js)', () => {
  // lint-write-routing.sh's shows-json/commercial-json/audience-buzz-json
  // checks cover .js/.mjs/.ts writers; the local push-time trigger must be
  // able to fire on all three too, or a top-level .mjs/.ts writer silently
  // skips the local gate and is only caught later in CI (task #1826 review).
  assert.deepEqual(listAudits(['scripts/write-shows.mjs']), plus(['cmux-spawn-credential', 'unbounded-fetch', 'write-routing'], ...PARITY, PARITY_TOP));
  assert.deepEqual(listAudits(['scripts/write-shows.ts']), plus(['cmux-spawn-credential', 'unbounded-fetch', 'write-routing'], ...PARITY, PARITY_TOP));
});

test('mixed file list unions all applicable audits', () => {
  assert.deepEqual(
    listAudits(['scripts/foo.js', 'tests/unit/bar.test.mjs', 'tests/e2e/baz.spec.ts']),
    plus([
      'cmux-spawn-credential',
      'colocated-test-ci-coverage',
      'help-flag-safety',
      'orphan-tests',
      'playwright-evaluate-click',
      'test-yml-manifest-paths',
      'tests-vs-derived-data',
      'toplevel-script-test-yml-coverage',
      'unbounded-fetch',
      'write-routing',
    ], ...PARITY)
  );
});

// --- write-routing diff-scoping (card #1826) ---------------------------------
//
// run-push-audits.sh runs in scripts/merge-worktree-to-main.sh's SHARED main
// checkout (used by 20+ concurrent worktree sessions), so its write-routing
// call must be scoped to the incoming diff, not the whole working tree —
// otherwise a stray/untracked file left by an unrelated session can block an
// unrelated push. Two things need covering: (1) that run-push-audits.sh is
// actually WIRED to pass --scope-stdin + the changed-file list through (cheap
// source assertion, no execution); (2) that lint-write-routing.sh's
// --scope-stdin logic itself does the right thing (live, in an isolated temp
// git repo — never the real shared checkout, which other sessions may be
// using concurrently).

test('run-push-audits.sh pipes CHANGED_FILES into lint-write-routing.sh --scope-stdin', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(
    src,
    /printf '%s\\n' "\$CHANGED_FILES" \| bash scripts\/lint-write-routing\.sh --scope-stdin all/,
    'write-routing call must forward $CHANGED_FILES via --scope-stdin, not scan the whole tree'
  );
});

// Exercises the actual --scope-stdin scoping logic in lint-write-routing.sh,
// isolated in a throwaway git repo — this never touches the real shared
// checkout, so it can't collide with other concurrent sessions the way a
// live repro against the real scripts/ directory would.
function makeScopeTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lint-write-routing-scope-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('mkdir', ['scripts'], { cwd: dir });
  for (const name of [
    '.review-write-guard-exempt.txt',
    '.reviews-json-write-exempt.txt',
    '.shows-json-write-exempt.txt',
    '.commercial-json-write-exempt.txt',
    '.audience-buzz-json-write-exempt.txt',
  ]) {
    writeFileSync(join(dir, name), '# empty allowlist for test\n');
  }
  // Violates check_review_texts: writeFileSync(filePath, ...) + references
  // review-texts + no safeWriteReview import.
  writeFileSync(
    join(dir, 'scripts', 'stray.js'),
    "const fs = require('fs');\n" +
      "const REVIEW_TEXTS_DIR = 'data/review-texts';\n" +
      'function write(filePath, content) {\n' +
      '  fs.writeFileSync(filePath, content);\n' +
      '}\n'
  );
  writeFileSync(
    join(dir, 'scripts', 'target.js'),
    "console.log('clean script - no review-texts writes');\n"
  );
  return dir;
}

function runLint(dir, mode, scopeFiles) {
  const args = scopeFiles !== undefined ? ['--scope-stdin', mode] : [mode];
  try {
    const out = execFileSync('bash', [LINT_SCRIPT, ...args], {
      cwd: dir,
      input: scopeFiles !== undefined ? scopeFiles.join('\n') : undefined,
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('--scope-stdin: a stray violating file NOT in the diff does not block', () => {
  const dir = makeScopeTestRepo();
  try {
    const result = runLint(dir, 'review-texts', ['scripts/target.js']);
    assert.equal(result.code, 0, `expected pass, got:\n${result.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('--scope-stdin: a violating file that IS in the diff still blocks (regression safety)', () => {
  const dir = makeScopeTestRepo();
  try {
    const result = runLint(dir, 'review-texts', ['scripts/stray.js']);
    assert.equal(result.code, 1, 'expected the in-scope violation to fail the audit');
    assert.match(result.out, /stray\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('--scope-stdin: an allowlist-only diff falls back to a full scan (does not silently pass)', () => {
  const dir = makeScopeTestRepo();
  try {
    // Only the allowlist changed — none of scripts/*.js is in the diff. If
    // candidate_files() scoped naively, it would check zero files and pass
    // despite stray.js's real violation sitting unexamined in the tree.
    const result = runLint(dir, 'review-texts', ['.review-write-guard-exempt.txt']);
    assert.equal(result.code, 1, `expected fallback full-scan to still catch stray.js, got:\n${result.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// --- BRO-2785: workflow-subject guard floor ---------------------------------
//
// Proves the actual defect the card reports: a .github/workflows/*.yml line
// over the 500-char cap is DETECTED by the same findLongLines() function
// tests/unit/workflow-line-length.test.mjs runs (the card's own VERIFY
// command), and that run-push-audits.sh's new trigger (asserted via --list
// above) actually SELECTS that check for a workflow-only diff — not just each
// half in isolation.

test('findLongLines detects a 504-char line (the exact BRO-2771 shape) and reports the correct line/length', () => {
  const { findLongLines } = require(join(LIB_DIR, 'workflow-line-length.js'));
  const dir = mkdtempSync(join(tmpdir(), 'workflow-line-length-fixture-'));
  try {
    writeFileSync(
      join(dir, 'fixture.yml'),
      `on: push\njobs:\n  x:\n    steps:\n      - run: echo "${'a'.repeat(490)}"\n`
    );
    const violations = findLongLines(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'fixture.yml');
    assert.equal(violations[0].line, 5);
    assert.ok(violations[0].length > 500, `expected >500 chars, got ${violations[0].length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('findLongLines passes on a well-formed workflow with no long lines', () => {
  const { findLongLines } = require(join(LIB_DIR, 'workflow-line-length.js'));
  const dir = mkdtempSync(join(tmpdir(), 'workflow-line-length-fixture-'));
  try {
    writeFileSync(join(dir, 'fixture.yml'), 'on: push\njobs:\n  x:\n    steps:\n      - run: echo hi\n');
    assert.deepEqual(findLongLines(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// End-to-end (real repo, not a scratch fixture — reusing the file's own
// established pattern from the write-routing test below): run-push-audits.sh
// must actually RUN workflow-line-length + workflow-concurrency for a
// workflow-only diff, and the live .github/workflows/ tree (which CI already
// keeps green) must pass both.
test('end-to-end: run-push-audits.sh runs the new workflow-subject guards and they pass on the live repo', () => {
  const out = execFileSync('bash', [SCRIPT], {
    input: '.github/workflows/check-cron-health.yml\n',
    encoding: 'utf8',
  });
  assert.doesNotMatch(out, /AUDIT BLOCKED: workflow-line-length/);
  assert.doesNotMatch(out, /AUDIT BLOCKED: workflow-concurrency/);
});

test('no --scope-stdin (CI direct-call mode) still scans the whole tree', () => {
  const dir = makeScopeTestRepo();
  try {
    const result = runLint(dir, 'review-texts', undefined);
    assert.equal(result.code, 1, 'CI direct calls must keep scanning the full checkout');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// End-to-end: actually run run-push-audits.sh (not --list) against a real,
// currently-clean top-level script in THIS checkout, proving the real wiring
// — CHANGED_FILES piped into --scope-stdin, consumed by lint-write-routing.sh
// — works together, not just each half in isolation (the source-grep test
// above and the isolated-repo tests can't catch a wiring break between them).
test('end-to-end: run-push-audits.sh passes on a real clean scripts/*.js file', () => {
  // Only asserts on the write-routing audit specifically (not overall exit
  // code) — this file also triggers unbounded-fetch/help-flag-safety, whose
  // pass/fail is out of scope for this card and shouldn't make this test flaky.
  let out;
  try {
    out = execFileSync('bash', [SCRIPT], {
      input: 'scripts/validate-data.js\n',
      encoding: 'utf8',
    });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  assert.doesNotMatch(out, /AUDIT BLOCKED: write-routing/);
});

// BRO-6687: committed conflict markers are blocked on every audited push, not only
// on push-with-retry.sh's CI pushes. Marker lines are built at runtime so this
// file never carries one at line start.
const OPEN = '<'.repeat(7), CLOSE = '>'.repeat(7);
const rawList = (files, env = {}) => execFileSync('bash', [SCRIPT, '--list'], {
  input: files.join('\n'), encoding: 'utf8', env: { ...process.env, PUSH_AUDITS_TIP_MESSAGE: '', ...env },
}).trim().split('\n').filter(Boolean);

test('conflict-markers is selected for any changed file, even a deleted one, and honours PUSH_SKIP_CONFLICT_CHECK', () => {
  assert.ok(rawList(['README.md']).includes('conflict-markers'));
  assert.ok(rawList(['no/such/file.json']).includes('conflict-markers'));
  assert.ok(!rawList(['README.md'], { PUSH_SKIP_CONFLICT_CHECK: '1' }).includes('conflict-markers'));
});

test('conflict-markers blocks a pushed file with markers and passes clean, binary and deleted files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-audit-'));
  try {
    const bad = join(dir, 'ledger.jsonl');
    const clean = join(dir, 'clean.jsonl');
    const bin = join(dir, 'img.png');
    writeFileSync(bad, `{"a":1}\n${OPEN} Updated upstream\n{"b":2}\n=======\n{"c":3}\n${CLOSE} Stashed changes\n`);
    writeFileSync(clean, '{"a":1}\n');
    writeFileSync(bin, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.from(`\n${OPEN}<<\n`)]));
    const cli = (...files) => { try { execFileSync('node', [join(LIB_DIR, 'conflict-markers.js'), ...files], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
    assert.equal(cli(bad), 1);
    assert.equal(cli(clean, bin, join(dir, 'gone.json')), 0);
    // The runner itself: absolute paths work although it cds to the repo root.
    const run = (files) => { try { execFileSync('bash', [SCRIPT], { input: files.join('\n'), stdio: 'pipe' }); return { code: 0, out: '' }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
    const r = run([bad]);
    assert.equal(r.code, 1);
    assert.match(r.out, /AUDIT BLOCKED: conflict-markers failed/);
    assert.equal(run([clean, join(dir, 'gone.json')]).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('set-u-expansions runs strict on changed shell scripts only, and blocks an unguarded expansion (BRO-6687)', () => {
  assert.ok(listAudits(['scripts/lib/stage-data-changes.sh']).includes('set-u-expansions'));
  assert.ok(!listAudits(['scripts/foo.js']).includes('set-u-expansions'));
  const dir = mkdtempSync(join(tmpdir(), 'setu-audit-'));
  try {
    const sh = join(dir, 'bad.sh');
    writeFileSync(sh, '#!/usr/bin/env bash\nset -uo pipefail\nA=()\nprintf "%s" "${A[@]}"\n');
    let code = 0, out = '';
    try { execFileSync('bash', [SCRIPT], { input: sh, stdio: 'pipe' }); } catch (e) { code = e.status; out = String(e.stdout); }
    assert.equal(code, 1);
    assert.match(out, /AUDIT BLOCKED: set-u-expansions failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
