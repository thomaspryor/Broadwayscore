/**
 * Real vendor Batch API clients for the nightly ensemble scorer's --batch
 * mode (task #505). Pure request/response shaping lives in
 * scripts/lib/llm-batch.js — this file is the only place that actually
 * talks to Anthropic / OpenAI / Gemini over the network for batch
 * submission, status polling, and result retrieval.
 *
 * NOT wired into scripts/llm-scoring/index.ts yet. See the handoff notes in
 * task #505 for the integration plan (index.ts's per-file loop needs a
 * two-phase submit/poll/merge restructure to stay byte-parity-safe with the
 * synchronous path — deliberately left to a dedicated follow-up given the
 * blast radius of the live nightly scoring pipeline).
 */

import Anthropic from '@anthropic-ai/sdk';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  parseAnthropicBatchResult,
  parseOpenAIBatchResult,
  parseGeminiBatchResult,
} = require('../lib/llm-batch.js');

export type VendorBatchStatus = 'in_progress' | 'ended' | 'failed' | 'expired' | 'unknown';

export interface VendorResult {
  customId: string;
  success: boolean;
  text?: string;
  error?: string;
  usage?: { input: number; output: number; cacheWrite?: number; cacheRead?: number };
}

// ========================================
// ANTHROPIC
// ========================================

export async function submitAnthropicBatch(
  requests: Array<{ custom_id: string; params: any }>,
  apiKey: string
): Promise<{ id: string }> {
  const client = new Anthropic({ apiKey });
  const batch = await client.messages.batches.create({ requests: requests as any });
  return { id: batch.id };
}

export async function getAnthropicBatchStatus(batchId: string, apiKey: string): Promise<VendorBatchStatus> {
  const client = new Anthropic({ apiKey });
  const batch = await client.messages.batches.retrieve(batchId);
  // Anthropic's own status is in_progress | canceling | ended — 'ended' is
  // our only terminal state (results may include per-item errors/expiries,
  // handled per-item by parseAnthropicBatchResult, not at the batch level).
  if (batch.processing_status === 'ended') return 'ended';
  return 'in_progress';
}

export async function fetchAnthropicBatchResults(batchId: string, apiKey: string): Promise<VendorResult[]> {
  const client = new Anthropic({ apiKey });
  const decoder = await client.messages.batches.results(batchId);
  const results: VendorResult[] = [];
  for await (const entry of decoder) {
    results.push(parseAnthropicBatchResult(entry));
  }
  return results;
}

// ========================================
// OPENAI
// ========================================

const OPENAI_BASE = 'https://api.openai.com/v1';

export async function submitOpenAIBatch(
  lines: Array<{ custom_id: string; method: string; url: string; body: any }>,
  apiKey: string
): Promise<{ id: string }> {
  const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch-input.jsonl');

  const uploadRes = await fetch(`${OPENAI_BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!uploadRes.ok) {
    throw new Error(`OpenAI file upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }
  const uploaded = (await uploadRes.json()) as { id: string };

  const batchRes = await fetch(`${OPENAI_BASE}/batches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input_file_id: uploaded.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    }),
  });
  if (!batchRes.ok) {
    throw new Error(`OpenAI batch create failed: ${batchRes.status} ${await batchRes.text()}`);
  }
  const batch = (await batchRes.json()) as { id: string };
  return { id: batch.id };
}

interface OpenAIBatchObject {
  status: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
}

export async function getOpenAIBatchStatus(
  batchId: string,
  apiKey: string
): Promise<{ status: VendorBatchStatus; outputFileId?: string; errorFileId?: string }> {
  const res = await fetch(`${OPENAI_BASE}/batches/${batchId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI batch status fetch failed: ${res.status} ${await res.text()}`);
  }
  const batch = (await res.json()) as OpenAIBatchObject;
  const terminal = new Set(['completed', 'failed', 'expired', 'cancelled']);
  return {
    status: terminal.has(batch.status) ? 'ended' : 'in_progress',
    outputFileId: batch.output_file_id || undefined,
    errorFileId: batch.error_file_id || undefined,
  };
}

export async function fetchOpenAIBatchResults(outputFileId: string, apiKey: string): Promise<VendorResult[]> {
  const res = await fetch(`${OPENAI_BASE}/files/${outputFileId}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI results file fetch failed: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => parseOpenAIBatchResult(JSON.parse(line)));
}

// ========================================
// GEMINI
// ========================================
// UNVERIFIED against a live round trip — see the caveat in
// scripts/lib/llm-batch.js. Confirm this wire shape with a real small batch
// before enabling in the nightly cron.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function submitGeminiBatch(
  requests: Array<{ metadata: { key: string }; request: any }>,
  apiKey: string,
  model: string
): Promise<{ name: string }> {
  const res = await fetch(`${GEMINI_BASE}/models/${model}:batchGenerateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batch: {
        displayName: `bsc-ensemble-${Date.now()}`,
        inputConfig: { requests: { requests } },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini batch submit failed: ${res.status} ${await res.text()}`);
  }
  const op = (await res.json()) as { name: string };
  return { name: op.name };
}

export async function getGeminiBatchStatus(
  operationName: string,
  apiKey: string
): Promise<{ status: VendorBatchStatus; response?: any }> {
  const res = await fetch(`${GEMINI_BASE}/${operationName}?key=${apiKey}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Gemini batch status fetch failed: ${res.status} ${await res.text()}`);
  }
  const op = (await res.json()) as { done?: boolean; response?: any; error?: any };
  if (!op.done) return { status: 'in_progress' };
  if (op.error) return { status: 'failed' };
  return { status: 'ended', response: op.response };
}

export function extractGeminiBatchResults(operationResponse: any): VendorResult[] {
  const inlined = operationResponse?.inlinedResponses?.inlinedResponses || [];
  return inlined.map((entry: any) => parseGeminiBatchResult(entry));
}
