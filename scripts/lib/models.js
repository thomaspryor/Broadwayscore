/**
 * Canonical LLM model identifiers — single source of truth.
 *
 * Import this instead of hardcoding model strings. A model retirement
 * becomes a 1-line change here rather than a 50-file sed sweep.
 *
 * DO NOT add versioned evaluation pins here (e.g. claude-sonnet-4-5-20250929,
 * claude-3-5-haiku-20241022). Those are intentionally frozen for eval
 * reproducibility and live inline in scripts/llm-scoring/.
 */
module.exports = {
  GEMINI_FLASH: 'gemini-2.5-flash',
  // General-purpose aliases for DIRECT Messages-API callers (~38 scripts).
  // Pinned to the 4.x generation on purpose (ship-check 2026-10-01): the 5.5
  // models reject `temperature` (400), think by default, and return a thinking
  // block first, so `content[0].text` reads come back empty. Those callers
  // (content-verifier, classify-non-reviews, clear-stale-*-flags, scrape-*,
  // update-commercial-data, ...) have to be migrated one by one (drop sampling
  // params, read the first `text` block) before these move. NEVER use these for
  // review scoring either (SCORING_* below).
  CLAUDE_SONNET: 'claude-sonnet-4-6',
  CLAUDE_HAIKU: 'claude-haiku-4-5-20251001',
  CLAUDE_OPUS: 'claude-opus-4-7',
  // Headless `claude` CLI dispatch (autonomous-budget.js, bsc-next-model.js):
  // the CLI owns thinking and sampling, so the current generation is safe here
  // and 2-2.5x cheaper per token than the 4.x pair above.
  DISPATCH_SONNET: 'claude-sonnet-5-5',
  DISPATCH_OPUS: 'claude-opus-5-5',
  // Review-SCORING pins (CLAUDE.md §13): changing the scoring model shifts
  // scores corpus-wide, so these move only after the A/B gate passes. Every
  // call site that scores reviews uses these, never CLAUDE_SONNET/CLAUDE_OPUS
  // (tests/unit/model-table-single-source.test.mjs enforces).
  SCORING_SONNET: 'claude-sonnet-4-6',
  SCORING_OPUS: 'claude-opus-4-7', // video-reviews/score-video-reviews.js
  GPT4O: 'gpt-4o',
  GPT4O_MINI: 'gpt-4o-mini',
  // Cheaper gpt-4o candidate evaluated in task #504 (2026-07-26) — API id
  // confirmed live via GET /v1/models. NOT the ensemble default: its A/B
  // (n=24 real reviews) failed the rule-13 gate (Mixed bucket 29%->0%, max
  // shift 29.2pp). Wired for --openai-model= re-testing after prompt tuning.
  // Requires max_completion_tokens (not max_tokens) in chat completion calls.
  GPT54_MINI: 'gpt-5.4-mini',
  KIMI: 'moonshotai/kimi-k2.5',
};
