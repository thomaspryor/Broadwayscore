/**
 * Per-model LLM cost coefficients + estimateCost helper.
 *
 * Extracted from scripts/llm-scoring/index.ts:1516-1536 (end-of-run cost
 * print) so callers can compute per-call cost during the run — needed for
 * the `--max-cost=N` budget circuit (Phase B-WE W1-T5).
 *
 * Coefficients are $ per 1M tokens, matching the Anthropic / OpenAI /
 * Google / OpenRouter public pricing as of 2026-05-17. Update here only;
 * index.ts end-of-run print and any in-flight budget checker both call
 * estimateCost() so they stay in lockstep.
 */

export interface ModelUsage {
  input: number;
  output: number;
  /**
   * Anthropic prompt-cache tokens (claude leg only today). With cache_control
   * on, usage.input_tokens EXCLUDES cached tokens — so these must be priced
   * separately or --max-cost and the end-of-run print undercount.
   * Writes bill at 1.25x input price, reads at 0.1x (5-min ephemeral TTL).
   */
  cacheWrite?: number;
  cacheRead?: number;
}

/** Anthropic prompt-cache pricing multipliers vs base input price. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export interface AllModelUsage {
  claude?: ModelUsage;
  openai?: ModelUsage;
  gemini?: ModelUsage;
  kimi?: ModelUsage;
}

/**
 * Per-1M-token prices in USD. Keys must match AllModelUsage keys.
 */
export const COST_PER_MILLION_TOKENS = {
  // Claude — Sonnet 4 (default) and Haiku 3.5 (single-model fallback path).
  // model name routing matches the inline logic at index.ts L1516.
  'claude-sonnet': { input: 3.00, output: 15.00 },
  'claude-haiku':  { input: 0.80, output: 4.00 },
  // OpenAI — gpt-4o. This is the ENSEMBLE DEFAULT (see ensemble-scorer.ts) —
  // removed from OpenAI's current pricing page but still the live/served model.
  openai: { input: 2.50, output: 10.00 },
  // OpenAI — gpt-5.4-mini. Evaluated as a cheaper replacement in task #504
  // (2026-07-26) — ~70% cheaper than gpt-4o — but its real A/B (n=24 reviews)
  // failed the rule-13 bucket-shift gate, so it is NOT the ensemble default.
  // Kept priced here so --openai-model= re-tests don't silently mis-cost.
  // Cached input billed separately at $0.075/M, not modeled here.
  'openai-gpt54-mini': { input: 0.75, output: 4.50 },
  // Gemini — 2.5-flash: $0.30 in / $2.50 out (verified against Google's
  // published pricing 2026-07-26; the previous 1.25/5.00 were 2.5-PRO
  // prices and overstated the gemini leg ~4x in estimates).
  gemini: { input: 0.30, output: 2.50 },
  // Kimi K2.5 via OpenRouter — approximate.
  kimi: { input: 1.50, output: 5.00 },
} as const;

/**
 * Batch-mode discount (task #505). Anthropic Message Batches, OpenAI
 * Batches, and Gemini batch mode all publish a flat 50% discount off the
 * synchronous per-token rate (verified against each vendor's pricing page
 * 2026-07-26). Kimi/OpenRouter has no batch tier — always billed at the
 * sync rate regardless of `opts.batch`.
 *
 * Applied uniformly to the whole per-vendor cost (base tokens + Anthropic
 * cache tokens) rather than re-deriving a separate cache-write/cache-read
 * batch rate — Anthropic doesn't publish a distinct batch+cache combined
 * rate, so this is a reasonable approximation for cost *reporting*; it does
 * not gate any billing enforcement.
 */
export const BATCH_DISCOUNT_MULTIPLIER = 0.5;

/**
 * Pick the OpenAI pricing row for a given configured model name. Defaults to
 * legacy gpt-4o pricing so existing callers that don't pass the option keep
 * their current (correct) cost until they thread the model name through.
 */
function openaiPricing(modelName?: string) {
  return (modelName || '').includes('gpt-5.4-mini')
    ? COST_PER_MILLION_TOKENS['openai-gpt54-mini']
    : COST_PER_MILLION_TOKENS.openai;
}

/**
 * Estimate cost in USD given cumulative or per-call token usage.
 *
 * @param usage Per-model token counts. Missing models cost 0.
 * @param opts.claudeModelName Used to pick claude-sonnet vs claude-haiku
 *        pricing. Defaults to sonnet pricing (matches existing
 *        `options.model.includes('haiku')` check at index.ts L1516).
 * @param opts.openaiModelName Used to pick gpt-4o vs gpt-5.4-mini pricing.
 *        Defaults to gpt-4o (legacy) pricing when omitted.
 * @param opts.batch When true, apply BATCH_DISCOUNT_MULTIPLIER to the
 *        claude/openai/gemini legs (not kimi — no batch tier).
 */
