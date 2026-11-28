/**
 * Batch API execution for comparative-rescore.ts (BRO-7523).
 *
 * Two-pass: (1) a record pass runs the normal settleShow grouping with recorder
 * models, collecting every prompt it would send; (2) the prompts go out as one
 * batch per vendor (50% price) and the real pass runs with models that answer
 * from recorded batch answers. It NEVER falls back to a full-price sync call.
 * Same model, prompt and temperature as the sync callers (COMPARATIVE_PARAMS,
 * scripts/lib/comparative-batch.js).
 *
 * Persistence (data/collection-state/comparative-batch-state.json, committed by
 * the workflow's checkpoint step): per vendor, the in-flight batch id and every
 * answer by prompt-content key. A batch that outlives this run's poll budget is
 * resumed next run (never re-submitted, never double-billed); answers from a
 * vendor that finished first are kept until the slower vendor catches up.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  submitAnthropicBatch, getAnthropicBatchStatus, fetchAnthropicBatchResults,
  submitOpenAIBatch, getOpenAIBatchStatus, fetchOpenAIBatchResults, fetchOpenAIBatchErrors,
  submitGeminiBatch, getGeminiBatchStatus, extractGeminiBatchResults,
  VendorResult,
} from './batch-clients';
import type { ComparativeModel } from './comparative-core';
import { usageTotals } from './comparative-core';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cb = require('../lib/comparative-batch');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { COMPARATIVE_OPENAI } = require('../lib/models');

type VendorState = { inflight?: { id: string; keys: string[]; submittedAt: string }; answers?: Record<string, { text: string; at: string }>; submitFailures?: number };
export type BatchState = Record<string, VendorState>;

const STATE_PATH = path.join(__dirname, '../../data/collection-state/comparative-batch-state.json');
export function loadState(): BatchState { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return {}; } }
function saveState(s: BatchState) {
  const empty = Object.values(s).every((v) => !v.inflight && Object.keys(v.answers || {}).length === 0);
  if (empty) { try { fs.unlinkSync(STATE_PATH); } catch { /* absent */ } return; }
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.${process.pid}.tmp`; // atomic: a torn file would parse as {} and re-submit (double billing)
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, STATE_PATH);
}

/** Models that record the prompt and answer nothing (record pass; run with dryRun). */
export function recorderModels(models: ComparativeModel[], sink: Set<string>): ComparativeModel[] {
  return models.map((m) => ({ name: m.name, call: async (p: string) => { sink.add(p); return null; } }));
}

/**
 * Models that answer from recorded batch answers only; never call a vendor.
 * All-or-nothing per prompt: while any vendor is still in flight for it, none
 * answer (transient skip, group stays unsettled). A vendor whose batch ended
 * without an answer is recorded as '' and yields null, like a sync failure.
 */
export function batchedModels(models: ComparativeModel[], state: BatchState): ComparativeModel[] {
  return models.map((m) => ({
    name: m.name,
    call: async (p: string) => {
      const k = cb.promptKey(p);
      if (!cb.allVendorsRecorded(state, k)) return null;
      return state[m.name]?.answers?.[k]?.text || null;
    },
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function addUsage(name: string, results: VendorResult[]) {
  for (const r of results) {
    if (!r.success || !r.usage) continue;
    const u: any = (usageTotals as any)[name];
    u.input += r.usage.input || 0;
    u.output += r.usage.output || 0;
    if (name === 'claude') { u.cacheRead += r.usage.cacheRead || 0; u.cacheWrite += r.usage.cacheWrite || 0; }
  }
}

type Adapter = {
  submit: (prompts: string[]) => Promise<string>;
  ended: (id: string) => Promise<boolean>;
  fetch: (id: string) => Promise<VendorResult[]>;
};

function adapterFor(name: string): Adapter {
  if (name === 'claude') {
    const key = process.env.ANTHROPIC_API_KEY!;
    return {
      submit: async (ps) => (await submitAnthropicBatch(ps.map((p, i) => cb.buildAnthropicRequest(i, p)), key)).id,
      ended: async (id) => (await getAnthropicBatchStatus(id, key)) === 'ended',
      fetch: (id) => fetchAnthropicBatchResults(id, key),
    };
  }
  if (name === 'openai') {
    const key = process.env.OPENAI_API_KEY!;
    return {
      submit: async (ps) => (await submitOpenAIBatch(ps.map((p, i) => cb.buildOpenAIRequest(i, p, COMPARATIVE_OPENAI)), key)).id,
      ended: async (id) => (await getOpenAIBatchStatus(id, key)).status === 'ended',
      fetch: async (id) => {
        const st = await getOpenAIBatchStatus(id, key);
        let r: VendorResult[] = [];
        if (st.outputFileId) r = await fetchOpenAIBatchResults(st.outputFileId, key);
        if (st.errorFileId) r = r.concat(await fetchOpenAIBatchErrors(st.errorFileId, key));
        return r;
      },
    };
  }
  const key = process.env.GEMINI_API_KEY!;
  return {
    submit: async (ps) => (await submitGeminiBatch(ps.map((p, i) => cb.buildGeminiRequest(i, p)), key, cb.COMPARATIVE_PARAMS.geminiModel)).name,
    ended: async (id) => (await getGeminiBatchStatus(id, key)).status !== 'in_progress',
    fetch: async (id) => {
      const st = await getGeminiBatchStatus(id, key);
      return st.status === 'ended' && st.response ? extractGeminiBatchResults(st.response) : [];
    },
  };
}

async function runVendor(name: string, prompts: string[], pollMs: number, deadline: number, state: BatchState): Promise<void> {
  const ad = adapterFor(name);
  const keyOf = new Map(prompts.map((p) => [cb.promptKey(p), p]));
  const wanted = [...keyOf.keys()];
  state[name] = cb.pruneAnswers(state[name], [...wanted, ...(state[name]?.inflight?.keys || [])]);
  const poll = async (id: string) => {
    while (!(await ad.ended(id))) {
      if (Date.now() > deadline) return false;
      await sleep(pollMs);
    }
    return true;
  };
  const collect = async (inflight: { id: string; keys: string[] }) => {
    const results = await ad.fetch(inflight.id);
    addUsage(name, results);
    state[name] = cb.recordTerminal(state[name], inflight.keys, cb.resultsByKey(inflight.keys, results));
    saveState(state);
    console.log(`  ${name} batch ${inflight.id} ended: ${[...cb.resultsByKey(inflight.keys, results)].length}/${inflight.keys.length} answered`);
  };
  try {
    // 1) a batch left in flight by an earlier run is collected first (never re-submitted).
    let inflight = cb.usableInflight(state[name]);
    if (inflight) {
      console.log(`  ${name} batch ${inflight.id} resumed (${inflight.keys.length} prompts)`);
      if (!(await poll(inflight.id))) throw new Error('poll budget exhausted');
      await collect(inflight);
    }
    // 2) submit only the prompts nobody has answered or is answering.
    const missing = cb.missingKeys(state[name], wanted);
    if (missing.length) {
      let id: string;
      try {
        id = await ad.submit(missing.map((k) => keyOf.get(k)!));
      } catch (e: any) {
        // A vendor that can never submit would hold every group open and make the healthy
        // vendors' answers expire and get re-billed. After MAX_SUBMIT_FAILURES runs its missing
        // prompts become terminal failures, so groups settle on the other models (sync parity).
        const fails = (state[name]?.submitFailures || 0) + 1;
        state[name] = fails >= cb.MAX_SUBMIT_FAILURES
          ? cb.recordTerminal(state[name], missing, new Map())
          : { ...state[name], submitFailures: fails };
        saveState(state);
        throw new Error(`submit failed (${fails}/${cb.MAX_SUBMIT_FAILURES}): ${e.message}`);
      }
      inflight = { id, keys: missing, submittedAt: new Date().toISOString() };
      state[name] = { ...state[name], inflight, submitFailures: 0 };
      saveState(state);
      console.log(`  ${name} batch ${id} submitted (${missing.length} prompts)`);
      if (!(await poll(id))) throw new Error('poll budget exhausted');
      await collect(inflight);
    }
  } catch (e: any) {
    console.log(`  ⚠️ ${name} batch not finished this run: ${e.message} (kept in ${path.basename(STATE_PATH)}; next run resumes it, no re-submit)`);
  }
}

export async function runComparativeBatches(
  models: ComparativeModel[],
  promptSet: Set<string>,
  pollMinutes: number,
): Promise<BatchState> {
  const prompts = [...promptSet];
  const deadline = Date.now() + pollMinutes * 60_000;
  const pollMs = Math.min(60_000, Math.max(1_000, pollMinutes * 60_000 / 10));
  const state = loadState();
  for (const k of Object.keys(state)) if (!models.some((m) => m.name === k)) delete state[k];
  await Promise.all(models.map((m) => runVendor(m.name, prompts, pollMs, deadline, state)));
  saveState(state);
  return state;
}
