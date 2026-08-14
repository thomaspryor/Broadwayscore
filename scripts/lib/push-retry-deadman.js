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
 * PERSISTENCE CAVEAT: when a failed push is the ONLY write in a CI job, the
 * log dies with the runner and never reaches origin — so this row is a
 * best-effort backstop (it reliably catches local runs and jobs that land a
 * later push), not a guarantee. The definitive protection remains the fix +
 * the ::error:: annotation.
 *
 * ABSENT-VS-EMPTY (BRO-231 / task #1221): the ledger is gitignored/per-machine
 * — a fresh CI checkout never has it. The original version of this check
 * could not tell "file absent" from "file present with 0 recent failures"
 * and reported PASS for both, which is exactly the vacuous-gate class that
 * let 59 real local push failures render green in the CI-generated morning
 * digest. Callers MUST pass `null` (never `[]`) when the ledger could not be
 * read — health-check.js's readJsonlLedgerOrNull() already establishes this
 * null-means-absent contract for the sibling autofix-canary/throughput rows,
 * and this function follows the same rule.
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
      message: 'Cannot measure push-retry failures from this environment — data/audit/push-retry-failures.jsonl is gitignored, per-machine, and absent here. This row cannot judge push health from here.',
      hint: 'Run `node scripts/health-check.js` on a machine where scripts/lib/push-with-retry.sh actually writes this log (or track the ledger) so push-retry failures become visible where the digest is generated.',
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
  const message =
    `${recent.length} push-retry failure(s) in the last 7d` +
    (noops.length > 0 ? ` including ${noops.length} NO-OP-rebase abort(s) (task-#394 stale-ref signature)` : '') +
    ` across ${branches.join(', ')}. Most recent reason: ${recent[recent.length - 1].reason || '?'}.`;

  return {
    name: NAME,
    status,
    message,
    hint: 'A no-op-rebase abort means refs/remotes/origin/<branch> is stale after fetch (SHA-pinned checkout refspec) — verify scripts/lib/push-with-retry.sh still fetches with an explicit +refs/heads/X:refs/remotes/origin/X destination. Exhaustion means the remote genuinely could not be integrated.',
  };
}

module.exports = { assessPushRetryDeadman, NAME, WINDOW_MS };
