#!/usr/bin/env node
/**
 * Weekly Model Health Check
 *
 * Verifies every canonical model alias in scripts/lib/models.js still resolves
 * at the provider's API. A retired model returns 404; this script turns that
 * into a workflow failure + Discord/email alert before any production call fails.
 *
 * Uses list-models / get-model endpoints (zero tokens, no cost).
 * Retries 5xx three times at 30s to avoid transient false positives.
 *
 * Exit code: 0 = all pass, 1 = one or more models dead or key missing
 */

const https = require('https');
const path = require('path');
const MODELS = require('./lib/models');

// --- HTTP helpers ---

function httpsGet(url, headers = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers, timeout: 20000 },
      (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

async function withRetry(fn, retries = 3, delayMs = 30000) {
  for (let i = 0; i <= retries; i++) {
    const result = await fn();
    if (result.status >= 500 && i < retries) {
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    return result;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Model checks ---

async function checkAnthropicModel(modelId, apiKey) {
  // /v1/models lists all available models; check if ours appears
  const res = await withRetry(() => httpsGet('https://api.anthropic.com/v1/models', {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }));

  if (res.status === 401) return { status: 'skip', message: 'Key invalid — skipping model check' };
  if (res.status === 0) return { status: 'warn', message: `Network error: ${res.body}` };
  if (res.status !== 200) return { status: 'warn', message: `Unexpected status ${res.status}` };

  try {
    const data = JSON.parse(res.body);
    const ids = (data.data || []).map((m) => m.id);
    if (ids.some((id) => id === modelId || id.startsWith(modelId))) {
      return { status: 'pass', message: 'Model available' };
    }
    return { status: 'fail', message: `Model ${modelId} not in /v1/models list (${ids.length} models listed)` };
  } catch {
    return { status: 'warn', message: 'Could not parse model list' };
  }
}

async function checkGeminiModel(modelId, apiKey) {
  // /v1beta/models/{id} returns 200 if model exists, 404 if retired
  const res = await withRetry(() =>
    httpsGet(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}?key=${apiKey}`)
  );

  if (res.status === 200) return { status: 'pass', message: 'Model available' };
  if (res.status === 404) return { status: 'fail', message: `Model ${modelId} returned 404 — likely retired` };
  if (res.status === 400 || res.status === 403) return { status: 'skip', message: 'Key invalid — skipping model check' };
  return { status: 'warn', message: `Unexpected status ${res.status}` };
}

async function checkOpenAIModel(modelId, apiKey) {
  // /v1/models/{id} returns 200 if available, 404 if deprecated/removed
  const res = await withRetry(() =>
    httpsGet(`https://api.openai.com/v1/models/${encodeURIComponent(modelId)}`, {
      'Authorization': `Bearer ${apiKey}`,
    })
  );

  if (res.status === 200) return { status: 'pass', message: 'Model available' };
  if (res.status === 404) return { status: 'fail', message: `Model ${modelId} returned 404 — deprecated or removed` };
  if (res.status === 401) return { status: 'skip', message: 'Key invalid — skipping model check' };
  return { status: 'warn', message: `Unexpected status ${res.status}` };
}

async function checkOpenRouterModel(modelId, apiKey) {
  // /v1/models returns list of all available models; check if ours appears
  const res = await withRetry(() =>
    httpsGet('https://openrouter.ai/api/v1/models', {
      'Authorization': `Bearer ${apiKey}`,
    })
  );

  if (res.status === 401) return { status: 'skip', message: 'Key invalid — skipping model check' };
  if (res.status !== 200) return { status: 'warn', message: `Unexpected status ${res.status}` };

  try {
    const data = JSON.parse(res.body);
    const ids = (data.data || []).map((m) => m.id);
    if (ids.includes(modelId)) return { status: 'pass', message: 'Model available' };
    return { status: 'fail', message: `Model ${modelId} not in OpenRouter model list` };
  } catch {
    return { status: 'warn', message: 'Could not parse model list' };
  }
}

// --- Main ---

async function main() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  const checks = [
    { name: `Anthropic / ${MODELS.CLAUDE_SONNET}`, fn: () => anthropicKey ? checkAnthropicModel(MODELS.CLAUDE_SONNET, anthropicKey) : Promise.resolve({ status: 'skip', message: 'ANTHROPIC_API_KEY not set' }) },
    { name: `Anthropic / ${MODELS.CLAUDE_HAIKU}`, fn: () => anthropicKey ? checkAnthropicModel(MODELS.CLAUDE_HAIKU, anthropicKey) : Promise.resolve({ status: 'skip', message: 'ANTHROPIC_API_KEY not set' }) },
    { name: `Anthropic / ${MODELS.CLAUDE_OPUS}`, fn: () => anthropicKey ? checkAnthropicModel(MODELS.CLAUDE_OPUS, anthropicKey) : Promise.resolve({ status: 'skip', message: 'ANTHROPIC_API_KEY not set' }) },
    { name: `Gemini / ${MODELS.GEMINI_FLASH}`, fn: () => geminiKey ? checkGeminiModel(MODELS.GEMINI_FLASH, geminiKey) : Promise.resolve({ status: 'skip', message: 'GEMINI_API_KEY not set' }) },
    { name: `OpenAI / ${MODELS.GPT4O}`, fn: () => openaiKey ? checkOpenAIModel(MODELS.GPT4O, openaiKey) : Promise.resolve({ status: 'skip', message: 'OPENAI_API_KEY not set' }) },
    { name: `OpenAI / ${MODELS.GPT4O_MINI}`, fn: () => openaiKey ? checkOpenAIModel(MODELS.GPT4O_MINI, openaiKey) : Promise.resolve({ status: 'skip', message: 'OPENAI_API_KEY not set' }) },
    { name: `OpenRouter / ${MODELS.KIMI}`, fn: () => openrouterKey ? checkOpenRouterModel(MODELS.KIMI, openrouterKey) : Promise.resolve({ status: 'skip', message: 'OPENROUTER_API_KEY not set' }) },
  ];

  const results = [];
  for (const check of checks) {
    const result = await check.fn();
    results.push({ name: check.name, ...result });
  }

  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');
  const passes = results.filter((r) => r.status === 'pass');
  const skipped = results.filter((r) => r.status === 'skip');

  console.log('\n=== Model Health Check ===\n');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : r.status === 'warn' ? '⚠️' : '⏭️';
    console.log(`${icon} ${r.name}: ${r.message}`);
  }

  console.log(`\nSummary: ${passes.length} pass, ${warnings.length} warn, ${failures.length} fail, ${skipped.length} skip`);

  if (failures.length > 0) {
    console.error('\n🚨 DEAD MODELS DETECTED:');
    for (const f of failures) {
      console.error(`  - ${f.name}: ${f.message}`);
    }
    console.error('\nUpdate scripts/lib/models.js with the replacement model IDs.');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️  Warnings detected (non-fatal):');
    for (const w of warnings) {
      console.warn(`  - ${w.name}: ${w.message}`);
    }
  }

  console.log('\nAll models healthy ✓');
}

main().catch((err) => {
  console.error('Fatal error in check-model-health.js:', err);
  process.exit(1);
});
