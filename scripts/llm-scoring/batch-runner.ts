/**
 * Two-phase batch orchestration for the nightly ensemble scorer (task #516).
 *
 * Phase 1 (scripts/lib/llm-batch.js, task #505) supplied the pure request
 * assembly / result unwrapping / resume decision logic. Phase 2 (this file)
 * is the glue between that library, the real vendor clients in
 * batch-clients.ts, and index.ts's per-file loop:
 *
 *   assembleRequests()  — prepared items → per-vendor request payloads
 *   submitBatches()     — fire all 3 vendors, return their batch/operation IDs
 *   pollUntilTerminal() — poll on a 60s+ cadence inside a wall-clock budget
 *   fetchAndMerge()     — pull results, unwrap, and pair by request index
 *   outcomesForItem()   — one merged row → the ModelOutcome[] that
 *                         EnsembleReviewScorer.combineOutcomes() consumes,
 *                         via each scorer's parity-proven parseBatchResponseV5
 *
 * Nothing here decides what to score, writes review files, or routes
 * rejections — index.ts owns all of that, unchanged, for both sync and
 * batch. The only thing batch mode changes is WHERE a model's raw response
 * text comes from.
 */

import type { ReviewTextFile } from './types';
import type {
  EnsembleReviewScorer,
  ModelOutcome,
  PreparedScoringInput,
} from './ensemble-scorer';
import { buildPromptV5, SYSTEM_PROMPT_V5, PROMPT_VERSION } from './config';
import {
  submitAnthropicBatch,
  getAnthropicBatchStatus,
  fetchAnthropicBatchResults,
  submitOpenAIBatch,
  getOpenAIBatchStatus,
  fetchOpenAIBatchResults,
  fetchOpenAIBatchErrors,
  submitGeminiBatch,
  getGeminiBatchStatus,
  extractGeminiBatchResults,
  VendorResult,
} from './batch-clients';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildCustomId,
  buildAnthropicBatchRequest,
  buildOpenAIBatchLine,
  buildGeminiBatchRequest,
  resultsToMap,
  mergeVendorResults,
  decideNextAction,
} = require('../lib/llm-batch.js');

// ========================================
// TYPES
// ========================================

/** One review queued for batch scoring, with its stage-1 prep already run. */
export interface PendingBatchItem {
  filePath: string;
  showId: string;
  outletId: string;
  reviewFile: ReviewTextFile;
  prep: PreparedScoringInput;
  /** Carried through so the merge phase can reproduce the sync loop's
   *  singleModelEmergency retry-lifecycle bookkeeping. */
  priorEmergencyRetryCount: number;
}

/** Persisted under scoring-progress.json's `batch` key so a timed-out run resumes. */
export interface BatchState {
  submittedAt: string;
  itemCount: number;
  claudeBatchId?: string;
  openaiBatchId?: string;
  /** Gemini returns a long-running *operation name*, not a batch id. */
  geminiBatchId?: string;
  /** index → identity. The prep itself is NOT persisted (it embeds full
   *  review text); the resume path recomputes it from filePath. */
  manifest: Array<{ index: number; showId: string; outletId: string; filePath: string }>;
  models: { claude: string; openai: string; gemini?: string };
  promptVersion: string;
}

export interface VendorRequests {
  anthropic: any[];
  openai: any[];
  gemini: any[];
}

export interface ApiKeys {
  anthropic: string;
  openai: string;
  gemini?: string;
}

export interface MergedRow {
  index: number;
  customId: string;
  claude: VendorResult | null;
  openai: VendorResult | null;
  gemini: VendorResult | null;
}

/** Gemini's inline-request payload ceiling. Google documents 20MB for an
 *  inlined batch; stay well under it and fail loudly rather than have the
 *  submit 400 halfway through a nightly run. */
const GEMINI_INLINE_MAX_BYTES = 15 * 1024 * 1024;

// ========================================
// ASSEMBLY
// ========================================

