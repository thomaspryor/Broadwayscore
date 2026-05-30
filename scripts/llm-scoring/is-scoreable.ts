/**
 * Shared scoreability check for review-text files.
 *
 * Delegates to scripts/lib/review-guards.js#isIncludableForRebuild for the
 * canonical inclusion gate, then layers two LLM-only extras that exist
 * because the LLM scores from text content while rebuild can fall back to
 * aggregator stars or pre-existing originalScore.
 *
 * Why delegate: pre-2026-04-29 these two predicates diverged on 14 flag
 * checks (Codex audit, Notion 34f637c5-416f-810d). LLM was more permissive
 * than rebuild on 10 of them — wasting credits on files rebuild excludes.
 * LLM was more restrictive than rebuild on 2 — orphan-unscored bug
 * (Lost Boys 2026-04-26 #8: humans cleared wrongProduction, rebuild
 * included the file, LLM still skipped it). Delegating to the canonical
 * helper closes both classes in one move.
 *
 * Parity baseline before/after lives in
 * data/audit/llm-scoring-parity-baseline.json (run
 * scripts/audit-llm-scoring-parity.js to regenerate).
 */

const { hasExcerpt: hasAnyExcerpt } = require('../lib/excerpt-fields');
const { isIncludableForRebuild } = require('../lib/review-guards');

export function isScoreable(data: Record<string, any>, show?: Record<string, any>, filePath?: string): boolean {
  if (!isIncludableForRebuild(data, show, filePath)) return false;

  // LLM-only extras — files rebuild includes (because aggregator/originalScore
  // signal exists) but LLM cannot score (because LLM scores from text):
  //   scraper_garbage: fullText is non-empty enough to pass rebuild's content
  //     gate but is scraper noise; LLM scoring it is meaningless.
  //   showNotMentioned without excerpt: the show isn't named in the text;
  //     no anchor for LLM to score against.
  //
  // NOTE: do NOT add a "no-star outlet" exclusion here. An outlet that publishes
  // no star rating still publishes review TEXT, and the LLM ensemble scores text
  // into `assignedScore` (a composite) — it never fabricates an `originalScore`
  // (the raw published star). The real invariant ("no-star outlets must not carry
  // an originalScore") is enforced independently by check-score-integrity.js.
  // A NO_STAR_OUTLETS gate here instead silently blocked ALL scoring for such
  // outlets, orphaning real reviews unscored (london-theatre, 5 WE openings,
  // 2026-05-30). This mirror must stay in sync with scripts/lib/is-scoreable.js,
  // which never carried the gate.
  if (data.incompleteReason === 'scraper_garbage') return false;
  if (data.showNotMentioned && !hasAnyExcerpt(data)) return false;

  return true;
}
