// BRO-985: Reddit sentiment classifier over-labels mild/comparative comments
// as negative. This suite has two layers:
//
//   1. Deterministic prompt/filter checks (always run, no API key or data-repo
//      state needed — both dependencies are pure scripts/lib/ modules) — guard
//      the actual instruction text and the owner-comment exclusion so a future
//      prompt edit can't silently regress them.
//   2. A live-LLM accuracy check against the 50-comment hand-labeled golden
//      fixture (scripts/lib/buzz-classifier-golden.json), using the SAME
//      starting provider ('gemini') that scrape-reddit-sentiment.js hardcodes
//      in production — so a passing eval says something about production
//      behavior, not just about whichever provider happens to be cheapest in
//      this shell. Skipped when no classifier API key is available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildPrompt, classifyBatch } = require('./buzz-classifier.js');
const { isOwnerComment } = require('./reddit-post-filters.js');

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

test('prompt tells the model comparative framing is not automatically negative, and is consistent with the relevance gate', () => {
  const prompt = buildPrompt('Fallen Angels', [{ body: 'test comment' }]);
  assert.match(prompt, /COMPARATIVE COMMENTS/i);
  assert.match(prompt, /is NOT evidence of negative sentiment/i);
  // Regression guard: an earlier draft told the model to score sentiment for
  // comparative comments while the relevance gate still said ANY mention of a
  // different show by name was categorically not relevant — two contradictory
  // instructions for the same input. The relevance-gate text must now scope
  // that exclusion to comments with NO independent reaction to the target show.
  assert.match(prompt, /ONLY about a DIFFERENT show by name, with no independent reaction/i);
});

test('prompt tells the model lukewarm/mild comments are mixed/neutral and this overrides the positive tiebreak', () => {
  const prompt = buildPrompt('Fallen Angels', [{ body: 'test comment' }]);
  assert.match(prompt, /LUKEWARM \/ MILD COMMENTS ARE MIXED OR NEUTRAL/i);
  assert.match(prompt, /it was fine/i);
  // Regression guard: an earlier draft added the lukewarm rule but left the
  // pre-existing "sharing the experience without complaint → positive" signal
  // and the "unsure between neutral and positive, choose positive" tiebreak
  // unqualified, so the two instructions fought over the same inputs ("it was
  // fine", "decent"). The lukewarm rule must explicitly take priority.
  assert.match(prompt, /takes PRIORITY over the POSITIVE SIGNALS rules below/i);
});

test('prompt tells the model Scorecard/aggregator-score meta discussion is not a review', () => {
  const prompt = buildPrompt('Fallen Angels', [{ body: 'test comment' }]);
  assert.match(prompt, /scoring site\/aggregator\/bot's rating/i);
});

test('isOwnerComment drops the Scorecard\'s own authored comments (not whole threads)', () => {
  assert.equal(isOwnerComment({ author: 'BroadwayScorecard', body: 'x' }), true);
  assert.equal(isOwnerComment({ author: 'bwayscorecard', body: 'x' }), true);
  assert.equal(isOwnerComment({ author: 'thomaspryor', body: 'x' }), true);
  assert.equal(isOwnerComment({ author: 'randomredditor42', body: 'x' }), false);
  assert.equal(isOwnerComment({}), false);
});

// --- Layer 2: live-LLM accuracy against the golden fixture ----------------

test('classifier accuracy on golden fixture (live LLM, gemini — matches production\'s hardcoded starting provider)', { skip: !hasApiKey && 'no classifier API key set — skipping live eval' }, async () => {
  const comments = golden.items.map((item) => ({ body: item.body, postTitle: item.postTitle, score: 1 }));
  const results = await classifyBatch(golden.showTitle, comments, 'gemini', 0, golden.showContext);

  assert.equal(results.length, golden.items.length, `classifier returned ${results.length}/${golden.items.length} results`);

  const byCategory = {};
  const misclassifiedAsNegative = [];
  const wrongRelevance = [];
  let correct = 0;

  for (let i = 0; i < golden.items.length; i++) {
    const item = golden.items[i];
    const got = results[i];
    const relevanceMatches = got.is_relevant === item.expected.is_relevant;
    const sentimentMatches = relevanceMatches && (!item.expected.is_relevant || got.sentiment === item.expected.sentiment);
    if (!relevanceMatches) wrongRelevance.push({ id: item.id, category: item.category, got: got.is_relevant, expected: item.expected.is_relevant });
    if (sentimentMatches) correct++;

    const cat = byCategory[item.category] || (byCategory[item.category] = { total: 0, correct: 0 });
    cat.total++;
    if (sentimentMatches) cat.correct++;

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

  // Per-category accuracy — catches a systematic miss in one bucket (e.g. every
  // lukewarm comment landing on "positive" instead of "mixed"/"neutral") that a
  // single blended overall-accuracy number can hide.
  for (const [cat, { total, correct: catCorrect }] of Object.entries(byCategory)) {
    const acc = catCorrect / total;
    assert.ok(acc >= 0.6, `category "${cat}" accuracy ${(acc * 100).toFixed(0)}% (${catCorrect}/${total}) < 60%`);
  }

  const accuracy = correct / golden.items.length;
  assert.ok(accuracy >= 0.7, `overall golden-fixture accuracy ${(accuracy * 100).toFixed(0)}% < 70% (wrong relevance: ${JSON.stringify(wrongRelevance)})`);
});
