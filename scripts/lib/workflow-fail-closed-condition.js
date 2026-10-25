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


// BRO-3224: the POSITION rule tests/unit/workflow-audit-steps-always.test.mjs
// enforces for test.yml's lint-workflows job, generalised to every job in
// every workflow that adopted the same anchor. A job "adopts" it when 3+
// steps open their condition with `always() && steps.<X>.outcome ==
// 'success'` (or `!cancelled() && ...`, which also survives a failure but not
// a cancel; fetch-tour-schedules.yml uses it) for the same X: the author has declared that the steps after X
// must survive unrelated failures. Fewer than 3 is an incidental condition,
// not a declaration (scrape-dtli-show-score.yml has a one-off).
const ANCHOR_PREFIX = /^\s*(?:\$\{\{\s*)?(?:always\(\)|!\s*cancelled\(\))\s*&&\s*steps\.([A-Za-z0-9_-]+)\.outcome\s*==\s*'success'/;
// success() is NOT a guard: `success() && x` is skipped after an unrelated
// earlier failure exactly like a bare `x` (BRO-5261 retro-review). A step that
// must only run on full success belongs in the test's EXEMPT list instead.
const STATUS_FUNCTION = /\b(?:always|cancelled|failure)\s*\(\s*\)/;
const MIN_ANCHORED_STEPS = 3;

/** Anchor step ids a job has adopted (see above), in step order. */
function anchorIdsOf(job) {
  const counts = new Map();
  for (const step of (job && job.steps) || []) {
    const m = ANCHOR_PREFIX.exec(String(step.if ?? ''));
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  const steps = (job && job.steps) || [];
  return [...counts.entries()]
    .filter(([, n]) => n >= MIN_ANCHORED_STEPS)
    .map(([id]) => id)
    .filter((id) => steps.some((s) => s.id === id))
    .sort((a, b) => steps.findIndex((s) => s.id === a) - steps.findIndex((s) => s.id === b));
}

/**
 * Steps after a job's (earliest) anchor that an unrelated earlier failure
 * would still skip: no `if:` at all, or an `if:` with no status function
 * (GitHub wraps those in an implicit success()). continue-on-error does not
 * help: it only stops the step's OWN failure from failing the job.
 * @returns {{index:number, name:string, if:(string|undefined)}[]}
 */
function findAnchorGaps(job) {
  const [anchorId] = anchorIdsOf(job);
  if (!anchorId) return [];
  const steps = job.steps || [];
  const start = steps.findIndex((s) => s.id === anchorId);
  const gaps = [];
  for (let i = start + 1; i < steps.length; i++) {
    const cond = steps[i].if;
    if (cond === undefined || cond === null || !STATUS_FUNCTION.test(String(cond))) {
      gaps.push({ index: i, name: steps[i].name || steps[i].uses || `(step ${i})`, if: cond });
    }
  }
  return gaps;
}

module.exports = { ACCEPTED_CONDITIONS, conditionIsFailClosed, anchorIdsOf, findAnchorGaps, MIN_ANCHORED_STEPS };
