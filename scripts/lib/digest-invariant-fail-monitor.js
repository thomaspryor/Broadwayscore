'use strict';

/**
 * Digest invariant FAIL monitor (task #1648) — decision logic.
 *
 * Card #1641 turned scripts/send-morning-digest.js's content-invariant check
 * (scripts/lib/digest-content-invariants.js) from a bare console.error WARN
 * into `process.exitCode = 1` on violation — but nothing consumed that exit
 * code (the launchd job has no failure semantics, and no CI/script reads it),
 * so a future violation would be exactly as invisible as the WARN it
 * replaced. send-morning-digest.js now appends a JSONL record to
 * data/audit/digest-invariant-fail-ledger.jsonl every time
 * assertDigestInvariants() reports a violation; this surfaces that ledger as
 * a health-check row so tomorrow's digest carries the FAIL forward as a
 * health.errors line instead of a swallowed stderr log nobody reads.
 *
 * Follows the same ABSENT-VS-EMPTY contract (BRO-231 / task #1221) as the
 * sibling push-retry-deadman.js: callers MUST pass `null` (never `[]`) when
 * the ledger could not be read (health-check.js's readJsonlLedgerOrNull()
 * already does this), so this function can tell "no local telemetry visible"
 * from "ledger present, genuinely clean" instead of reporting a vacuous pass
 * for both.
 *
 * The digest itself always sends regardless of invariant violations (the
 * "digest must always send" rule) — this row is purely a downstream visible
 * consequence of a FAIL, not a gate on anything.
 */

const WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days — survives a missed/late run without going stale-forever
const NAME = 'Digest: content-invariant check';

/**
 * @param {Array<object>|null} entries - parsed JSONL rows from
 *   data/audit/digest-invariant-fail-ledger.jsonl, or null if the ledger
 *   could not be read in this environment (absent, not empty).
 * @param {{now?: number}} [opts]
 */
function assessDigestInvariantFailRow(entries, opts = {}) {
  const now = opts.now || Date.now();

  if (!Array.isArray(entries)) {
    return {
      name: NAME,
      status: 'warn',
      message: 'Cannot measure digest content-invariant failures from this environment — data/audit/digest-invariant-fail-ledger.jsonl is gitignored, per-machine, and absent here. This row cannot judge digest-content health from here.',
      hint: 'Run `node scripts/health-check.js` on the machine where scripts/send-morning-digest.js actually runs (the launchd host) so a FAIL becomes visible where the digest is generated.',
    };
  }

  const cutoff = now - WINDOW_MS;
  const recent = entries.filter((r) => {
    const ts = Date.parse(r && r.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });

  if (recent.length === 0) {
    return { name: NAME, status: 'pass', message: 'No digest content-invariant FAILs in the trailing 3d' };
  }

  const latest = recent[recent.length - 1];
  const violations = Array.isArray(latest.violations) && latest.violations.length
    ? latest.violations.join('; ')
    : 'unspecified violation(s)';

  return {
    name: NAME,
    status: 'error',
    message: `${recent.length} digest content-invariant FAIL(s) in the last 3d. Most recent (${latest.ts}): ${violations}`,
    hint: 'assertDigestInvariants() rejected the composed digest HTML — a forbidden section reappeared or another invariant broke. The digest still sent (it always does); check scripts/lib/digest-content-invariants.js against the composed HTML in data/audit/morning-digest-preview.html (--dry-run) to reproduce.',
  };
}

module.exports = { assessDigestInvariantFailRow, NAME, WINDOW_MS };