/**
 * Build the per-vendor request payloads from prepared items.
 *
 * The user prompt comes from buildPromptV5(text, context) and the system
 * prompt from prep.systemPromptOverride || SYSTEM_PROMPT_V5 — byte-identical
 * to what scorer.ts / openai-scorer.ts / gemini-scorer.ts each construct at
 * scoreReviewV5 time. A drift here is the one failure mode that would make
 * batch scores differ from sync scores, so it is derived from the same
 * exported helpers rather than restated.
 */
export function assembleRequests(
  items: PendingBatchItem[],
  config: { geminiEnabled: boolean; claudeModel: string; openaiModel: string; geminiTemperature?: number }
): VendorRequests {
  const anthropic: any[] = [];
  const openai: any[] = [];
  const gemini: any[] = [];

  items.forEach((item, index) => {
    const customId = buildCustomId(index);
    const userPrompt = buildPromptV5(item.prep.scoringInput.text, item.prep.scoringInput.context);
    const systemPrompt = item.prep.systemPromptOverride || SYSTEM_PROMPT_V5;

    anthropic.push(
      buildAnthropicBatchRequest({ customId, model: config.claudeModel, systemPrompt, userPrompt })
    );
    openai.push(buildOpenAIBatchLine({ customId, model: config.openaiModel, systemPrompt, userPrompt }));
    if (config.geminiEnabled) {
      gemini.push(
        buildGeminiBatchRequest({
          customId,
          systemPrompt,
          userPrompt,
          // GeminiScorer's temperature is constructor-configurable (unlike
          // Claude/OpenAI, which hardcode 0.3), so it must be threaded
          // explicitly or batch would score at a different temperature.
          temperature: config.geminiTemperature ?? 0.3,
        })
      );
    }
  });

  return { anthropic, openai, gemini };
}

/**
 * Upper-bound cost estimate for a batch, printed before submission.
 *
 * Batch cost is committed at submit time — there is no per-call circuit
 * breaker to trip mid-run the way --max-cost works in sync mode — so the
 * operator gets the number up front instead. Input tokens are approximated
 * at 4 chars/token; output is charged at the full max_tokens ceiling (500),
 * which real completions come in well under. Hence "≤".
 */
export function estimateBatchUsage(
  requests: VendorRequests
): { claude: { input: number; output: number }; openai: { input: number; output: number }; gemini?: { input: number; output: number } } {
  const CHARS_PER_TOKEN = 4;
  const MAX_OUTPUT_TOKENS = 500;

  const anthropicChars = requests.anthropic.reduce((sum, r) => {
    const sys = (r.params.system || []).map((s: any) => s.text || '').join('');
    const user = (r.params.messages || []).map((m: any) => m.content || '').join('');
    return sum + sys.length + user.length;
  }, 0);
  const openaiChars = requests.openai.reduce((sum, l) => {
    return sum + (l.body.messages || []).map((m: any) => m.content || '').join('').length;
  }, 0);
  const geminiChars = requests.gemini.reduce((sum, r) => {
    const parts = (r.request.contents || []).flatMap((c: any) => c.parts || []);
    return sum + parts.map((p: any) => p.text || '').join('').length;
  }, 0);

  const out: any = {
    claude: {
      input: Math.ceil(anthropicChars / CHARS_PER_TOKEN),
      output: requests.anthropic.length * MAX_OUTPUT_TOKENS,
    },
    openai: {
      input: Math.ceil(openaiChars / CHARS_PER_TOKEN),
      output: requests.openai.length * MAX_OUTPUT_TOKENS,
    },
  };
  if (requests.gemini.length > 0) {
    out.gemini = {
      input: Math.ceil(geminiChars / CHARS_PER_TOKEN),
      output: requests.gemini.length * MAX_OUTPUT_TOKENS,
    };
  }
  return out;
}

// ========================================
// SUBMIT
// ========================================

