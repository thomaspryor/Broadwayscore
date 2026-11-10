/**
 * Comparative within-band re-scoring pass.
 *
 * Runs AFTER per-review anchored-v6 scoring. For each show, it groups the
 * anchored-v6 reviews by star band and re-scores every group of 2+ reviews
 * TOGETHER, so genuine warmth differences spread instead of all collapsing to
 * the q3≈97 isolation anchor (see scripts/lib/comparative-band.js for the
 * validated rationale, 2026-06-05).
 *
 * Scope: anchored-v6 reviews only. Singleton bands are left untouched (nothing to compare against). The pass itself lives in
 * comparative-core.ts and is shared with the opening-night lane (BRO-7283), which settles a show's groups at score time so
 * the score it publishes is the one this pass would produce hours later. `--show=ID` works for any market.
 *
 * Usage:
 *   tsx scripts/llm-scoring/comparative-rescore.ts --show=war-horse-west-end-2026 [--dry-run]
 *   tsx scripts/llm-scoring/comparative-rescore.ts --all-we [--limit=N] [--max-rescores=N] [--dry-run]
 *
 * Env: OPENAI_API_KEY, GEMINI_API_KEY (and optionally ANTHROPIC_API_KEY). At
 * least 2 models must be available or the run aborts (combine needs 2 to apply
 * the ordering guardrail). REVIEW_TEXTS_DIR overrides the data path.
 *
 * Rule 13 / §12.7: this is scoring logic. The --dry-run mode prints the
 * isolated→comparative delta, bucket drift, and mean drift so the A/B gate can
 * be checked before any write. All reviews must stay in the same bucket.
 *
 * Idempotent by design (this is now wired into llm-ensemble-score.yml as a
 * daily cron step, not just a one-off manual pass): a show+band group is
 * skipped with zero API calls once EVERY entry in it already carries
 * `llmScore.comparative` — otherwise a recurring cron would re-spend on
 * already-fixed groups every run and could re-shuffle stable scores via LLM
 * temperature noise. A group is only reprocessed when a new review lands in
 * an existing band. `--max-rescores=N` caps API-calling groups per invocation
 * (cron passes a small cap; manual full sweeps can omit it).
 */

import '../lib/llm-usage-install.js'; // LLM spend meter: keep it the first import (BRO-5043)
import * as path from 'path';
import { scoreToBucket } from './config';
import { PipelineRunSummary } from './types';
import { availableModels, settleShow, usageTotals } from './comparative-core';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listShowDirs } = require('../lib/list-show-dirs');
const { COMPARATIVE_OPENAI } = require('../lib/models');

// The pass itself lives in comparative-core.ts, shared with the opening-night lane (BRO-7283).

const REVIEW_TEXTS_DIR =
  process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '../../data/review-texts');

