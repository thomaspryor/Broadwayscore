#!/usr/bin/env node
/**
 * content-verifier-model-sweep.js
 *
 * Systematically benchmarks the content-verifier decision across multiple
 * LLM providers/models using the same 30-case golden fixture. Reports
 * precision / recall / FP rate / per-call cost / p50 latency for each.
 *
 * This is a BENCHMARK tool, not production code. It duplicates the verifier
 * prompt inline so we can swap models without touching content-verifier.js.
 * When we decide a winner, the prod verifier gets updated separately.
 *
 * Usage:
 *   node scripts/evals/content-verifier-model-sweep.js
 *   node scripts/evals/content-verifier-model-sweep.js --models gemini,gpt-4o
 *   node scripts/evals/content-verifier-model-sweep.js --concurrency 4 --json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { GEMINI_FLASH, GPT4O_MINI, GPT4O, KIMI, CLAUDE_HAIKU, CLAUDE_SONNET, CLAUDE_OPUS } = require('../lib/models');

const FIXTURE = path.join(
  __dirname, '..', '..',
  'tests', 'fixtures', 'content-verifier-golden', 'real-world-fixtures.json'
);

// Token pricing as of 2026-Q1 (USD per 1M tokens). Update if vendors change.
const MODELS = {
  'gemini-2-flash': {
    provider: 'google',
    api: 'google',
    model: GEMINI_FLASH,
    priceIn: 0.10, priceOut: 0.40,
    envKey: 'GEMINI_API_KEY',
  },
  'gpt-4o-mini': {
    provider: 'openai',
    api: 'openai',
    model: GPT4O_MINI,
    priceIn: 0.15, priceOut: 0.60,
    envKey: 'OPENAI_API_KEY',
  },
  'gpt-4o': {
    provider: 'openai',
    api: 'openai',
    model: GPT4O,
    priceIn: 2.50, priceOut: 10.00,
    envKey: 'OPENAI_API_KEY',
  },
  'kimi-k2.5': {
    provider: 'moonshotai',
    api: 'openrouter',
    model: KIMI,
    priceIn: 0.15, priceOut: 2.50,
    envKey: 'OPENROUTER_API_KEY',
  },
  'claude-haiku-4-5': {
    provider: 'anthropic',
    api: 'anthropic',
    model: CLAUDE_HAIKU,
    priceIn: 1.00, priceOut: 5.00,
    envKey: 'ANTHROPIC_API_KEY',
  },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    api: 'anthropic',
    model: CLAUDE_SONNET,
    priceIn: 3.00, priceOut: 15.00,
    envKey: 'ANTHROPIC_API_KEY',
  },
  'claude-opus-4-7': {
    provider: 'anthropic',
    api: 'anthropic',
    model: CLAUDE_OPUS,
    priceIn: 15.00, priceOut: 75.00,
    envKey: 'ANTHROPIC_API_KEY',
  },
};

function parseArgs(argv) {
  const args = { concurrency: 4, json: false, models: Object.keys(MODELS) };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--json') args.json = true;
    else if (a === '--concurrency') args.concurrency = parseInt(list[++i]);
    else if (a === '--models') args.models = list[++i].split(',');
  }
  return args;
}

// ---------------- Prompt (copy of content-verifier.js logic) ---------------

const MARKETS = {
  'broadway':     { label: 'Broadway',     description: 'shows performed in Broadway theaters in New York City', dateLabel: 'Broadway opening date', venueLabel: 'Broadway venue', wrongProdExamples: ['National tour, touring production, touring company, "on tour"', 'Regional theater (Ahmanson, Kennedy Center, Old Globe, Goodman, etc.)', 'Off-Broadway or Off-Off-Broadway venue', 'West End / London production', 'Pre-Broadway tryout or out-of-town engagement'] },
  'west-end':     { label: 'West End',     description: 'shows performed in West End theaters in London', dateLabel: 'West End opening date', venueLabel: 'West End venue', wrongProdExamples: ['UK touring production, "on tour"', 'Regional UK theater (not a West End venue)', 'Broadway / New York production', 'Edinburgh Fringe or other festival', 'Pre-West End tryout or transfer preview'] },
  'off-west-end': { label: 'Off-West End', description: 'shows performed in Off-West End theaters in London', dateLabel: 'Off-West End opening date', venueLabel: 'Off-West End venue', wrongProdExamples: ['UK touring production, "on tour"', 'Regional UK theater (not a London venue)', 'Broadway / New York production', 'Edinburgh Fringe or other festival', 'Pre-West End tryout or transfer preview'] },
  'off-broadway': { label: 'Off-Broadway', description: 'shows performed in Off-Broadway theaters in New York City', dateLabel: 'Off-Broadway opening date', venueLabel: 'Off-Broadway venue', wrongProdExamples: ['Broadway production (different from Off-Broadway run)', 'National tour, touring production', 'Regional theater production', 'West End / London production'] },
};

function buildPrompt(input) {
  const { scrapedText, excerpt, showTitle, outletName, criticName, openingDate, venue, market, publishDate } = input;
  const mc = MARKETS[market || 'broadway'] || MARKETS['broadway'];
  const dateContext = openingDate ? `\n- ${mc.dateLabel}: ${openingDate}` : '';
  const publishDateContext = publishDate ? `\n- Review publish date: ${publishDate}` : '';
  const venueContext = venue ? `\n- ${mc.venueLabel}: ${venue}` : '';
  const excerptContext = excerpt ? `\n- Known excerpt: "${excerpt.substring(0, 300)}"` : '';
  const wrongProdList = mc.wrongProdExamples.map(e => `   - ${e}`).join('\n');

  return `You are a content verification assistant for a theater review aggregator. Verify reviews of **${mc.label}** productions (${mc.description}).

**Expected Review:**
- Show: "${showTitle}"
- Market: ${mc.label}
- Outlet: ${outletName}
- Critic: ${criticName || 'Unknown'}${dateContext}${publishDateContext}${venueContext}${excerptContext}

**Scraped Content (first 2500 chars):**
${scrapedText.substring(0, 2500)}

Respond with ONLY valid JSON:
{"isValid": true/false, "confidence": "high"/"medium"/"low", "wrongArticle": true/false, "wrongProduction": true/false, "isFilmTv": true/false, "truncated": true/false, "issues": [], "reasoning": ""}

**Checks:**
1. Article type: Is this a REVIEW (critic's assessment after seeing the show), not preview/interview/news/box-office/listicle?
2. Wrong production: Is this reviewing a NON-${mc.label} production? Red flags:
${wrongProdList}
   **YEAR/PRODUCTION MATCHING (most common failure):** showTitle may contain a year (e.g. "Cats 1982", "Art 1998"). Many shows have revivals. DO NOT assume the review matches the year just because the show name matches. Cross-check: does the content describe that specific year's production (venue, cast, opening year)? If showTitle says "Cats 1982" but review describes Neil Simon Theatre (2016 revival), that is wrongProduction. If showTitle says "Art 1998" and review mentions Cannavale/NPH/Corden (2025 cast), that is wrongProduction. If publishDate is >2 years from showTitle year, strong signal of wrong production. DO NOT hallucinate cast/venue to match the showTitle — only use facts from the text.
3. Film/TV: Is this about a film/TV version, not the live stage production?
4. Truncation: Does the text end mid-sentence or hit a paywall?
5. Junk: Mostly navigation/footer?

Set isValid=true ONLY if it is a review of the ${mc.label} production and is not truncated/junk.`;
}

// ---------------- Provider callers ----------------------------------------

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callGoogle(modelSpec, prompt) {
  const { statusCode, body } = await httpPost(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelSpec.model}:generateContent?key=${process.env[modelSpec.envKey]}`,
    { 'Content-Type': 'application/json' },
    JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    })
  );
  if (statusCode !== 200) throw new Error(`google ${statusCode}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const usage = json.usageMetadata || {};
  return { text, inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 };
}

async function callOpenAIStyle(modelSpec, prompt, baseUrl = 'https://api.openai.com/v1/chat/completions', extraHeaders = {}) {
  const { statusCode, body } = await httpPost(
    baseUrl,
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env[modelSpec.envKey]}`, ...extraHeaders },
    JSON.stringify({
      model: modelSpec.model,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    })
  );
  if (statusCode !== 200) throw new Error(`openai-style ${statusCode}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  const text = json.choices?.[0]?.message?.content || '';
  const usage = json.usage || {};
  return { text, inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0 };
}

async function callOpenAI(modelSpec, prompt) { return callOpenAIStyle(modelSpec, prompt); }
async function callOpenRouter(modelSpec, prompt) {
  return callOpenAIStyle(modelSpec, prompt, 'https://openrouter.ai/api/v1/chat/completions', {
    'HTTP-Referer': 'https://broadwayscorecard.com',
    'X-Title': 'Broadway Scorecard eval',
  });
}

async function callAnthropic(modelSpec, prompt) {
  const { statusCode, body } = await httpPost(
    'https://api.anthropic.com/v1/messages',
    { 'Content-Type': 'application/json', 'x-api-key': process.env[modelSpec.envKey], 'anthropic-version': '2023-06-01' },
    JSON.stringify({
      model: modelSpec.model,
      max_tokens: 1024,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    })
  );
  if (statusCode !== 200) throw new Error(`anthropic ${statusCode}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  const text = json.content?.[0]?.text || '';
  const usage = json.usage || {};
  return { text, inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 };
}

async function callModel(modelKey, prompt) {
  const spec = MODELS[modelKey];
  const start = Date.now();
  let result;
  if (spec.api === 'google')      result = await callGoogle(spec, prompt);
  else if (spec.api === 'openai') result = await callOpenAI(spec, prompt);
  else if (spec.api === 'openrouter') result = await callOpenRouter(spec, prompt);
  else if (spec.api === 'anthropic')  result = await callAnthropic(spec, prompt);
  else throw new Error(`unknown api: ${spec.api}`);
  result.latencyMs = Date.now() - start;
  return result;
}

function parseResponse(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); } catch { return null; }
}

// ---------------- Benchmark runner ----------------------------------------

async function runModelOnFixture(modelKey, cases, concurrency) {
  const out = new Array(cases.length);
  let idx = 0;
  let totalInTokens = 0, totalOutTokens = 0, totalLatency = 0, failures = 0;

  async function worker() {
    while (idx < cases.length) {
      const i = idx++;
      const c = cases[i];
      process.stderr.write(`[${modelKey} ${i + 1}/${cases.length}]\n`);
      try {
        const prompt = buildPrompt(c.input);
        const { text, inputTokens, outputTokens, latencyMs } = await callModel(modelKey, prompt);
        const parsed = parseResponse(text);
        totalInTokens += inputTokens;
        totalOutTokens += outputTokens;
        totalLatency += latencyMs;
        out[i] = {
          caseId: c.id,
          expectedValid: !!c.expected.isValid,
          predictedValid: parsed ? !!parsed.isValid : null,
          rawResponse: text.slice(0, 300),
          parsed,
          inputTokens, outputTokens, latencyMs,
        };
      } catch (err) {
        failures++;
        out[i] = { caseId: c.id, error: err.message, expectedValid: !!c.expected.isValid, predictedValid: null };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Metrics
  let tp = 0, tn = 0, fp = 0, fn = 0, parsed = 0;
  for (const r of out) {
    if (r.predictedValid == null) continue;
    parsed++;
    if (r.expectedValid && r.predictedValid) tp++;
    else if (!r.expectedValid && !r.predictedValid) tn++;
    else if (!r.expectedValid && r.predictedValid) fp++;
    else fn++;
  }
  const precision = (tp + fp) ? tp / (tp + fp) : 0;
  const recall = (tp + fn) ? tp / (tp + fn) : 0;
  const accuracy = parsed ? (tp + tn) / parsed : 0;
  const fpRate = (fp + tn) ? fp / (fp + tn) : 0;
  const spec = MODELS[modelKey];
  const costPerCall = (totalInTokens / 1e6) * spec.priceIn + (totalOutTokens / 1e6) * spec.priceOut;
  const costPerCallAvg = parsed ? costPerCall / parsed : 0;

  return {
    model: modelKey,
    failures,
    parsed,
    tp, tn, fp, fn,
    precision, recall, accuracy, fpRate,
    avgInputTokens: parsed ? Math.round(totalInTokens / parsed) : 0,
    avgOutputTokens: parsed ? Math.round(totalOutTokens / parsed) : 0,
    costPerCall: costPerCallAvg,
    p50LatencyMs: Math.round(totalLatency / (parsed || 1)),
    caseResults: out,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  // Filter models by available API keys
  const runnable = args.models.filter(m => {
    const spec = MODELS[m];
    if (!spec) { console.error(`Unknown model: ${m}`); return false; }
    if (!process.env[spec.envKey]) { console.error(`Skipping ${m}: ${spec.envKey} not set`); return false; }
    return true;
  });

  if (runnable.length === 0) {
    console.error('No runnable models. Set at least one of: ' + Array.from(new Set(Object.values(MODELS).map(m => m.envKey))).join(', '));
    process.exit(1);
  }

  console.error(`Running ${fixture.cases.length} cases × ${runnable.length} models (${runnable.join(', ')})`);
  console.error(`Estimated max cost: ~$${(fixture.cases.length * runnable.length * 0.04).toFixed(2)}`);

  const results = [];
  for (const m of runnable) {
    results.push(await runModelOnFixture(m, fixture.cases, args.concurrency));
  }

  if (args.json) {
    console.log(JSON.stringify({ fixture: path.basename(FIXTURE), results }, null, 2));
    return;
  }

  // Pretty table
  console.log('\n' + '='.repeat(100));
  console.log('Content Verifier — Model Sweep');
  console.log('='.repeat(100));
  const header = ['Model', 'TP', 'TN', 'FP', 'FN', 'Prec', 'Recall', 'Acc', 'FP-Rate', '$/call', '$/45k/yr', 'p50ms'];
  const widths = [22, 3, 3, 3, 3, 6, 6, 6, 7, 9, 10, 7];
  console.log(header.map((h, i) => h.padEnd(widths[i])).join(' '));
  console.log('-'.repeat(100));
  for (const r of results) {
    const row = [
      r.model,
      r.tp, r.tn, r.fp, r.fn,
      (r.precision * 100).toFixed(1) + '%',
      (r.recall * 100).toFixed(1) + '%',
      (r.accuracy * 100).toFixed(1) + '%',
      (r.fpRate * 100).toFixed(1) + '%',
      '$' + r.costPerCall.toFixed(5),
      '$' + (r.costPerCall * 45000).toFixed(0),
      r.p50LatencyMs,
    ];
    console.log(row.map((v, i) => String(v).padEnd(widths[i])).join(' '));
  }
  console.log('-'.repeat(100));
  console.log(`Total cost of this sweep: $${results.reduce((a, r) => a + r.costPerCall * r.parsed, 0).toFixed(3)}`);
  console.log('');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(2); });
}
