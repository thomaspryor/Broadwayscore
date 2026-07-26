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
  // OpenAI — gpt-4o (default for ensemble).
  openai: { input: 2.50, output: 10.00 },
  // Gemini — 2.5-flash: $0.30 in / $2.50 out (verified against Google's
  // published pricing 2026-07-26; the previous 1.25/5.00 were 2.5-PRO
  // prices and overstated the gemini leg ~4x in estimates).
  gemini: { input: 0.30, output: 2.50 },
  // Kimi K2.5 via OpenRouter — approximate.
  kimi: { input: 1.50, output: 5.00 },
} as const;

/**
 * Estimate cost in USD given cumulative or per-call token usage.
 *
 * @param usage Per-model token counts. Missing models cost 0.
 * @param opts.claudeModelName Used to pick claude-sonnet vs claude-haiku
 *        pricing. Defaults to sonnet pricing (matches existing
 *        `options.model.includes('haiku')` check at index.ts L1516).
 */
export function estimateCost(
  usage: AllModelUsage,
  opts: { claudeModelName?: string } = {}
): number {
  const claudePricing = (opts.claudeModelName || '').toLowerCase().includes('haiku')
    ? COST_PER_MILLION_TOKENS['claude-haiku']
    : COST_PER_MILLION_TOKENS['claude-sonnet'];

  let total = 0;
  if (usage.claude) {
    total += (usage.claude.input / 1_000_000) * claudePricing.input;
    total += (usage.claude.output / 1_000_000) * claudePricing.output;
    total += ((usage.claude.cacheWrite || 0) / 1_000_000) * claudePricing.input * CACHE_WRITE_MULTIPLIER;
    total += ((usage.claude.cacheRead || 0) / 1_000_000) * claudePricing.input * CACHE_READ_MULTIPLIER;
  }
  if (usage.openai) {
    total += (usage.openai.input / 1_000_000) * COST_PER_MILLION_TOKENS.openai.input;
    total += (usage.openai.output / 1_000_000) * COST_PER_MILLION_TOKENS.openai.output;
  }
  if (usage.gemini) {
    total += (usage.gemini.input / 1_000_000) * COST_PER_MILLION_TOKENS.gemini.input;
    total += (usage.gemini.output / 1_000_000) * COST_PER_MILLION_TOKENS.gemini.output;
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
 */
export function costBreakdown(
  usage: AllModelUsage,
  opts: { claudeModelName?: string } = {}
): { claude: number; openai: number; gemini: number; kimi: number; total: number } {
  const claudePricing = (opts.claudeModelName || '').toLowerCase().includes('haiku')
    ? COST_PER_MILLION_TOKENS['claude-haiku']
    : COST_PER_MILLION_TOKENS['claude-sonnet'];

  const claude = usage.claude
    ? (usage.claude.input / 1_000_000) * claudePricing.input +
      (usage.claude.output / 1_000_000) * claudePricing.output +
      ((usage.claude.cacheWrite || 0) / 1_000_000) * claudePricing.input * CACHE_WRITE_MULTIPLIER +
      ((usage.claude.cacheRead || 0) / 1_000_000) * claudePricing.input * CACHE_READ_MULTIPLIER
    : 0;
  const openai = usage.openai
    ? (usage.openai.input / 1_000_000) * COST_PER_MILLION_TOKENS.openai.input +
      (usage.openai.output / 1_000_000) * COST_PER_MILLION_TOKENS.openai.output
    : 0;
  const gemini = usage.gemini
    ? (usage.gemini.input / 1_000_000) * COST_PER_MILLION_TOKENS.gemini.input +
      (usage.gemini.output / 1_000_000) * COST_PER_MILLION_TOKENS.gemini.output
    : 0;
  const kimi = usage.kimi
    ? (usage.kimi.input / 1_000_000) * COST_PER_MILLION_TOKENS.kimi.input +
      (usage.kimi.output / 1_000_000) * COST_PER_MILLION_TOKENS.kimi.output
    : 0;
  return { claude, openai, gemini, kimi, total: claude + openai + gemini + kimi };
}