async function main() {
  const startedAt = new Date().toISOString();
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const allWE = args.includes('--all-we');
  const showArg = args.find((a) => a.startsWith('--show='))?.split('=')[1];
  const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
  const maxRescores = parseInt(args.find((a) => a.startsWith('--max-rescores='))?.split('=')[1] || '0', 10);

  const models = availableModels();
  if (models.length < 2) {
    console.error(`✗ Need >=2 models; found ${models.length} (${models.map((m) => m.name).join(',') || 'none'}). Set OPENAI_API_KEY + GEMINI_API_KEY.`);
    process.exit(1);
  }
  console.log(`Models: ${models.map((m) => m.name).join(', ')}${dryRun ? '  [DRY RUN — no writes]' : ''}`);

  const showsArg = args.find((a) => a.startsWith('--shows='))?.split('=')[1];

  let shows: string[] = [];
  if (showArg) shows = [showArg];
  else if (showsArg) shows = showsArg.split(',').map((s) => s.trim()).filter(Boolean);
  else if (allWE) {
    shows = listShowDirs(REVIEW_TEXTS_DIR)
      .filter((s) => /west-end|off-west-end/.test(s));
    if (limit > 0) shows = shows.slice(0, limit);
  } else {
    console.error('Pass --show=ID or --all-we');
    process.exit(1);
  }

  // A/B accounting
  let totalReviews = 0, changed = 0, bucketShifts = 0;
  let sumDelta = 0, sumAbsDelta = 0;
  let rescoresDone = 0;
  const examples: string[] = [];

  for (const show of shows) {
    const left = maxRescores > 0 ? maxRescores - rescoresDone : 0;
    if (maxRescores > 0 && left <= 0) {
      console.log(`\nReached --max-rescores=${maxRescores}; stopping.`);
      break;
    }
    const st = await settleShow(show, {
      reviewTextsDir: REVIEW_TEXTS_DIR, models, dryRun, maxRescores: left, log: (l) => console.log(l),
    });
    totalReviews += st.totalReviews; changed += st.changed; bucketShifts += st.bucketShifts;
    sumDelta += st.sumDelta; sumAbsDelta += st.sumAbsDelta; rescoresDone += st.rescoresDone;
    for (const ex of st.examples) if (examples.length < 5) examples.push(ex);
    if (st.capReached) break;
  }

  console.log('\n===== A/B SUMMARY =====');
  console.log(`Reviews in multi-review bands: ${totalReviews}`);
  console.log(`Changed: ${changed}  (${totalReviews ? ((changed / totalReviews) * 100).toFixed(1) : '0'}%)`);
  console.log(`Bucket shifts: ${bucketShifts}  (${totalReviews ? ((bucketShifts / totalReviews) * 100).toFixed(1) : '0'}%)  [GATE: <5%]`);
  console.log(`Mean drift: ${totalReviews ? (sumDelta / totalReviews).toFixed(2) : '0'} pts  [GATE: <5pts]`);
  console.log(`Mean |drift|: ${totalReviews ? (sumAbsDelta / totalReviews).toFixed(2) : '0'} pts`);
  if (!dryRun) console.log(`\n✓ Wrote ${changed} updated review files.`);

  // BRO-3392 — same costUsd/runId recording BRO-3381 added to index.ts, so
  // this script's spend (previously untracked — see the ticket's grep for
  // maxCost/estimateCost/costUsd in this file, zero matches) sums into the
  // SAME per-run total the cost-breach alarm reads from data/llm-scoring-runs.json.
  //
  // Cost is computed and printed regardless of --dry-run (matches index.ts's
  // own ordering, ~L2328-2379: cost is logged unconditionally, only the
  // persistence + breach-check below is gated) — a paid --dry-run A/B check
  // (this file's own primary documented use, see header) still calls every
  // model and should show its cost on the console even though nothing is
  // persisted for it.
  const completedAt = new Date().toISOString();
  const { costBreakdown: __costBreakdown } = require('./cost');
  const breakdown = __costBreakdown({
    claude: usageTotals.claude,
    openai: usageTotals.openai,
    gemini: usageTotals.gemini,
  }, { claudeModelName: 'claude-sonnet-4-6', openaiModelName: COMPARATIVE_OPENAI });
  const costUsd = breakdown.total;
  console.log(
    `Estimated cost: $${costUsd.toFixed(4)} (Claude: $${breakdown.claude.toFixed(4)}, OpenAI: $${breakdown.openai.toFixed(4)}, Gemini: $${breakdown.gemini.toFixed(4)})`
  );

  if (!dryRun) {
    const summary: PipelineRunSummary = {
      startedAt,
      completedAt,
      totalReviews,
      // totalReviews only counts entries in groups this invocation actually
      // rescored (loop above increments it inside the post-idempotency-skip,
      // post-maxRescores-cutoff branch) — it IS the reviews-processed count,
      // not a total-considered count, so processed:totalReviews / skipped:0
      // matches PipelineRunSummary's "processed = reviews scored" contract
      // (types.ts) instead of reporting group counts under a reviews field.
      processed: totalReviews,
      skipped: 0,
      errors: 0,
      tokensUsed: {
        input: usageTotals.claude.input + usageTotals.openai.input + usageTotals.gemini.input,
        output: usageTotals.claude.output + usageTotals.openai.output + usageTotals.gemini.output,
        cacheRead: usageTotals.claude.cacheRead,
        cacheWrite: usageTotals.claude.cacheWrite,
        total:
          usageTotals.claude.input + usageTotals.claude.output +
          usageTotals.openai.input + usageTotals.openai.output +
          usageTotals.gemini.input + usageTotals.gemini.output +
          usageTotals.claude.cacheRead + usageTotals.claude.cacheWrite,
      },
      costUsd,
      runId: process.env.GITHUB_RUN_ID || null,
      source: 'comparative-rescore',
      errorDetails: [],
    };

    const { appendRunSummary, reportRunCostBreach, reportRollingCostAlerts } = require('../lib/llm-scoring-cost-recording');
    const runsAfterSave = appendRunSummary(summary);
    console.log(`Run summary saved to data/llm-scoring-runs.json`);
    await reportRollingCostAlerts(runsAfterSave);

    // Re-check the SAME runId's cumulative spend: index.ts's own check ran
    // before this script's cost existed (same job, later step).
    await reportRunCostBreach(runsAfterSave, { runId: summary.runId, logPrefix: '[comparative-rescore]' });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