/**
 * Submit all available vendor batches. A vendor that throws is logged and
 * skipped rather than aborting the run — its leg then merges as `null`,
 * exactly like a rate-limit-exhausted model in sync mode (two surviving
 * models still produce a valid ensemble; zero surviving models hits
 * finalizeScoredFile's allModelsFailed guard and writes nothing).
 */
export async function submitBatches(
  requests: VendorRequests,
  keys: ApiKeys,
  config: { geminiModel: string }
): Promise<{ claudeBatchId?: string; openaiBatchId?: string; geminiBatchId?: string }> {
  const ids: { claudeBatchId?: string; openaiBatchId?: string; geminiBatchId?: string } = {};

  try {
    const batch = await submitAnthropicBatch(requests.anthropic, keys.anthropic);
    ids.claudeBatchId = batch.id;
    console.log(`   ✓ Anthropic batch submitted: ${batch.id} (${requests.anthropic.length} requests)`);
  } catch (e: any) {
    console.log(`   ⚠️ Anthropic batch submit FAILED: ${e.message}`);
  }

  try {
    const batch = await submitOpenAIBatch(requests.openai, keys.openai);
    ids.openaiBatchId = batch.id;
    console.log(`   ✓ OpenAI batch submitted: ${batch.id} (${requests.openai.length} requests)`);
  } catch (e: any) {
    console.log(`   ⚠️ OpenAI batch submit FAILED: ${e.message}`);
  }

  if (requests.gemini.length > 0 && keys.gemini) {
    const payloadBytes = Buffer.byteLength(JSON.stringify(requests.gemini), 'utf-8');
    if (payloadBytes > GEMINI_INLINE_MAX_BYTES) {
      console.log(
        `   ⚠️ Gemini batch skipped: inline payload ${(payloadBytes / 1024 / 1024).toFixed(1)}MB exceeds ${GEMINI_INLINE_MAX_BYTES / 1024 / 1024}MB cap — lower --limit`
      );
    } else {
      try {
        const op = await submitGeminiBatch(requests.gemini, keys.gemini, config.geminiModel);
        ids.geminiBatchId = op.name;
        console.log(`   ✓ Gemini batch submitted: ${op.name} (${requests.gemini.length} requests)`);
      } catch (e: any) {
        console.log(`   ⚠️ Gemini batch submit FAILED: ${e.message}`);
      }
    }
  }

  return ids;
}

// ========================================
// POLL
// ========================================

/** Fetch each submitted vendor's current status, mapped to llm-batch.js's vocabulary. */
export async function fetchVendorStatuses(
  state: BatchState,
  keys: ApiKeys
): Promise<{ claude?: string; openai?: string; gemini?: string }> {
  const statuses: { claude?: string; openai?: string; gemini?: string } = {};

  if (state.claudeBatchId) {
    try {
      statuses.claude = await getAnthropicBatchStatus(state.claudeBatchId, keys.anthropic);
    } catch (e: any) {
      console.log(`   ⚠️ Anthropic status check failed: ${e.message}`);
    }
  }
  if (state.openaiBatchId) {
    try {
      statuses.openai = (await getOpenAIBatchStatus(state.openaiBatchId, keys.openai)).status;
    } catch (e: any) {
      console.log(`   ⚠️ OpenAI status check failed: ${e.message}`);
    }
  }
  if (state.geminiBatchId && keys.gemini) {
    try {
      statuses.gemini = (await getGeminiBatchStatus(state.geminiBatchId, keys.gemini)).status;
    } catch (e: any) {
      console.log(`   ⚠️ Gemini status check failed: ${e.message}`);
    }
  }

  return statuses;
}

/**
 * Poll until decideNextAction() says fetch_and_merge, or the wall-clock
 * budget runs out. Returns `ready: false` when the budget expires with
 * batches still in flight — the caller persists state and the NEXT scheduled
 * run resumes polling instead of resubmitting (and paying twice).
 */
