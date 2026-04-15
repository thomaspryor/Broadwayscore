/**
 * Unit tests for scripts/lib/buzz-classifier.js
 *
 * These pin the pure validation helpers — classifier itself is exercised by
 * scripts/evals/buzz-classifier-eval.js (which hits the real LLM). These
 * tests are offline and safe to run in CI.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  validateClassifications,
  parseJsonArray,
  buildPrompt,
} = require('../../scripts/lib/buzz-classifier.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  __dirname, '..', 'fixtures', 'buzz-classifier-golden', 'is-relevant-cases.json'
);

describe('validateClassifications', () => {
  test('well-formed array passes', () => {
    const arr = [
      { id: 1, is_relevant: true, sentiment: 'positive' },
      { id: 2, is_relevant: false },
    ];
    const res = validateClassifications(arr);
    assert.strictEqual(res.success, true);
  });

  test('non-array fails', () => {
    assert.strictEqual(validateClassifications({}).success, false);
    assert.strictEqual(validateClassifications('not an array').success, false);
  });

  test('invalid sentiment value is rejected', () => {
    const arr = [{ id: 1, is_relevant: true, sentiment: 'spectacular' }];
    assert.strictEqual(validateClassifications(arr).success, false);
  });

  test('sentiment synonyms are normalized, not rejected', () => {
    // "amazing" is in SENTIMENT_ALIASES → maps to "enthusiastic"
    const arr = [{ id: 1, is_relevant: true, sentiment: 'amazing' }];
    const res = validateClassifications(arr);
    assert.strictEqual(res.success, true);
    assert.strictEqual(arr[0].sentiment, 'enthusiastic');
  });

  test('is_relevant must be boolean, not truthy/falsy', () => {
    const arr = [{ id: 1, is_relevant: 'true' }];
    assert.strictEqual(validateClassifications(arr).success, false);
  });

  test('id must be number, not string', () => {
    const arr = [{ id: '1', is_relevant: false }];
    assert.strictEqual(validateClassifications(arr).success, false);
  });

  test('missing sentiment on is_relevant=true is allowed (LLM omit)', () => {
    // Validator tolerates missing sentiment — caller decides downstream.
    const arr = [{ id: 1, is_relevant: true }];
    assert.strictEqual(validateClassifications(arr).success, true);
  });
});

describe('parseJsonArray', () => {
  test('clean JSON array parses', () => {
    const out = parseJsonArray('[{"id":1,"is_relevant":false}]');
    assert.ok(Array.isArray(out));
    assert.strictEqual(out.length, 1);
  });

  test('markdown-fenced JSON parses', () => {
    const out = parseJsonArray('```json\n[{"id":1,"is_relevant":false}]\n```');
    assert.ok(Array.isArray(out));
  });

  test('garbage returns null', () => {
    const out = parseJsonArray('not json at all');
    assert.strictEqual(out, null);
  });
});

describe('buildPrompt', () => {
  test('includes show title and comment bodies', () => {
    const p = buildPrompt('Wicked', [{ id: 1, body: 'I saw it!' }]);
    assert.ok(p.includes('Wicked'));
    assert.ok(p.includes('I saw it!'));
  });

  test('includes attendance-past-tense rule (regression — prompt must not drift)', () => {
    // This prompt instruction is the one that prevents the LLM from
    // marking "I'm going to see it" as relevant. If the rule disappears
    // the test fails — forcing the committer to review deliberately.
    const p = buildPrompt('Wicked', [{ id: 1, body: 'test' }]);
    assert.ok(/past tense/i.test(p), 'prompt must enforce past-tense attendance requirement');
  });

  test('includes explicit-schema retry mode when requested', () => {
    const p = buildPrompt('Wicked', [{ id: 1, body: 'test' }], true);
    assert.ok(p.includes('MUST respond'));
  });
});

describe('golden fixture (is-relevant-cases.json) integrity', () => {
  test('fixture exists and all cases have required fields', () => {
    const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    assert.ok(Array.isArray(f.cases));
    assert.ok(f.cases.length >= 20, 'need at least 20 cases to cover decision boundary');
    for (const c of f.cases) {
      assert.ok(typeof c.id === 'number', `case ${c.id} missing numeric id`);
      assert.ok(typeof c.body === 'string', `case ${c.id} missing body`);
      assert.ok(c.expected && typeof c.expected.is_relevant === 'boolean', `case ${c.id} missing expected.is_relevant`);
      assert.ok(typeof c.rationale === 'string' && c.rationale.length > 0, `case ${c.id} missing rationale`);
      if (c.expected.is_relevant) {
        assert.ok(['enthusiastic', 'positive', 'mixed', 'negative', 'neutral'].includes(c.expected.sentiment), `case ${c.id} invalid sentiment`);
      }
    }
  });

  test('fixture covers each sentiment class at least once', () => {
    const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const seen = new Set();
    for (const c of f.cases) if (c.expected.is_relevant) seen.add(c.expected.sentiment);
    // neutral is rare (<5% per prompt) so not required; others required.
    for (const s of ['enthusiastic', 'positive', 'mixed', 'negative']) {
      assert.ok(seen.has(s), `fixture missing case for sentiment="${s}"`);
    }
  });

  test('fixture covers each NOT-relevant category (boycott, future, different show, venue, meta)', () => {
    const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const notRelevantRationales = f.cases.filter(c => !c.expected.is_relevant).map(c => c.rationale.toLowerCase());
    const categories = [
      /future tense|planning to see|about to see/,
      /boycott|refuse/,
      /different show|by name/,
      /venue|logistics|usher/,
      /meta|ticket price|scheduling/,
      /source material|book/,
      /industry|cast illness/,
    ];
    for (const cat of categories) {
      assert.ok(
        notRelevantRationales.some(r => cat.test(r)),
        `fixture missing NOT-relevant category: ${cat}`
      );
    }
  });
});
