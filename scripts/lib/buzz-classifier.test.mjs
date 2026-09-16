// BRO-985: Reddit sentiment classifier over-labels mild/comparative comments
// as negative. This suite has two layers:
//
//   1. Deterministic prompt/filter checks (always run, no API key needed) —
//      guard the actual instruction text and the owner-post exclusion so a
//      future prompt edit can't silently regress them.
//   2. A live-LLM accuracy check against the 50-comment hand-labeled golden
//      fixture (scripts/lib/buzz-classifier-golden.json). Skipped when no
//      classifier API key is available (e.g. plain CI without secrets); runs
//      for real whenever GEMINI_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY
//      / ANTHROPIC_API_KEY is set, which is the case in this repo's CI and in
//      any dev shell with `direnv` loading .env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildPrompt, classifyBatch } = require('./buzz-classifier.js');
const { classifyPost } = require('../scrape-reddit-sentiment.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'buzz-classifier-golden.json'), 'utf8'));

const hasApiKey = !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY
  || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);

// --- Layer 1: deterministic prompt/filter checks -------------------------

test('golden fixture: 50 items covering the four BRO-985 categories', () => {
  assert.equal(golden.items.length, 50, `expected 50 golden items, got ${golden.items.length}`);
  for (const cat of ['comparative', 'lukewarm', 'scorecard_meta', 'negative', 'positive']) {
    const n = golden.items.filter((i) => i.category === cat).length;
    assert.ok(n >= 5, `expected >=5 "${cat}" items, got ${n}`);
  }
  for (const item of golden.items) {
    assert.ok(typeof item.expected.is_relevant === 'boolean', `item ${item.id}: missing expected.is_relevant`);
    if (item.expected.is_relevant) {
      assert.ok(item.expected.sentiment, `item ${item.id}: relevant item missing expected.sentiment`);
    }
  }
});

test('prompt requires EXPLICIT dislike before labeling negative', () => {
  const prompt = buildPrompt('Fallen Angels', [{ body: 'test comment' }]);
  assert.match(prompt, /EXPLICIT/i);
  assert.match(prompt, /do NOT mark it negative/i);
});

test('prompt tells the model comparative framing is not automatically negative', () => {
  const prompt = buildPrompt('Fallen Angels', [{ body: 'test comment' }]);
  assert.match(prompt, /COMPARATIVE COMMENTS/i);
  assert.match(prompt, /is NOT evidence of negative sentiment/i);
});

test('prompt tells the model lukewarm/mild comments are not negative', () => {
  const prompt = buildPrompt('Fallen Angels', [{ body: 'test comment' }]);
  assert.match(prompt, /LUKEWARM \/ MILD COMMENTS ARE NOT NEGATIVE/i);
  assert.match(prompt, /it was fine/i);
});

test('prompt tells the model Scorecard/aggregator-score meta discussion is not a review', () => {
  const prompt = buildPrompt('Fallen Angels', [{ body: 'test comment' }]);
  assert.match(prompt, /scoring site\/aggregator\/bot's rating/i);
});

test('classifyPost drops posts authored by BroadwayScorecard owner accounts', () => {
  assert.equal(
    classifyPost({ title: 'Fallen Angels reviews are in: 76/100', author: 'BroadwayScorecard' }, 'Fallen Angels'),
    false,
  );
  assert.equal(
    classifyPost({ title: 'Fallen Angels reviews are in: 76/100', author: 'bwayscorecard' }, 'Fallen Angels'),
    false,
  );
  assert.equal(
    classifyPost({ title: 'Fallen Angels reviews are in: 76/100', author: 'thomaspryor' }, 'Fallen Angels'),
    false,
  );
});

test('classifyPost still processes organic (non-owner) posts normally', () => {
  assert.notEqual(
    classifyPost({ title: 'Fallen Angels previews', author: 'randomredditor42' }, 'Fallen Angels'),
    undefined,
  );
  assert.equal(
    classifyPost({ title: 'Fallen Angels previews', author: 'randomredditor42' }, 'Fallen Angels'),
    true,
  );
});

// --- Layer 2: live-LLM accuracy against the golden fixture ----------------

test('classifier accuracy on golden fixture (live LLM)', { skip: !hasApiKey && 'no classifier API key set — skipping live eval' }, async () => {
  const comments = golden.items.map((item) => ({ body: item.body, postTitle: item.postTitle, score: 1 }));
  const results = await classifyBatch(golden.showTitle, comments, null, 0, golden.showContext);

  assert.equal(results.length, golden.items.length, `classifier returned ${results.length}/${golden.items.length} results`);

  const misclassifiedAsNegative = [];
  const wrongRelevance = [];
  let correct = 0;

  for (let i = 0; i < golden.items.length; i++) {
    const item = golden.items[i];
    const got = results[i];
    const relevanceMatches = got.is_relevant === item.expected.is_relevant;
    if (!relevanceMatches) wrongRelevance.push({ id: item.id, category: item.category, got: got.is_relevant, expected: item.expected.is_relevant });

    if (relevanceMatches && (!item.expected.is_relevant || got.sentiment === item.expected.sentiment)) {
      correct++;
    }

    // The core BRO-985 regression check: comparative/lukewarm/meta comments that
    // are NOT genuinely negative must never come back labeled "negative".
    const shouldNeverBeNegative = ['comparative', 'lukewarm', 'scorecard_meta'].includes(item.category)
      && item.expected.sentiment !== 'negative';
    if (shouldNeverBeNegative && got.is_relevant && got.sentiment === 'negative') {
      misclassifiedAsNegative.push({ id: item.id, category: item.category, body: item.body });
    }
  }

  const overCountRate = misclassifiedAsNegative.length / golden.items.length;
  assert.ok(
    overCountRate <= 0.1,
    `over ${(overCountRate * 100).toFixed(0)}% of non-negative comparative/lukewarm/meta comments came back "negative": ${JSON.stringify(misclassifiedAsNegative)}`,
  );

  const accuracy = correct / golden.items.length;
  assert.ok(accuracy >= 0.7, `overall golden-fixture accuracy ${(accuracy * 100).toFixed(0)}% < 70% (wrong relevance: ${JSON.stringify(wrongRelevance)})`);
});