export async function pollUntilTerminal(
  state: BatchState,
  keys: ApiKeys,
  opts: { budgetMinutes: number; intervalSeconds?: number }
): Promise<{ ready: boolean; forced?: boolean; reason?: string }> {
  // Vendors publish 24h completion windows; polling faster than 60s only
  // burns rate limit. 60s floor is enforced, not merely defaulted.
  const intervalMs = Math.max(60, opts.intervalSeconds || 60) * 1000;
  const deadline = Date.now() + opts.budgetMinutes * 60 * 1000;
  let round = 0;

  for (;;) {
    const statuses = await fetchVendorStatuses(state, keys);
    const decision = decideNextAction({ batchState: state, vendorStatuses: statuses, now: Date.now() });
    round++;

    const shown = ['claude', 'openai', 'gemini']
      .filter((v) => (state as any)[`${v}BatchId`])
      .map((v) => `${v}=${(statuses as any)[v] || 'unknown'}`)
      .join(' ');
    console.log(`   [poll ${round}] ${shown} → ${decision.action}${decision.forced ? ' (FORCED)' : ''}`);

    if (decision.action === 'fetch_and_merge') {
      return { ready: true, forced: decision.forced, reason: decision.reason };
    }

    if (Date.now() + intervalMs > deadline) {
      return { ready: false, reason: `poll budget of ${opts.budgetMinutes} min exhausted with batches still in flight` };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ========================================
// FETCH + MERGE
// ========================================

/**
 * Pull every submitted vendor's results and pair them by request index.
 *
 * OpenAI can be terminal with no output file when every request errored —
 * fetch the error file too, so those items surface a real error string
 * instead of a silent null (batch-clients.ts documents this contract).
 */
export async function fetchAndMerge(state: BatchState, keys: ApiKeys): Promise<MergedRow[]> {
  let claudeResults: VendorResult[] = [];
  let openaiResults: VendorResult[] = [];
  let geminiResults: VendorResult[] = [];

  if (state.claudeBatchId) {
    try {
      claudeResults = await fetchAnthropicBatchResults(state.claudeBatchId, keys.anthropic);
    } catch (e: any) {
      console.log(`   ⚠️ Anthropic result fetch failed: ${e.message}`);
    }
  }

  if (state.openaiBatchId) {
    try {
      const status = await getOpenAIBatchStatus(state.openaiBatchId, keys.openai);
      if (status.outputFileId) {
        openaiResults = await fetchOpenAIBatchResults(status.outputFileId, keys.openai);
      }
      if (status.errorFileId) {
        openaiResults = openaiResults.concat(await fetchOpenAIBatchErrors(status.errorFileId, keys.openai));
      }
      if (!status.outputFileId && !status.errorFileId) {
        console.log(`   ⚠️ OpenAI batch ${state.openaiBatchId} terminal with neither output nor error file`);
      }
    } catch (e: any) {
      console.log(`   ⚠️ OpenAI result fetch failed: ${e.message}`);
    }
  }

  if (state.geminiBatchId && keys.gemini) {
    try {
      const status = await getGeminiBatchStatus(state.geminiBatchId, keys.gemini);
      if (status.status === 'ended' && status.response) {
        geminiResults = extractGeminiBatchResults(status.response);
      } else {
        console.log(`   ⚠️ Gemini operation ${state.geminiBatchId} not usable (status=${status.status})`);
      }
    } catch (e: any) {
      console.log(`   ⚠️ Gemini result fetch failed: ${e.message}`);
    }
  }

  console.log(
    `   Results fetched — claude:${claudeResults.length} openai:${openaiResults.length} gemini:${geminiResults.length} (of ${state.itemCount} items)`
  );

  return mergeVendorResults(
    {
      claude: resultsToMap(claudeResults),
      openai: resultsToMap(openaiResults),
      gemini: resultsToMap(geminiResults),
    },
    state.itemCount
  );
}

/**
 * Turn one merged row into the ModelOutcome[] that combineOutcomes()
 * consumes.
 *
 * Each vendor's raw response text goes through THAT vendor's own
 * parseBatchResponseV5() — the identical rejection-check + parse pipeline
 * its live scoreReviewV5 uses (Gemini's notably applies
 * GEMINI_CALIBRATION_OFFSET inside validateAndNormalize), which is what
 * makes a batch-derived outcome indistinguishable from a sync one.
 *
 * A vendor leg that is missing, errored, or unparseable becomes
 * {result: null, error} — the same shape scoreReview()'s per-model
 * .catch(err => ({result: null, error})) produces, so a partial batch
 * degrades exactly like a partial live call.
 */
export function outcomesForItem(
  row: MergedRow,
  scorer: EnsembleReviewScorer,
  geminiEnabled: boolean
): { outcomes: ModelOutcome[]; usage: { claude: any; openai: any; gemini: any } } {
  const scorers = scorer.getScorers();
  const outcomes: ModelOutcome[] = [];
  const usage = {
    claude: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    openai: { input: 0, output: 0 },
    gemini: { input: 0, output: 0 },
  };

  const legs: Array<{
    model: 'claude' | 'openai' | 'gemini';
    vendorResult: VendorResult | null;
    parse: (text: string) => any;
    enabled: boolean;
  }> = [
    { model: 'claude', vendorResult: row.claude, parse: (t) => scorers.claude.parseBatchResponseV5(t), enabled: true },
    { model: 'openai', vendorResult: row.openai, parse: (t) => scorers.openai.parseBatchResponseV5(t), enabled: true },
    {
      model: 'gemini',
      vendorResult: row.gemini,
      parse: (t) => (scorers.gemini ? scorers.gemini.parseBatchResponseV5(t) : { success: false, error: 'gemini_disabled' }),
      enabled: geminiEnabled && !!scorers.gemini,
    },
  ];

  for (const leg of legs) {
    if (!leg.enabled) continue;

    const vr = leg.vendorResult;
    if (!vr) {
      outcomes.push({ model: leg.model, result: null, error: 'batch_result_missing' });
      continue;
    }
    if (vr.usage) {
      (usage as any)[leg.model].input += vr.usage.input || 0;
      (usage as any)[leg.model].output += vr.usage.output || 0;
      if (leg.model === 'claude') {
        usage.claude.cacheWrite += vr.usage.cacheWrite || 0;
        usage.claude.cacheRead += vr.usage.cacheRead || 0;
      }
    }
    if (!vr.success) {
      outcomes.push({ model: leg.model, result: null, error: vr.error || 'batch_item_failed' });
      continue;
    }

    let parsed: any;
    try {
      parsed = leg.parse(vr.text || '');
    } catch (e: any) {
      outcomes.push({ model: leg.model, result: null, error: `batch_parse_threw:${e.message}` });
      continue;
    }

    outcomes.push({
      model: leg.model,
      result: parsed.success && !parsed.rejected ? parsed.result : null,
      error: parsed.error,
      rejected: parsed.rejected,
      rejection: parsed.rejection,
      rejectionReasoning: parsed.rejectionReasoning,
    });
  }

  return { outcomes, usage };
}

/**
 * Build the persisted state object for a freshly-submitted batch.
 * `submittedAt` anchors decideNextAction()'s 25h forced-merge grace window.
 */
export function buildBatchState(
  items: PendingBatchItem[],
  ids: { claudeBatchId?: string; openaiBatchId?: string; geminiBatchId?: string },
  config: { claudeModel: string; openaiModel: string; geminiModel?: string },
  submittedAtISO: string
): BatchState {
  return {
    submittedAt: submittedAtISO,
    itemCount: items.length,
    ...ids,
    manifest: items.map((it, index) => ({
      index,
      showId: it.showId,
      outletId: it.outletId,
      filePath: it.filePath,
    })),
    models: { claude: config.claudeModel, openai: config.openaiModel, gemini: config.geminiModel },
    promptVersion: PROMPT_VERSION,
  };
}
