'use strict';

/**
 * Shared predicate for the "fail-closed CI step" invariant introduced by
 * BRO-2906 (tests/unit/workflow-audit-steps-always.test.mjs) and reused by
 * BRO-3127 (tests/unit/rebuild-publish-fail-closed.test.mjs).
 *
 * A CI step with no `if:` defaults to `if: success()`, so ANY earlier
 * failure in its job silently SKIPS it. Checking merely that a condition
 * string CONTAINS `always()` is not enough — `always() && false`,
 * `always() && steps.x.outcome != 'failure'` (true when x is SKIPPED, not
 * just when it failed) and `always() && (… || true)` all contain it while
 * reopening the hole. Extracted so both call sites enforce the identical,
 * previously-incident-tested rule rather than each growing its own
 * (potentially weaker) regex — see BRO-3127 plan review, code-design pass.
 */
const ACCEPTED_CONDITIONS = [
  /^always\(\)$/,
  /^always\(\)\s*&&\s*steps\.[A-Za-z0-9_-]+\.outcome\s*==\s*'success'$/,
  // BRO-3127: a step may ALSO need to check a prior step's OUTPUT (not just
  // its outcome) before it's safe to run — e.g. "the staleness guard failed,
  // but only in the scoped, known-safe-to-publish-around way, not an
  // unexplained crash." Still an exact shape (no `||`, no `!=`, both already
  // rejected above) rather than a free-form expression.
  /^always\(\)\s*&&\s*steps\.[A-Za-z0-9_-]+\.outcome\s*==\s*'success'\s*&&\s*steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+\s*==\s*'true'$/,
];

function conditionIsFailClosed(cond) {
  const c = String(cond || '').trim();
  if (/\|\|/.test(c)) return false; // an OR can always be made true
  if (/!=/.test(c)) return false; // != 'failure' is true when the step is SKIPPED
  return ACCEPTED_CONDITIONS.some((re) => re.test(c));
}

module.exports = { ACCEPTED_CONDITIONS, conditionIsFailClosed };
