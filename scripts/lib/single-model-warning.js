/**
 * Warns operators of score-reviews-calibrated.js that single-model (Claude-only)
 * llmScore output has no ensembleData and will be silently rejected by
 * rebuild-all-reviews.js (scripts/lib/rebuild-helpers.js P1/P4: `inc('blockedSingleModel')`
 * whenever `data.ensembleData` is missing) instead of landing in reviews.json.
 * BRO-929.
 */

const SINGLE_MODEL_WARNING = [
  '⚠️  Single-model scoring warning:',
  '   This script calls Claude only and writes review.llmScore with no ensembleData.',
  '   rebuild-all-reviews.js requires ensembleData for confidence above "low" and will',
  '   silently reject these scores (tracked as stats.blockedSingleModel) — they will',
  '   NOT appear in reviews.json until re-scored with ensemble data.',
  '   Fix: re-run with --ensemble to delegate to the multi-model ensemble pipeline',
  '   (scripts/llm-scoring/index.ts --ensemble / npm run llm:ensemble) instead.',
].join('\n');

function buildSingleModelWarning() {
  return SINGLE_MODEL_WARNING;
}

function buildEnsembleDelegationArgs({ showFilter, limit, dryRun } = {}) {
  const args = ['ts-node', '--project', 'scripts/tsconfig.json', 'scripts/llm-scoring/index.ts', '--ensemble'];
  if (showFilter) args.push(`--show=${showFilter}`);
  if (limit) args.push(`--limit=${limit}`);
  if (dryRun) args.push('--dry-run');
  return args;
}

module.exports = { buildSingleModelWarning, buildEnsembleDelegationArgs, SINGLE_MODEL_WARNING };
