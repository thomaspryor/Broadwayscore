// BRO-2771 — scripts/lib/gh-runs-query.sh, the bash companion to BRO-2767's
// ghRunsQuery() in scripts/health-check.js.
//
// These tests exist because the failure mode of getting this wrong is SILENT. A
// naive port that emits raw REST keys (.id/.created_at) instead of `gh run list
// --json` names, or that returns the REST object instead of an array, does not
// throw anywhere — it makes check-cron-health report "No successful runs found at
// all!" for every cron it watches, and makes the deploy-duration step compute a
// duration from an empty date and exit 1 on every daily run.
//
// The helper is exercised through a stubbed `gh` on PATH, so the assertions cover
// the URL it actually builds, not a re-implementation of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER = path.join(REPO_ROOT, 'scripts', 'lib', 'gh-runs-query.sh');

// Deliberately NOT in newest-first order, and deliberately including a run whose
// created_at is missing — the helper must impose the ordering itself rather than
// inherit whatever the transport hands it.
const FIXTURE = {
  total_count: 3,
  workflow_runs: [
    { id: 111, head_sha: 'aaaaaaaaaaa', created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:12:00Z', conclusion: 'failure', status: 'completed' },
    { id: 333, head_sha: 'ccccccccccc', created_at: '2026-09-03T10:00:00Z', updated_at: '2026-09-03T10:09:00Z', conclusion: 'success', status: 'completed' },
    { id: 222, head_sha: 'bbbbbbbbbbb', created_at: '2026-09-02T10:00:00Z', updated_at: '2026-09-02T10:11:00Z', conclusion: null, status: 'in_progress' },
    { id: 444, head_sha: 'ddddddddddd', created_at: null, updated_at: null, conclusion: 'success', status: 'completed' },
  ],
};

/**
 * Run gh_runs_query with a stubbed `gh` binary.
 * @param {string[]} args - arguments after the function name
 * @returns {{stdout: string, status: number, ghArgs: string[]}}
 */
function runHelper(args, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-runs-query-test-'));
  try {
    const argsFile = path.join(dir, 'gh-args.txt');
    const fixtureFile = path.join(dir, 'fixture.json');
    fs.writeFileSync(fixtureFile, JSON.stringify(FIXTURE));

    // Stub gh: record argv, then apply the --jq program to the fixture with real jq,
    // exactly as `gh api --jq` would.
    //
    // failLikeGhApi reproduces the real `gh api` non-2xx behaviour: the HTTP error
    // BODY goes to STDOUT raw (--jq bypassed) and the exit status is non-zero. This
    // is the single most dangerous difference from `gh run list`, which printed
    // nothing on failure.
    const stub = path.join(dir, 'gh');
    const body = [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > "${argsFile}"`,
      ...(opts.failLikeGhApi
        ? [
          'echo \'{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}\'',
          'echo "gh: Not Found (HTTP 404)" >&2',
          'exit 1',
        ]
        : [
          'prog="."',
          'if [ "$3" = "--jq" ]; then prog="$4"; fi',
          `jq "$prog" < "${fixtureFile}"`,
        ]),
      '',
    ];
    fs.writeFileSync(stub, body.join('\n'));
    fs.chmodSync(stub, 0o755);

    const driver = path.join(dir, 'driver.sh');
    fs.writeFileSync(driver, [
      '#!/usr/bin/env bash',
      `. "${HELPER}"`,
      'gh_runs_query "$@"',
      '',
    ].join('\n'));

    let stdout = '';
    let status = 0;
    try {
      stdout = execFileSync('bash', [driver, ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = typeof err.status === 'number' ? err.status : 1;
      stdout = err.stdout || '';
    }

    const ghArgs = fs.existsSync(argsFile)
      ? fs.readFileSync(argsFile, 'utf8').split('\n').filter(Boolean)
      : [];
    return { stdout, status, ghArgs };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('gh_runs_query hits the Actions REST runs endpoint, never gh run list', () => {
  const { ghArgs } = runHelper(['{owner}/{repo}', 'test.yml', '5']);
  assert.equal(ghArgs[0], 'api', 'first arg must be `api` — a `run` subcommand means it regressed to gh run list');
  assert.equal(ghArgs[1], 'repos/{owner}/{repo}/actions/workflows/test.yml/runs?per_page=5');
});

test('gh_runs_query takes the repo as an explicit argument rather than resolving it internally', () => {
  // The right answer differs by caller: workflows pass $GITHUB_REPOSITORY (matching
  // how check-cron-health.yml already resolves the repo in the same bash step),
  // local runs pass the {owner}/{repo} placeholder. Neither may be hardcoded here.
  const { ghArgs } = runHelper(['someowner/somerepo', 'test.yml', '1']);
  assert.match(ghArgs[1], /^repos\/someowner\/somerepo\//);

  const helperSrc = fs.readFileSync(HELPER, 'utf8');
  const parts = helperSrc.split('gh_runs_query() {');
  // Without this the assertion below passes vacuously if the function is ever renamed.
  assert.equal(parts.length, 2, 'could not locate the gh_runs_query function body');
  assert.ok(
    !/GITHUB_REPOSITORY/.test(parts[1]),
    'the helper body must not read GITHUB_REPOSITORY — callers pass the repo explicitly',
  );
});

test('extra key=value filters are appended to the query string', () => {
  const { ghArgs } = runHelper(['{owner}/{repo}', 'test.yml', '20', 'branch=main', 'event=push']);
  assert.equal(ghArgs[1], 'repos/{owner}/{repo}/actions/workflows/test.yml/runs?per_page=20&branch=main&event=push');

  const success = runHelper(['{owner}/{repo}', 'vercel-deploy.yml', '5', 'status=success']);
  assert.equal(success.ghArgs[1], 'repos/{owner}/{repo}/actions/workflows/vercel-deploy.yml/runs?per_page=5&status=success');
});

test('output is a JSON ARRAY, not the raw REST object', () => {
  // Raw REST returns {total_count, workflow_runs}, whose `jq length` is 2 — the key
  // count. check-cron-health's deploy-duration step does exactly `jq 'length'` on
  // this and would have errored + exited 1 on every daily run.
  const { stdout } = runHelper(['{owner}/{repo}', 'vercel-deploy.yml', '5']);
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed), 'result must be an array');
  assert.equal(parsed.length, FIXTURE.workflow_runs.length, 'length must be the run count, not the object key count');
  assert.notEqual(parsed.length, 2, 'length 2 is the REST object key count — the array wrapper is missing');
});

test('projection keeps gh-run-list field names so downstream jq needs no edits', () => {
  const { stdout } = runHelper(['{owner}/{repo}', 'test.yml', '5']);
  const [first] = JSON.parse(stdout);
  for (const key of ['databaseId', 'headSha', 'createdAt', 'updatedAt', 'conclusion', 'status']) {
    assert.ok(key in first, `missing projected key ${key}`);
  }
  for (const restKey of ['id', 'head_sha', 'created_at', 'updated_at']) {
    assert.ok(!(restKey in first), `raw REST key ${restKey} leaked into the projection`);
  }
});

test('runs come back newest-first, with a null created_at sorted LAST not first', () => {
  // Run 444 has created_at: null. Under a bare `sort_by(.createdAt) | reverse`, jq
  // orders null BEFORE strings, so reversing puts it at the HEAD — it would become
  // the "most recent run" and drive every recency verdict. scripts/health-check.js's
  // sortRunsNewestFirst() sends unparseable dates to the end; this must match.
  const { stdout } = runHelper(['{owner}/{repo}', 'test.yml', '5']);
  const ids = JSON.parse(stdout).map((r) => r.databaseId);
  assert.deepEqual(ids, [333, 222, 111, 444], 'newest-first, undated last');
});

test('a failed gh api emits NOTHING on stdout, despite gh printing the error body there', () => {
  // `gh api` writes the HTTP error body to STDOUT on a non-2xx, raw, with --jq
  // bypassed — `gh run list` wrote nothing. A caller doing `gh_runs_query ... ||
  // echo '[]'` would otherwise get `{"message":"Not Found",...}[]`, and `jq 'length'`
  // on that yields a multi-line string that makes `[ "$COUNT" -eq 0 ]` error out and
  // be skipped under set -e, turning a 403 into a printed "durations healthy".
  const { stdout, status } = runHelper(['{owner}/{repo}', 'test.yml', '5'], { failLikeGhApi: true });
  assert.notEqual(status, 0, 'a failed query must exit non-zero');
  assert.equal(stdout.trim(), '', 'a failed query must print nothing on stdout');
  assert.ok(!stdout.includes('Not Found'), 'the HTTP error body must not reach stdout');
});

test('per-page outside 1-100 fails loudly instead of silently truncating', () => {
  // The REST endpoint caps per_page at 100 and returns a SHORTER window than asked
  // for. For a streak scan that reads as "the streak ended here".
  for (const bad of ['101', '0', 'abc', '']) {
    const { status, ghArgs } = runHelper(['{owner}/{repo}', 'test.yml', bad]);
    assert.equal(status, 2, `per-page ${JSON.stringify(bad)} should exit 2`);
    assert.equal(ghArgs.length, 0, `per-page ${JSON.stringify(bad)} should never reach gh`);
  }
  for (const ok of ['1', '100']) {
    const { status } = runHelper(['{owner}/{repo}', 'test.yml', ok]);
    assert.equal(status, 0, `per-page ${ok} should be accepted`);
  }
});

test('a missing repo or workflow fails loudly rather than querying repos//actions/...', () => {
  assert.equal(runHelper(['', 'test.yml', '5']).status, 2);
  assert.equal(runHelper(['{owner}/{repo}', '', '5']).status, 2);
});

// --- Static assertions over the call sites BRO-2771 converted -------------------
// Scoped to the named sites on purpose: `gh run list` appears ~140 times repo-wide
// and most of those are not order- or recency-sensitive. A blanket repo-wide
// assertion would be unsatisfiable and would get deleted the first time it fired.

/**
 * Lines of a repo file with comment-only lines removed, so a `gh run list`
 * mentioned in an explanatory comment does not read as a live call site.
 * @param {string} rel
 * @returns {string[]}
 */
function liveLines(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/|\*)/.test(l));
}

