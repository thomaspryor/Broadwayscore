import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

// BRO-2795: commercial-rss-poll.yml's "Commit data changes" step names only
// data/commercial-pending-review.json + data/commercial-rss-state.json in its
// git-add-existing.sh call, but its stage-data-changes.sh call (no args)
// sweeps ALL of data/ minus the fixed private-path exclusions — so
// data/audit/bd-circuit-breaker.json and data/audit/sd-circuit-breaker.json,
// written moments earlier by the two breaker-check steps, ride along. Every
// unregistered data/audit/ path in a commit's diff disqualifies push-with-
// retry.sh's Git Data API fallback outright (the fail-closed "any unaudited
// data/audit/ path" branch), which is exactly what stranded this workflow's
// push on the local fetch+rebase+push race for 3 consecutive hourly runs
// starting 2026-09-04T11:47Z (run 33906734626).
//
// This test does not re-implement push-with-retry.sh's disqualifier — it
// shells out to the real scripts/lib/api-fallback-disqualifier.js CLI (the
// exact command push-with-retry.sh's api_fallback_paths_ok() runs — BRO-3663
// extracted the inline `node -e` heredoc this test used to string-scrape out
// of push-with-retry.sh into that standalone module, one definition shared by
// the early-break gate and the authoritative check) against a real git
// fixture, so a future edit to the real predicate is what this test
// exercises, not a copy that can silently drift out of sync (CLAUDE.md rule
// 15 / rule on canonical predicates).

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DISQUALIFIER_CLI_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'api-fallback-disqualifier.js');

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-retry-disqualifier-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('commit', '--allow-empty', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD').trim();
  return { dir, git, baseSha };
}

function commitChangedFiles(fixture, relativePaths) {
  for (const rel of relativePaths) {
    const abs = path.join(fixture.dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `{"fixture": "${rel}", "id": "${crypto.randomUUID()}"}\n`);
  }
  fixture.git('add', '-A');
  fixture.git('commit', '-q', '-m', 'head');
  return fixture.git('rev-parse', 'HEAD').trim();
}

// Returns push-with-retry.sh's real exit code for this diff: 0 = fallback
// stays ELIGIBLE, 1 (or any non-zero) = fallback is DISQUALIFIED.
function runDisqualifierCheck(relativePaths) {
  const fixture = makeFixtureRepo();
  try {
    const headSha = commitChangedFiles(fixture, relativePaths);
    const result = spawnSync('node', [DISQUALIFIER_CLI_PATH, fixture.baseSha, headSha], {
      cwd: fixture.dir,
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined, `api-fallback-disqualifier.js crashed to spawn: ${result.error}`);
    return result.status;
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('sanity: harness disqualifies an unregistered data/audit/ path (proves the extraction actually runs the real check)', () => {
  const rc = runDisqualifierCheck(['data/audit/brand-new-never-seen-before.json']);
  assert.equal(rc, 1, 'expected an unregistered data/audit/ path to disqualify the fallback');
});

test('sanity: harness leaves an ordinary non-audit data file alone', () => {
  const rc = runDisqualifierCheck(['data/some-unrelated-file.json']);
  assert.equal(rc, 0, 'expected a non-audit, non-MANAGED path to stay fallback-eligible');
});

test('commercial-rss-poll.yml "Commit breaker state" step diff stays fallback-eligible', () => {
  const rc = runDisqualifierCheck([
    'data/audit/bd-circuit-breaker.json',
    'data/audit/sd-circuit-breaker.json',
    'data/audit/breaker-transitions.jsonl',
    'data/audit/alert-ledger.json',
    'data/audit/alert-digest-queue.json',
  ]);
  assert.equal(rc, 0, 'data/audit/sd-circuit-breaker.json (and its bd- sibling) must be apiFallbackSafe — see core-data-merge-registry.js (BRO-2795)');
});

test('commercial-rss-poll.yml "Commit data changes" step diff stays fallback-eligible even when the breaker files ride along', () => {
  // Reproduces the exact BRO-2795 shape: git-add-existing.sh only names the
  // first two files, but stage-data-changes.sh's broad sweep of data/ also
  // picks up the two circuit-breaker files if they were (re-)written this
  // job and not yet committed by an earlier step.
  const rc = runDisqualifierCheck([
    'data/commercial-pending-review.json',
    'data/commercial-rss-state.json',
    'data/audit/bd-circuit-breaker.json',
    'data/audit/sd-circuit-breaker.json',
  ]);
  assert.equal(rc, 0, 'the full 4-file diff (2 named + 2 swept-in breaker files) must stay fallback-eligible, or every hourly run with a same-job breaker change repeats the BRO-2795 regression');
});
