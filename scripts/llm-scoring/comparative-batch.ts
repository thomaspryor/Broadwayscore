/**
 * Batch API execution for comparative-rescore.ts (BRO-7523).
 *
 * Two-pass: (1) a record pass runs the normal settleShow grouping with
 * recorder models, collecting every prompt it would send; (2) the prompts go
 * out as one batch per vendor (50% price), are polled in-process, and the real
 * pass runs with models that answer from the batch results. A model with no
 * batch answer returns null (an outage-style transient skip: no writes, group
 * stays unsettled for the next run). It NEVER falls back to a full-price sync
 * call. Same model, prompt and temperature as the sync callers
 * (COMPARATIVE_PARAMS, scripts/lib/comparative-batch.js).
 */
import {
  submitAnthropicBatch, getAnthropicBatchStatus, fetchAnthropicBatchResults,
  submitOpenAIBatch, getOpenAIBatchStatus, fetchOpenAIBatchResults, fetchOpenAIBatchErrors,
  submitGeminiBatch, getGeminiBatchStatus, extractGeminiBatchResults,
  VendorResult,
} from './batch-clients';
import * as fs from 'fs';
import * as path from 'path';
import type { ComparativeModel } from './comparative-core';
import { usageTotals } from './comparative-core';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cb = require('../lib/comparative-batch');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { COMPARATIVE_OPENAI } = require('../lib/models');

export type PromptAnswers = Record<string, Map<string, string>>; // model name -> prompt -> text

/** Models that record the prompt and answer nothing (record pass; run with dryRun). */
export function recorderModels(models: ComparativeModel[], sink: Set<string>): ComparativeModel[] {
  return models.map((m) => ({ name: m.name, call: async (p: string) => { sink.add(p); return null; } }));
}

/** Models that answer from batch results only. Never calls a vendor. */
export function batchedModels(models: ComparativeModel[], answers: PromptAnswers): ComparativeModel[] {
  // All-or-nothing per prompt: if any batched vendor lacks its answer, none answer,
  // so the group is a transient skip (unsettled) instead of settling on a shrunken ensemble.
  return models.map((m) => ({
    name: m.name,
    call: async (p: string) => (cb.allVendorsAnswered(answers, p) ? answers[m.name].get(p)! : null),
  }));
}

const STATE_PATH = path.join(__dirname, '../../data/collection-state/comparative-batch-state.json');
type State = Record<string, { id: string; hash: string; submittedAt: string }>;
function loadState(): State { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return {}; } }
function saveState(s: State) {
  if (Object.keys(s).length === 0) { try { fs.unlinkSync(STATE_PATH); } catch { /* absent */ } return; }
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
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

async function runVendor(name: string, prompts: string[], pollMs: number, deadline: number, state: State): Promise<Map<string, string>> {
  let results: VendorResult[] = [];
  const hash = cb.promptSetHash(prompts);
  const resume: string | null = cb.resumableBatch(state, name, hash);
  const remember = (id: string) => {
    state[name] = { id, hash, submittedAt: new Date().toISOString() };
    saveState(state);
  };
  let finished = false;
  try {
    if (name === 'claude') {
      const key = process.env.ANTHROPIC_API_KEY!;
      let id = resume;
      if (id) console.log(`  claude batch ${id} resumed`);
      else { id = (await submitAnthropicBatch(prompts.map((p, i) => cb.buildAnthropicRequest(i, p)), key)).id; remember(id); console.log(`  claude batch ${id} submitted (${prompts.length} prompts)`); }
      while (await getAnthropicBatchStatus(id, key) !== 'ended') {
        if (Date.now() > deadline) throw new Error('poll budget exhausted');
        await sleep(pollMs);
      }
      results = await fetchAnthropicBatchResults(id, key);
    } else if (name === 'openai') {
      const key = process.env.OPENAI_API_KEY!;
      let id = resume;
      if (id) console.log(`  openai batch ${id} resumed`);
      else { id = (await submitOpenAIBatch(prompts.map((p, i) => cb.buildOpenAIRequest(i, p, COMPARATIVE_OPENAI)), key)).id; remember(id); console.log(`  openai batch ${id} submitted (${prompts.length} prompts)`); }
      let st = await getOpenAIBatchStatus(id, key);
      while (st.status !== 'ended') {
        if (Date.now() > deadline) throw new Error('poll budget exhausted');
        await sleep(pollMs);
        st = await getOpenAIBatchStatus(id, key);
      }
      if (st.outputFileId) results = await fetchOpenAIBatchResults(st.outputFileId, key);
      if (st.errorFileId) results = results.concat(await fetchOpenAIBatchErrors(st.errorFileId, key));
    } else if (name === 'gemini') {
      const key = process.env.GEMINI_API_KEY!;
      let op = resume;
      if (op) console.log(`  gemini batch ${op} resumed`);
      else { op = (await submitGeminiBatch(prompts.map((p, i) => cb.buildGeminiRequest(i, p)), key, cb.COMPARATIVE_PARAMS.geminiModel)).name; remember(op); console.log(`  gemini batch ${op} submitted (${prompts.length} prompts)`); }
      let st = await getGeminiBatchStatus(op, key);
      while (st.status === 'in_progress') {
        if (Date.now() > deadline) throw new Error('poll budget exhausted');
        await sleep(pollMs);
        st = await getGeminiBatchStatus(op, key);
      }
      if (st.status === 'ended' && st.response) results = extractGeminiBatchResults(st.response);
    }
    finished = true;
  } catch (e: any) {
    console.log(`  ⚠️ ${name} batch not done this run: ${e.message} (kept in ${path.basename(STATE_PATH)}; next run resumes it, no re-submit)`);
  }
  if (finished) { delete state[name]; saveState(state); }
  addUsage(name, results);
  return cb.resultsByPrompt(prompts, results);
}

export async function runComparativeBatches(
  models: ComparativeModel[],
  promptSet: Set<string>,
  pollMinutes: number,
): Promise<PromptAnswers> {
  const prompts = [...promptSet];
  const answers: PromptAnswers = {};
  const deadline = Date.now() + pollMinutes * 60_000;
  const pollMs = Math.min(60_000, Math.max(1_000, pollMinutes * 60_000 / 10));
  const state = loadState();
  const done = await Promise.all(models.map((m) => runVendor(m.name, prompts, pollMs, deadline, state)));
  models.forEach((m, i) => { answers[m.name] = done[i]; });
  return answers;
}
