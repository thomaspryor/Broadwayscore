/**
 * Mini-sample: tepid 5★ stress test (Sprint 2 follow-up)
 *
 * Picks 15 5/5-rated reviews where V5 LLM scored 80-88 (i.e., the LLM thought
 * the prose was less rapturous than the critic's star rating). Re-scores them
 * with V6 anchored mode (band [91,100]) to verify V6 can actually use the
 * floor (91-93) for tepid 5★s — addresses Stuart's "all 5★ are not the same"
 * complaint directly.
 *
 * Read-only. No writes to data/review-texts. Outputs to claude-outputs/.
 *
 * Run: npx ts-node scripts/llm-scoring/tepid-5star-sample.mjs
 */
import { createRequire } from 'module';
import * as fs from 'fs';
const require = createRequire(import.meta.url);

process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

// Load env from main repo
const envText = fs.readFileSync('/Users/tompryor/Broadwayscore/.env', 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { starToBand } = require('./config');
const { EnsembleReviewScorer } = require('./ensemble-scorer');

const candidates = JSON.parse(fs.readFileSync('/tmp/tepid-5star-candidates.json', 'utf8'));
console.log(`Scoring ${candidates.length} tepid 5★ candidates with V6 anchored mode...\n`);

// Kimi off (slow / hangs in band-anchored mode per Sprint 2 finding)
const ensemble = new EnsembleReviewScorer(
  process.env.ANTHROPIC_API_KEY,
  process.env.OPENAI_API_KEY,
  process.env.GEMINI_API_KEY,
  undefined,
  { verbose: false }
);

const band = starToBand(5, 5);
const results = [];
for (const c of candidates) {
  const review = JSON.parse(fs.readFileSync(c.path, 'utf8'));
  const context = `Show: ${review.showTitle || c.path.split('/').slice(-2)[0]}\nOutlet: ${c.outlet}\nCritic: ${c.critic}\nOriginal Rating: ${c.raw}`;
  const t0 = Date.now();
  try {
    const TIMEOUT_MS = 90_000;
    const result = await Promise.race([
      ensemble.scoreReview(review.fullText, context, band, c.raw),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
    ]);
    const ms = Date.now() - t0;
    const newScore = result.rejected ? null : result.score;
    results.push({ ...c, newScore, newBucket: result.bucket, confidence: result.confidence, verdict: result.verdict, reasoning: result.reasoning, keyQuote: result.keyQuote, ms });
    console.log(`  ${c.outlet.padEnd(20)} critic=${(c.critic || '?').padEnd(22)} V5_llm=${c.llm}  →  V6=${newScore}  (${ms}ms)`);
  } catch (e) {
    results.push({ ...c, newScore: null, errorReason: String(e.message || e) });
    console.log(`  ${c.outlet.padEnd(20)} ERROR: ${e.message}`);
  }
}

const out = '/Users/tompryor/Documents/claude-outputs/anchored-bands/tepid-5star-results.json';
fs.writeFileSync(out, JSON.stringify(results, null, 2));

const scored = results.filter(r => r.newScore !== null).map(r => r.newScore);
const min = Math.min(...scored);
const max = Math.max(...scored);
const mean = scored.reduce((a, b) => a + b, 0) / scored.length;
const stdev = Math.sqrt(scored.reduce((s, x) => s + (x - mean) ** 2, 0) / scored.length);
const at91to93 = scored.filter(s => s >= 91 && s <= 93).length;
const at100 = scored.filter(s => s === 100).length;

console.log('\n=== Tepid 5★ stress-test results ===');
console.log(`n=${scored.length}/${candidates.length}`);
console.log(`min=${min}, max=${max}, mean=${mean.toFixed(1)}, stdev=${stdev.toFixed(1)}`);
console.log(`hits 91-93: ${at91to93}  |  hits 100: ${at100}`);
console.log(`Wrote: ${out}`);
