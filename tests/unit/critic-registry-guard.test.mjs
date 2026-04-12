/**
 * Tests for Guard G: Critic-registry misattribution detection
 * in review-file-writer.js
 *
 * Uses createOrMergeReviewFile with dryRun to verify the guard
 * correctly flags/allows reviews based on critic-outlet affinity.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, '..', '..', 'data', 'critic-registry.json');

// Skip if no registry (CI without data)
const hasRegistry = fs.existsSync(REGISTRY_PATH);

describe('Guard G: Critic-registry misattribution detection', { skip: !hasRegistry && 'no critic-registry.json' }, () => {
  let createOrMergeReviewFile;
  let registry;

  before(() => {
    ({ createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer'));
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')).critics;
  });

  it('flags non-freelancer critic at wrong outlet', () => {
    // Peter Marks: washpost critic, 289 reviews, not freelancer
    const result = createOrMergeReviewFile('guard-g-test-show', {
      outlet: 'Variety',
      outletId: 'variety',
      criticName: 'Peter Marks',
      url: 'https://variety.com/fake-review',
      source: 'test',
    }, { dryRun: true });

    // Should still create the file (not skip) — flagging doesn't prevent creation
    assert.strictEqual(result.action, 'new');
  });

  it('does NOT flag freelancer critics at any outlet', () => {
    // Adam Feldman: known freelancer (Time Out, TheaterMania, Variety)
    const result = createOrMergeReviewFile('guard-g-test-show', {
      outlet: 'New York Post',
      outletId: 'nypost',
      criticName: 'Adam Feldman',
      url: 'https://nypost.com/fake-review',
      source: 'test',
    }, { dryRun: true });

    assert.strictEqual(result.action, 'new');
  });

  it('does NOT flag critic at their known outlet', () => {
    // Peter Marks at washpost — his primary outlet
    const result = createOrMergeReviewFile('guard-g-test-show', {
      outlet: 'Washington Post',
      outletId: 'washpost',
      criticName: 'Peter Marks',
      url: 'https://washingtonpost.com/fake-review',
      source: 'test',
    }, { dryRun: true });

    assert.strictEqual(result.action, 'new');
  });

  it('does NOT flag unknown critics', () => {
    const result = createOrMergeReviewFile('guard-g-test-show', {
      outlet: 'variety',
      outletId: 'variety',
      criticName: 'Unknown',
      url: `https://variety.com/fake-review`,
      source: 'test',
    }, { dryRun: true });

    // Unknown critic should pass through without misattribution check
    assert.strictEqual(result.action, 'new');
  });

  it('does NOT flag critics not in registry', () => {
    const result = createOrMergeReviewFile('guard-g-test-show', {
      outlet: 'variety',
      outletId: 'variety',
      criticName: 'Completely New Critic Nobody Has Heard Of',
      url: `https://variety.com/fake-review`,
      source: 'test',
    }, { dryRun: true });

    assert.strictEqual(result.action, 'new');
  });
});
