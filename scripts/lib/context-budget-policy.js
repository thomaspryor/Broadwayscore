/**
 * context-budget-policy.js — pure tier-decision spec for ~/.claude/hooks/
 * context-budget-nudge.sh (card #1419). That hook is a POSIX shell script in
 * a SEPARATE repo (synced via claude-sync, not this worktree) firing on every
 * UserPromptSubmit — a hot path. A design review for this card found no
 * precedent anywhere in this codebase for shelling `node -e` into a per-turn
 * hook (the one existing case, session-start.sh, fires once per SessionStart,
 * not per prompt) and flagged it P0: the wrong layer for this decision, and
 * the opposite of the hook's own cost-containment purpose. So this module is
 * NOT called by the hook at runtime — the hook keeps its own bash threshold
 * ladder (same accepted tested-for-parity duplication as this file's sibling
 * scripts/lib/linear-cap-policy.js's WARN_THRESHOLD constant vs its callers).
 * This module is the canonical, unit-tested SPEC those bash thresholds must
 * match — the constants below are literal copies of context-budget-nudge.sh's
 * WARN_TOKENS/HANDOFF_TOKENS defaults and 70/50/80 percent thresholds; keep
 * them in sync by hand if either side changes.
 *
 * classifyBudgetTier only takes signals the hook actually persists today
 * (~/.claude/state/statusline/<session_id>.json: {pct, usedTokens, model}) —
 * mid-turn/selected/auto-dispatched/task-id/succession-depth/thrash-guard
 * state stay exactly where they already live in the bash hook (they have no
 * data path into this module and a prior draft of this card's plan wrongly
 * assumed they did; a codebase-grounded review caught that).
 */

'use strict';

const WARN_TOKENS = 180000;
// NEW tier (card #1419): a session sitting on this much absolute context is
// past the point where "compact at the next natural boundary" (the existing
// WARN_TOKENS advice) is still cheap advice — every further turn re-reads it
// all as cache-read. 200000 was the measured line in the 2026-08-13 spend
// investigation: 86% of a 3-day $5,831 window fired above it.
const COMPACT_NOW_TOKENS = 200000;
const HANDOFF_TOKENS = 500000;
const WARN_PCT = 70;
const FABLE_WARN_PCT = 50;
const HANDOFF_PCT = 80;

const TIERS = Object.freeze({
  NONE: 'none',
  ADVISE_COMPACT: 'advise-compact',
  ADVISE_COMPACT_NOW: 'advise-compact-now',
  ADVISE_HANDOFF_ELIGIBLE: 'advise-handoff-eligible',
});

// Mirrors context-budget-nudge.sh lines ~83-101 (the "over" check) and
// ~135-142 (the "handoff_eligible" check) exactly: both axes are OR'd
// together, not AND'd — either absolute tokens or relative pct alone is
// enough to trip a tier, since a small context_window makes pct the only
// usable signal for that session (the hook's v3 comment on why both axes
// exist).
function classifyBudgetTier({ usedTokens = null, pct = null, isFable = false } = {}) {
  const warnThreshold = isFable ? FABLE_WARN_PCT : WARN_PCT;
  const over =
    (pct !== null && pct !== undefined && pct >= warnThreshold) ||
    (usedTokens !== null && usedTokens !== undefined && usedTokens >= WARN_TOKENS);
  if (!over) return TIERS.NONE;

  const handoffEligible =
    (pct !== null && pct !== undefined && pct >= HANDOFF_PCT) ||
    (usedTokens !== null && usedTokens !== undefined && usedTokens >= HANDOFF_TOKENS);
  if (handoffEligible) return TIERS.ADVISE_HANDOFF_ELIGIBLE;

  if (usedTokens !== null && usedTokens !== undefined && usedTokens >= COMPACT_NOW_TOKENS) {
    return TIERS.ADVISE_COMPACT_NOW;
  }

  return TIERS.ADVISE_COMPACT;
}

module.exports = {
  WARN_TOKENS,
  COMPACT_NOW_TOKENS,
  HANDOFF_TOKENS,
  WARN_PCT,
  FABLE_WARN_PCT,
  HANDOFF_PCT,
  TIERS,
  classifyBudgetTier,
};
