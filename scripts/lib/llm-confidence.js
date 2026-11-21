/**
 * Confidence cap logic for LLM ensemble scoring.
 *
 * Centralized so the test (tests/unit/llm-confidence-cap.test.mjs) can
 * require() the real function instead of copying logic. Per CLAUDE.md §15.
 *
 * Used by scripts/llm-scoring/ensemble-scorer.ts to compute final
 * llmScore.confidence as the LOWER of (model agreement, input quality),
 * with an operator escape hatch via reviewFile.confidenceOverride.
 *
 * Refs: memory/project_doas_opening_night_issues.md issue #14
 */

const RANK = { high: 3, medium: 2, low: 1 };

/**
 * Cap final confidence to the LOWER of ensemble agreement and input quality.
 *
 * The ensemble computes its own confidence from model agreement (e.g. all 3
 * models picked Positive 73 → high). But if the INPUT was a single tiny
 * aggregator excerpt, "high agreement" is not the same as "high confidence
 * in the underlying review."
 *
 * @param {string} ensembleConfidence - Model-agreement confidence ('high'|'medium'|'low')
 * @param {string} inputConfidence - Input quality confidence ('high'|'medium'|'low')
 * @param {string|null} [override] - Operator escape hatch (forces this value)
 * @returns {string} Final capped confidence
 */
function capLlmConfidence(ensembleConfidence, inputConfidence, override) {
  if (override === 'high' || override === 'medium' || override === 'low') {
    return override;
  }
  const ensembleConf = ensembleConfidence || 'medium';
  const inputConf = inputConfidence || 'medium';
  const ensembleRank = RANK[ensembleConf] !== undefined ? RANK[ensembleConf] : 2;
  const inputRank = RANK[inputConf] !== undefined ? RANK[inputConf] : 2;
  return ensembleRank <= inputRank ? ensembleConf : inputConf;
}

module.exports = { capLlmConfidence, CONFIDENCE_RANK: RANK };
