/**
 * Regression test: input-builder.ts must emit the correct market label for
 * each category value. Missing/undefined category falls through to "Broadway"
 * by design, but the ensemble-scorer was failing to PASS category through,
 * so every WE review got "(Broadway)" in its context and the LLM rejected
 * them as wrong_production.
 *
 * See Notion 34b637c5-416f-81ad-8afb-e39b9de9e926.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.TS_NODE_PROJECT = new URL('../../scripts/tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const { buildScoringInput } = require('../../scripts/llm-scoring/input-builder');

function baseReview(overrides = {}) {
  return {
    showId: 'test-show-2026',
    showTitle: 'Test Show',
    outletId: 'nytimes',
    outlet: 'The New York Times',
    criticName: 'Test Critic',
    publishDate: '2026-04-01',
    fullText: 'This is a substantial review of the production. '.repeat(20),
    ...overrides,
  };
}

describe('input-builder — market label derivation from category', () => {
  test('category="west-end" emits "(West End)"', () => {
    const input = buildScoringInput(baseReview({ category: 'west-end', venue: 'Lyric Theatre' }));
    assert.ok(
      input.context.includes('(West End)'),
      `expected "(West End)" in context, got:\n${input.context}`
    );
    assert.ok(
      !input.context.includes('(Broadway)'),
      `unexpected "(Broadway)" in context for west-end show:\n${input.context}`
    );
  });

  test('category="off-west-end" emits "(Off-West End)"', () => {
    const input = buildScoringInput(baseReview({ category: 'off-west-end', venue: 'Bush Theatre' }));
    assert.ok(
      input.context.includes('(Off-West End)'),
      `expected "(Off-West End)" in context, got:\n${input.context}`
    );
  });

  test('category="off-broadway" emits "(Off-Broadway)"', () => {
    const input = buildScoringInput(baseReview({ category: 'off-broadway', venue: 'Public Theater' }));
    assert.ok(
      input.context.includes('(Off-Broadway)'),
      `expected "(Off-Broadway)" in context, got:\n${input.context}`
    );
  });

  test('category="broadway" emits "(Broadway)"', () => {
    const input = buildScoringInput(baseReview({ category: 'broadway', venue: 'Music Box Theatre' }));
    assert.ok(
      input.context.includes('(Broadway)'),
      `expected "(Broadway)" in context, got:\n${input.context}`
    );
  });

  test('venue is emitted in the Show line alongside the market label', () => {
    const input = buildScoringInput(baseReview({ category: 'west-end', venue: 'National Theatre (Dorfman)' }));
    assert.ok(
      input.context.includes('at National Theatre (Dorfman)'),
      `expected "at National Theatre (Dorfman)" in context, got:\n${input.context}`
    );
  });

  test('missing category falls through to "(Broadway)" default — documented behavior', () => {
    // This is the failure mode: when ensemble-scorer didn't pass category, every
    // review got "(Broadway)". The fix is upstream (pass category correctly), but
    // the fallback itself is acceptable as long as callers populate category for
    // non-Broadway shows.
    const input = buildScoringInput(baseReview({ venue: 'Lyric Theatre' }));
    assert.ok(
      input.context.includes('(Broadway)'),
      `expected "(Broadway)" default in context, got:\n${input.context}`
    );
  });
});
