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
  CLAUDE_SONNET: 'claude-sonnet-4-6',
  CLAUDE_HAIKU: 'claude-haiku-4-5-20251001',
  CLAUDE_OPUS: 'claude-opus-4-7',
  GPT4O: 'gpt-4o',
  GPT4O_MINI: 'gpt-4o-mini',
  KIMI: 'moonshotai/kimi-k2.5',
};