test('the converted call sites carry no live `gh run list`', () => {
  for (const rel of [
    '.github/workflows/check-cron-health.yml',
    '.github/workflows/vercel-deploy.yml',
    'scripts/ci-health-check.sh',
  ]) {
    const offenders = liveLines(rel).filter((l) => l.includes('gh run list'));
    assert.deepEqual(offenders, [], `${rel} still has a live gh run list: ${offenders.join(' | ')}`);
  }
});

test('every check-cron-health STEP that calls the helper also sources it', () => {
  // Each `run:` block is its own shell, so counting sources and calls file-globally
  // proves nothing: adding a 4th call in a NEW un-sourcing step keeps both totals
  // "valid" while production dies at 12:00 UTC with `gh_runs_query: command not
  // found`. Pair them per step instead.
  const src = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/check-cron-health.yml'), 'utf8');
  const steps = src.split(/^ {6}- name: /m).slice(1);
  assert.ok(steps.length > 1, 'failed to split the workflow into steps — the split pattern drifted');

  // Must match `$(gh_runs_query ...)` as well as a bare call — the recency checks
  // use command substitution, so a leading-whitespace-only pattern silently sees
  // ONE caller instead of two and the whole assertion goes soft.
  const callers = steps.filter((s) => /[\s(]gh_runs_query\s/.test(s));
  assert.ok(callers.length >= 2, `expected at least 2 steps calling the helper, found ${callers.length}`);

  for (const step of callers) {
    const stepName = step.split('\n')[0].trim();
    assert.match(
      step,
      /^\s*\.\s+scripts\/lib\/gh-runs-query\.sh\s*$/m,
      `step "${stepName}" calls gh_runs_query but never sources scripts/lib/gh-runs-query.sh`,
    );
  }
});

test('the helper is sourced only after the repo is checked out', () => {
  // A relative source path resolves against $GITHUB_WORKSPACE, which is empty until
  // actions/checkout has run.
  const src = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/check-cron-health.yml'), 'utf8');
  const checkoutAt = src.indexOf('actions/checkout');
  const firstSourceAt = src.search(/^\s*\.\s+scripts\/lib\/gh-runs-query\.sh\s*$/m);
  assert.ok(checkoutAt > -1, 'workflow no longer checks out the repo');
  assert.ok(firstSourceAt > checkoutAt, 'the helper is sourced before actions/checkout runs');
});

test("vercel-deploy's inlined copy stays equivalent to the helper", () => {
  // check-streak has no actions/checkout, so it cannot source the helper. The
  // things that make the helper correct must still be present inline.
  const src = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/vercel-deploy.yml'), 'utf8');
  const step = src.split('check-streak:')[1] || '';
  assert.ok(step.includes('/actions/workflows/vercel-deploy.yml/runs?per_page=20'), 'must use the REST runs endpoint');
  assert.ok(step.includes('.workflow_runs[]'), 'must read .workflow_runs');
  assert.ok(/sort_by\(\.createdAt\)\s*\|\s*reverse/.test(step), 'must sort newest-first rather than trusting transport order');
  assert.ok(step.includes('gh-runs-query.sh'), 'must point at the helper it is duplicating');
});
