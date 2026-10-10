/**
 * push-ledger-store.js — reads/writes the push ledger on a DEDICATED branch
 * (`push-ledger`) instead of committing it to the payload branch (2026-08-02
 * commit-churn fix, Notion 3b0637c5). The previous design appended
 * data/audit/recent-pushes.jsonl to main itself: one "record push ledger
 * entry [skip ci]" commit per successful push — measured 861-1,239
 * commits/day (~41% of ALL main commits), feeding the exact push contention
 * the ledger exists to detect, plus merge storms, test.yml cancel-cascades,
 * and slow session pulls.
 *
 * Design:
 *  - The ledger is a single file (`recent-pushes.jsonl`) at the ROOT of the
 *    `push-ledger` branch's tree (not under data/audit/ — the branch holds
 *    nothing else, so no need to mirror the repo layout).
 *  - Every write REPLACES the branch with a fresh PARENTLESS (root) commit
 *    built via plumbing (hash-object → mktree → commit-tree) and pushed with
 *    `--force-with-lease=refs/heads/push-ledger:<expected-tip>` as a
 *    compare-and-swap. The branch history is therefore always exactly ONE
 *    commit: no growth, no rotation cron, and a bare `git fetch` in local
 *    sessions picks up a single tiny ref. Concurrent writers race on the
 *    lease — the loser's push is rejected server-side and the caller
 *    re-reads and retries. An empty expected tip means "the ref must not
 *    exist yet" (first-ever write), which git's lease syntax expresses as a
 *    trailing colon with no value.
 *  - NOTHING here touches HEAD, the index, or the working tree of the
 *    invoking checkout. The old in-checkout commit dance needed a --mixed
 *    resync, a scoped unwind helper, and a lint rule (#687) to avoid
 *    phantom-staged reverts of concurrent commits; that entire hazard class
 *    is structurally impossible with object-database-only plumbing.
 *
 * All operations run against the repo at `cwd`'s `origin` remote, so test
 * fixtures with a local bare origin exercise the real code path without
 * ever touching the production remote (the old REPO_ROOT-anchored version
 * leaked fixture ledger commits onto the real origin/main whenever the
 * push-with-retry integration tests ran).
 *
 * GENERALIZED (task: push-retry-failure telemetry, 2026-08-23, /plan-review'd
 * — six independent reviewers) to accept an optional `{branch, file}` pair so
 * a second dedicated single-commit branch (`push-retry-failures`) can reuse
 * this exact CAS primitive instead of duplicating it. Named-args, not
 * positional strings (Codex-lens plan-review finding: two adjacent string
 * params invite an accidental swap that fails silently — wrong branch/file,
 * no type error). Defaults are the original `push-ledger`/`recent-
 * pushes.jsonl` pair, so every existing caller (record-push-ledger.js,
 * check-push-ledger.js) needs zero changes.
 */
'use strict';

const { execFileSync } = require('child_process');

const LEDGER_BRANCH = 'push-ledger';
const LEDGER_FILE = 'recent-pushes.jsonl';

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20000, ...opts });
}

/**
 * Fetch the ledger branch and return { tip, content, fetchFailed }.
 * tip = '' when the branch doesn't exist on origin yet. fetchFailed
 * distinguishes a genuinely-absent branch (git's "couldn't find remote
 * ref", normal before the first-ever write) from a network/auth/timeout
 * failure — the CHECKER must treat the latter as an error, not "no ledger"
 * (ship-check adversarial finding: conflating them turns an outage into a
 * silent green no-op on the sole delayed revert-detection arm). The
 * RECORDER can ignore the flag: its subsequent CAS write fails the lease
 * on stale state and retries, so a transient fetch error never corrupts.
 *
 * @param {string} cwd
 * @param {{branch?: string, file?: string}} [opts]
 */
function readLedger(cwd, { branch = LEDGER_BRANCH, file = LEDGER_FILE } = {}) {
  let tip = '';
  let fetchFailed = false;
  try {
    git(cwd, ['fetch', '--quiet', '--no-tags', 'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 15000 });
    try {
      tip = git(cwd, ['rev-parse', `refs/remotes/origin/${branch}`]).trim();
    } catch {
      tip = ''; // fetch ok but ref unresolvable — treat as absent
    }
  } catch (err) {
    const msg = String((err && err.stderr) || (err && err.message) || '');
    if (!/couldn'?t find remote ref/i.test(msg)) fetchFailed = true;
    tip = '';
  }
  let content = '';
  if (tip) {
    try {
      content = git(cwd, ['show', `${tip}:${file}`]);
    } catch {
      content = ''; // tree missing the file — treat as empty ledger
    }
  }
  return { tip, content, fetchFailed };
}

/**
 * Replace the ledger branch with a single root commit containing `content`,
 * iff origin's tip still equals `expectedTip` (CAS). Throws on lease
 * rejection or any git failure — callers own the retry loop.
 *
 * @param {string} cwd
 * @param {string} content
 * @param {string} expectedTip
 * @param {{branch?: string, file?: string}} [opts]
 */
function writeLedger(cwd, content, expectedTip, { branch = LEDGER_BRANCH, file = LEDGER_FILE } = {}) {
  const blob = git(cwd, ['hash-object', '-w', '--stdin'], { input: content }).trim();
  const tree = git(cwd, ['mktree'], { input: `100644 blob ${blob}\t${file}\n` }).trim();
  // Explicit ident: commit-tree must work on runners/machines with no git
  // identity configured (the old `git commit` path silently depended on the
  // caller's config).
  const identEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'push-ledger', GIT_AUTHOR_EMAIL: 'push-ledger@ci',
    GIT_COMMITTER_NAME: 'push-ledger', GIT_COMMITTER_EMAIL: 'push-ledger@ci',
  };
  const commit = git(cwd, ['commit-tree', tree, '-m', `${branch} state (single-commit branch, replaced on every write)`],
    { env: identEnv }).trim();
  git(cwd, ['push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`,
    `--force-with-lease=refs/heads/${branch}:${expectedTip || ''}`], { timeout: 25000 });
  return commit;
}

module.exports = { readLedger, writeLedger, LEDGER_BRANCH, LEDGER_FILE };
