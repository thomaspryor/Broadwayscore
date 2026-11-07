/**
 * Structural guard for the allowlist-omission class (BRO-6000 follow-up).
 * prepareScoringInput copies an explicit list of fields from the review file
 * into ReviewInputData; a field input-builder reads but the copy omits is a
 * silent no-op (category/venue, type, priorRuns, contentTier, the split markers).
 * Instead of one hand-written parity test per field, this reads the
 * ReviewInputData interface and requires every field to be forwarded in
 * prepareScoringInput, or to be listed in EXCERPT_FIELDS (copied in a loop).
 * Adding a field to the interface without forwarding it fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EXCERPT_FIELDS } = require('../../scripts/lib/excerpt-fields');

const root = path.join(__dirname, '..', '..');
const builder = fs.readFileSync(path.join(root, 'scripts/llm-scoring/input-builder.ts'), 'utf8');
const scorer = fs.readFileSync(path.join(root, 'scripts/llm-scoring/ensemble-scorer.ts'), 'utf8');

function interfaceFields(src: string): string[] {
  const start = src.indexOf('export interface ReviewInputData');
  assert.ok(start >= 0, 'ReviewInputData interface not found');
  const end = src.indexOf('\n}', start);
  return [...src.slice(start, end).matchAll(/^\s{2}([A-Za-z]+)\??:/gm)].map((m) => m[1]);
}

function forwardedKeys(src: string): Set<string> {
  const start = src.indexOf('const reviewData: ReviewInputData = {');
  assert.ok(start >= 0, 'reviewData literal not found in prepareScoringInput');
  const end = src.indexOf('buildScoringInput(reviewData)', start);
  const body = src.slice(start, end).replace(/\/\/.*$/gm, '');
  return new Set([...body.matchAll(/^\s{6}([A-Za-z]+):/gm)].map((m) => m[1]));
}

test('every ReviewInputData field is forwarded by prepareScoringInput', () => {
  const fields = interfaceFields(builder);
  assert.ok(fields.length > 20, 'interface parse looks wrong: ' + fields.length);
  const forwarded = forwardedKeys(scorer);
  const excerpts = new Set<string>(EXCERPT_FIELDS);
  const missing = fields.filter((f) => !forwarded.has(f) && !excerpts.has(f));
  assert.deepEqual(missing, [], 'prepareScoringInput does not forward: ' + missing.join(', '));
});

test('the guard itself sees the split markers and a known excerpt field', () => {
  assert.ok(interfaceFields(builder).includes('multiShowSplitChild'));
  assert.ok(forwardedKeys(scorer).has('multiShowSplitParent'));
  assert.ok(new Set<string>(EXCERPT_FIELDS).has('bwwExcerpt'));
});