export function estimateCost(
  usage: AllModelUsage,
  opts: { claudeModelName?: string; openaiModelName?: string; batch?: boolean } = {}
): number {
  const claudePricing = (opts.claudeModelName || '').toLowerCase().includes('haiku')
    ? COST_PER_MILLION_TOKENS['claude-haiku']
    : COST_PER_MILLION_TOKENS['claude-sonnet'];
  const openaiPrice = openaiPricing(opts.openaiModelName);
  const discount = opts.batch ? BATCH_DISCOUNT_MULTIPLIER : 1;

  let total = 0;
  if (usage.claude) {
    let claudeTotal = (usage.claude.input / 1_000_000) * claudePricing.input;
    claudeTotal += (usage.claude.output / 1_000_000) * claudePricing.output;
    claudeTotal += ((usage.claude.cacheWrite || 0) / 1_000_000) * claudePricing.input * CACHE_WRITE_MULTIPLIER;
    claudeTotal += ((usage.claude.cacheRead || 0) / 1_000_000) * claudePricing.input * CACHE_READ_MULTIPLIER;
    total += claudeTotal * discount;
  }
  if (usage.openai) {
    let openaiTotal = (usage.openai.input / 1_000_000) * openaiPrice.input;
    openaiTotal += (usage.openai.output / 1_000_000) * openaiPrice.output;
    total += openaiTotal * discount;
  }
  if (usage.gemini) {
    let geminiTotal = (usage.gemini.input / 1_000_000) * COST_PER_MILLION_TOKENS.gemini.input;
    geminiTotal += (usage.gemini.output / 1_000_000) * COST_PER_MILLION_TOKENS.gemini.output;
    total += geminiTotal * discount;
  }
  if (usage.kimi) {
    total += (usage.kimi.input / 1_000_000) * COST_PER_MILLION_TOKENS.kimi.input;
    total += (usage.kimi.output / 1_000_000) * COST_PER_MILLION_TOKENS.kimi.output;
  }
  return total;
}

/**
 * Per-model cost breakdown (for the end-of-run print, matches the existing
 * cost-line format).
 *
 * @param opts.openaiModelName See estimateCost — selects gpt-4o vs
 *        gpt-5.4-mini pricing for the openai leg.
 * @param opts.batch See estimateCost — applies BATCH_DISCOUNT_MULTIPLIER to
 *        claude/openai/gemini.
 */
export function costBreakdown(
  usage: AllModelUsage,
  opts: { claudeModelName?: string; openaiModelName?: string; batch?: boolean } = {}
): { claude: number; openai: number; gemini: number; kimi: number; total: number } {
  const claudePricing = (opts.claudeModelName || '').toLowerCase().includes('haiku')
    ? COST_PER_MILLION_TOKENS['claude-haiku']
    : COST_PER_MILLION_TOKENS['claude-sonnet'];
  const openaiPrice = openaiPricing(opts.openaiModelName);
  const discount = opts.batch ? BATCH_DISCOUNT_MULTIPLIER : 1;

  const claude = usage.claude
    ? ((usage.claude.input / 1_000_000) * claudePricing.input +
      (usage.claude.output / 1_000_000) * claudePricing.output +
      ((usage.claude.cacheWrite || 0) / 1_000_000) * claudePricing.input * CACHE_WRITE_MULTIPLIER +
      ((usage.claude.cacheRead || 0) / 1_000_000) * claudePricing.input * CACHE_READ_MULTIPLIER) * discount
    : 0;
  const openai = usage.openai
    ? ((usage.openai.input / 1_000_000) * openaiPrice.input +
      (usage.openai.output / 1_000_000) * openaiPrice.output) * discount
    : 0;
  const gemini = usage.gemini
    ? ((usage.gemini.input / 1_000_000) * COST_PER_MILLION_TOKENS.gemini.input +
      (usage.gemini.output / 1_000_000) * COST_PER_MILLION_TOKENS.gemini.output) * discount
    : 0;
  const kimi = usage.kimi
    ? (usage.kimi.input / 1_000_000) * COST_PER_MILLION_TOKENS.kimi.input +
      (usage.kimi.output / 1_000_000) * COST_PER_MILLION_TOKENS.kimi.output
    : 0;
  return { claude, openai, gemini, kimi, total: claude + openai + gemini + kimi };
}
