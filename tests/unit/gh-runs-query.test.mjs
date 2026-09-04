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
  ],
};

/**
 * Run gh_runs_query with a stubbed `gh` binary.
 * @param {string[]} args - arguments after the function name
 * @returns {{stdout: string, status: number, ghArgs: string[]}}
 */
function runHelper(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-runs-query-test-'));
  try {
    const argsFile = path.join(dir, 'gh-args.txt');
    const fixtureFile = path.join(dir, 'fixture.json');
    fs.writeFileSync(fixtureFile, JSON.stringify(FIXTURE));

    // Stub gh: record argv, then apply the --jq program to the fixture with real jq,
    // exactly as `gh api --jq` would.
    const stub = path.join(dir, 'gh');
    fs.writeFileSync(stub, [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > "${argsFile}"`,
      'prog="."',
      'if [ "$3" = "--jq" ]; then prog="$4"; fi',
      `jq "$prog" < "${fixtureFile}"`,
      '',
    ].join('\n'));
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
  const body = helperSrc.split('gh_runs_query() {')[1] || '';
  assert.ok(
    !/GITHUB_REPOSITORY/.test(body),
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
  assert.equal(parsed.length, 3, 'length must be the run count, not the object key count');
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

test('runs come back newest-first regardless of the order the endpoint returned them in', () => {
  const { stdout } = runHelper(['{owner}/{repo}', 'test.yml', '5']);
  const ids = JSON.parse(stdout).map((r) => r.databaseId);
  assert.deepEqual(ids, [333, 222, 111], 'must be sorted by createdAt descending');
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

test('check-cron-health sources the helper in every step that queries runs', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/check-cron-health.yml'), 'utf8');
  // Each `run:` block is its own shell, so one source at the top of the file is not
  // enough — a missing source is a "command not found" only at 12:00 UTC in prod.
  const sources = (src.match(/\.\s+scripts\/lib\/gh-runs-query\.sh/g) || []).length;
  const calls = (src.match(/gh_runs_query\s+"\$GITHUB_REPOSITORY"/g) || []).length;
  assert.ok(calls >= 3, `expected at least 3 gh_runs_query calls, found ${calls}`);
  assert.equal(sources, 2, `expected the helper sourced once per run-querying step, found ${sources}`);
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
