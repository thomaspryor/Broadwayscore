'use strict';

/**
 * Push-retry deadman (task #394) — decision logic.
 *
 * scripts/lib/push-with-retry.sh appends a JSONL record to
 * data/audit/push-retry-failures.jsonl whenever it abandons a push — either a
 * no-op-rebase abort or full retry exhaustion. This surfaces that telemetry so
 * a silent-forever push failure (the exact class that stranded the
 * alert-ledger and killed cooldown/dedup across CI) becomes a visible digest
 * row instead of a swallowed `|| echo ::warning`. Non-paging: it's a digest
 * signal, not a critical self-page — the root-cause fix (explicit-destination
 * fetch) is what actually prevents the failure, and a persisted failure
 * record already means SOME run landed a later commit carrying the log, so
 * the state is recoverable.
 *
 * SOURCE (task: push-retry-failure telemetry, 2026-08-23): originally read
 * the LOCAL data/audit/push-retry-failures.jsonl, which is gitignored and
 * dies with the runner whenever a failed push is the only write in a CI job
 * — this row reported "cannot measure" for months as a result. As of
 * 2026-08-23, health-check.js instead reads a dedicated `push-retry-failures`
 * git branch that scripts/record-push-retry-failure.js writes to
 * SYNCHRONOUSLY (independent of whether the failing push itself ever lands),
 * via scripts/lib/push-ledger-store.js's CAS pattern. The `entries === null`
 * case below now means "the branch fetch genuinely failed this run" (a real
 * network/auth error) — NOT "the branch doesn't exist yet", which readLedger()
 * treats as fetchFailed=false/empty-content (a brand-new branch reads as a
 * clean, empty ledger, not an error) — see readPushRetryFailureLedgerOrNull()
 * in health-check.js and readLedger()'s fetchFailed contract in
 * scripts/lib/push-ledger-store.js.
 *
 * ABSENT-VS-EMPTY (BRO-231 / task #1221): the original version of this check
 * could not tell "ledger unreadable" from "ledger present with 0 recent
 * failures" and reported PASS for both, which is exactly the vacuous-gate
 * class that let 59 real local push failures render green in the
 * CI-generated morning digest. Callers MUST pass `null` (never `[]`) when the
 * ledger could not be read — health-check.js's readJsonlLedgerOrNull() already
 * establishes this null-means-absent contract for the sibling autofix-canary/
 * throughput rows, and this function follows the same rule.
 */

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const NAME = 'Push-retry deadman';

/**
 * @param {Array<object>|null} entries - parsed JSONL rows, or null if the
 *   ledger file could not be read in this environment (absent, not empty).
 * @param {{now?: number}} [opts]
 */
function assessPushRetryDeadman(entries, opts = {}) {
  const now = opts.now || Date.now();

  if (!Array.isArray(entries)) {
    return {
      name: NAME,
      status: 'warn',
      message: 'Cannot measure push-retry failures from this environment — the durable push-retry-failures ledger branch could not be fetched (a real fetch error, not the branch simply not existing yet — see readLedger()\'s fetchFailed contract in scripts/lib/push-ledger-store.js). This row cannot judge push health from here.',
      hint: 'Run `git fetch origin push-retry-failures && git show origin/push-retry-failures:failures.jsonl` to check the branch directly, or re-run `node scripts/health-check.js` from an environment with network access to origin.',
    };
  }

  const cutoff = now - WINDOW_MS;
  const recent = entries.filter((r) => {
    const ts = Date.parse(r && r.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });

  if (recent.length === 0) {
    return { name: NAME, status: 'pass', message: 'No push-retry failures in the trailing 7d' };
  }

  const noops = recent.filter((r) => String(r.reason || '').startsWith('noop-rebase'));
  const branches = [...new Set(recent.map((r) => `${r.remote || '?'}:${r.branch || '?'}`))];
  // A no-op-rebase record is the #394 signature and the more serious signal (a
  // stale-ref regression); 3+ exhaustions in a week is also worth an error row.
  const status = noops.length > 0 || recent.length >= 3 ? 'error' : 'warn';
  // workflow attribution (task #1842): entries written before this field
  // existed have no `workflow` key — group those under 'unknown' rather than
  // 'undefined' or dropping them, so old + new rows both count toward the
  // per-workflow breakdown that makes this row actionable without manual
  // Actions-run-history archaeology.
  const byWorkflow = new Map();
  for (const r of recent) {
    const wf = r.workflow || 'unknown';
    byWorkflow.set(wf, (byWorkflow.get(wf) || 0) + 1);
  }
  const workflowBreakdown = [...byWorkflow.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([wf, n]) => `${wf} x${n}`)
    .join(', ');
  const message =
    `${recent.length} push-retry failure(s) in the last 7d` +
    (noops.length > 0 ? ` including ${noops.length} NO-OP-rebase abort(s) (task-#394 stale-ref signature)` : '') +
    ` across ${branches.join(', ')} [${workflowBreakdown}]. Most recent reason: ${recent[recent.length - 1].reason || '?'}.`;

  return {
    name: NAME,
    status,
    message,
    hint: 'A no-op-rebase abort means refs/remotes/origin/<branch> is stale after fetch (SHA-pinned checkout refspec) — verify scripts/lib/push-with-retry.sh still fetches with an explicit +refs/heads/X:refs/remotes/origin/X destination. Exhaustion means the remote genuinely could not be integrated.',
  };
}

module.exports = { assessPushRetryDeadman, NAME, WINDOW_MS };
