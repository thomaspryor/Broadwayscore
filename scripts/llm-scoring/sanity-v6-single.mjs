/**
 * Sprint 1 sanity check (NOT part of permanent codebase — delete after Sprint 2).
 *
 * Single Gemini call against a real 5/5 review using V6 anchored prompt.
 * Confirms: (a) prompt is well-formed, (b) JSON parses, (c) score within band.
 *
 * Run: node scripts/llm-scoring/sanity-v6-single.mjs
 */
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const { starToBand, buildSystemPromptV6, buildPromptV6 } = require('./config');

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not set');
  process.exit(2);
}

const reviewPath = '/Users/tompryor/Broadwayscore/data/review-texts/burlesque-west-end-2026/london-theatre--anya-ryan.json';
const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));

const band = starToBand(5, 5);
const systemPrompt = buildSystemPromptV6(band, '5/5');
const userPrompt = buildPromptV6(
  review.fullText,
  `Show: Burlesque at Savoy Theatre (West End)\nOutlet: London Theatre\nCritic: Anya Ryan\nOriginal Rating: 5/5`
);

console.log('--- Band:', JSON.stringify(band));
console.log('--- System prompt:', systemPrompt.length, 'chars');
console.log('--- User prompt:', userPrompt.length, 'chars');

const t0 = Date.now();
const r = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${systemPrompt}\n\n---\n\n${userPrompt}` }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096, temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } }
    })
  }
);
const ms = Date.now() - t0;
const data = await r.json();
const finishReason = data.candidates?.[0]?.finishReason;
const usage = data.usageMetadata;
const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
console.log(`--- Gemini response (${ms}ms, finishReason=${finishReason}, in=${usage?.promptTokenCount} out=${usage?.candidatesTokenCount} thoughts=${usage?.thoughtsTokenCount}) ---`);
console.log(raw);

let parsed;
try { parsed = JSON.parse(raw); } catch (e) { console.error('\nPARSE FAILED:', e.message); process.exit(1); }

console.log('\n--- Parsed ---');
console.log(JSON.stringify(parsed, null, 2));

const score = parsed.score;
const inBand = typeof score === 'number' && score >= band.floor && score <= band.ceiling;
console.log('\n--- Verdict ---');
console.log(`score=${score}, band=[${band.floor},${band.ceiling}], in_band=${inBand}`);
console.log(`bucket=${parsed.bucket}, confidence=${parsed.confidence}`);
if (!inBand) {
  console.log('FAIL: score outside band — V6 prompt is not effectively constraining the model');
  process.exit(1);
}
console.log('OK — V6 prompt parseable + score within band');
