/**
 * Canonical LLM model identifiers — single source of truth.
 *
 * Import this instead of hardcoding model strings. A model retirement
 * becomes a 1-line change here rather than a 50-file sed sweep.
 *
 * Do not pin a retired or retiring Claude id anywhere, including
 * scripts/llm-scoring/ (scripts/tests/no-retired-claude-pins.test.mjs, BRO-7510).
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
  // Caller-group pins (BRO-4497). claude-sonnet-4-5 shuts down 2026-11-30 and
  // claude-3-5-sonnet is already retired (BRO-7527), so these moved to 4.6 with the
  // same request shape (temperature accepted, no default
  // thinking block), so no caller params change. Moving to 5.x needs the
  // param/response-shape work described on CLAUDE_SONNET above.
  COPY_SONNET: 'claude-sonnet-4-6',
  ADJUDICATE_SONNET: 'claude-sonnet-4-6',
  EXTRACTION_SONNET: 'claude-sonnet-4-6',
  COPY_FALLBACK_SONNET: 'claude-sonnet-4-6',
  REDDIT_SONNET: 'claude-sonnet-5-5',
  WALKTHROUGH_SONNET: 'claude-sonnet-5',
  TRIAGE_SONNET: 'claude-sonnet-5',
  // BRO-7527 per-job Haiku pins. Each job moves from CLAUDE_HAIKU (4.5) to Haiku 5.5
  // only after its own old-vs-new spot check (scripts/evals/haiku-swap-spotcheck.js,
  // results in data/audit/haiku-swap-spotcheck-2026-11.json). Callers build the
  // request with scripts/lib/anthropic-request.js so the 5.5 shape (no temperature,
  // thinking off, text-block read) is applied by the pin value alone. Rollback = the line.
  // 2026-11-15 check: both jobs FAILED (verifier agreed with 4.5 on 75% vs 97% run-to-run;
  // titles kept 78-80% of 4.5's flags), so both stay on 4.5. Re-run the script before any flip.
  CLAUDE_HAIKU_5: 'claude-haiku-5-5',
  VERIFIER_HAIKU: 'claude-haiku-4-5-20251001', // lib/content-verifier.js primary provider
  VIDEO_TITLES_HAIKU: 'claude-haiku-4-5-20251001', // video-reviews/pre-classify-titles.js
  // Review-SCORING pins (CLAUDE.md §13): changing the scoring model shifts
  // scores corpus-wide, so these move only after the A/B gate passes. Every
  // call site that scores reviews uses these, never CLAUDE_SONNET/CLAUDE_OPUS
  // (tests/unit/model-table-single-source.test.mjs enforces).
  // BRO-7537: flipped 4.6 -> 5.5 after the BRO-7529 A/B passed every §13 gate
  // (data/audit/scoring-ab-2026-11-cheaper-legs.json). Rollback = this line.
  SCORING_SONNET: 'claude-sonnet-5-5',
  SCORING_OPUS: 'claude-opus-4-7', // video-reviews/score-video-reviews.js
  // GPT4O / GPT4O_MINI: legacy key names for the general OpenAI utility callers
  // (classifiers, extractors, audits). gpt-4o and gpt-4o-mini shut down 2027-01-14
  // (research-cost.js MODEL_SHUTDOWNS), so BRO-7341 moved both to gpt-5.6-luna (live
  // check 2026-11-20: text, json_object, vision, 10-token answers). luna rejects
  // max_tokens, so every caller builds its body with llm-batch.js openaiChatBody.
  GPT4O: 'gpt-5.6-luna',
  // Review-SCORING OpenAI pins (same rule as SCORING_SONNET above): the
  // ensemble's OpenAI leg (ensemble-scorer.ts, index.ts) and the comparative
  // within-band rescore. Each moves only after its own A/B (CLAUDE.md §13);
  // the leg is the ONLY thing that changes, so flip and rollback are one line.
  // OpenAI retires gpt-4o on 2027-01-14 (owner email 2026-10-14). The request
  // shape per model lives in scripts/lib/llm-batch.js OPENAI_REQUEST_PROFILES.
  // BRO-7537: flipped gpt-4o -> gpt-5.6-luna (same BRO-7529 A/B audit file).
  SCORING_OPENAI: 'gpt-5.6-luna',
  // BRO-7873: owner-reply judge for the visual push gate (owner-reply-judge.mjs). Its own pin so a scoring A/B flip
  // never silently changes what the push gate asks a model. Needs a profile in llm-batch.js OPENAI_REQUEST_PROFILES.
  OWNER_REPLY_OPENAI: 'gpt-5.6-luna',
  // BRO-7341: flipped gpt-4o -> gpt-5.6-luna after its own rule-13 A/B passed
  // (data/audit/comparative-openai-ab-2026-11.json: 26 reviews, mean drift 0.00,
  // bucket shift 0pp). Rollback = this line, only until gpt-4o shuts down 2027-01-14.
  COMPARATIVE_OPENAI: 'gpt-5.6-luna',
  GPT4O_MINI: 'gpt-5.6-luna',
  // Cheaper gpt-4o candidate evaluated in task #504 (2026-07-26) — API id
  // confirmed live via GET /v1/models. NOT the ensemble default: its A/B
  // (n=24 real reviews) failed the rule-13 gate (Mixed bucket 29%->0%, max
  // shift 29.2pp). Wired for --openai-model= re-testing after prompt tuning.
  // Requires max_completion_tokens (not max_tokens) in chat completion calls.
  GPT54_MINI: 'gpt-5.4-mini',
  // Social score posts (BRO-6959): Claude writes from the fact pool, GPT-5.5 fact-checks it.
  SOCIAL_WRITER: 'claude-opus-5-5',
  GPT55: 'gpt-5.5',
  // Web-grounded OpenAI checker in the Gemini+OpenAI audit scripts
  // (dual-model-client, audit-review-crossmodel, fact-check-historical-sample).
  // BRO-7339: gpt-5-mini shuts down 2026-12-11; OpenAI names gpt-5.6-terra as the
  // replacement. 10-show web-lookup bake-off (2026-11-11): terra matched
  // gpt-5-mini's accuracy and answered "unknown" where gpt-5.6-luna made up a
  // date and director, which is the failure an audit checker must not have.
  // Rates for every id here live in research-cost.js RATES (one table).
  AUDIT_OPENAI: 'gpt-5.6-terra',
  // AEO visibility tracker (history.jsonl trend series). Its own pin, so a model
  // change there is a deliberate trend break and never rides along with the audits.
  // luna, not terra: it only counts mentions and tool-returned citations (no
  // fabrication risk to a fact), and terra would take the weekly run from ~$2.5
  // to ~$4.1, close to the $4.50 guard that skips the history write when hit.
  AEO_OPENAI: 'gpt-5.6-luna',
  // Deep-research dispatch choice replacing o3 (shuts down 2026-12-11).
  DEEP_RESEARCH_OPENAI_PRO: 'gpt-5.6-sol',
  KIMI: 'moonshotai/kimi-k2.5',
};
