/**
 * Shared bucket thresholds at their real edges — BRO-4204 audit S6-T7.
 *
 * scripts/manual-review-direct.js hardcoded a 75/30 ladder (Positive from 75,
 * Negative from 30) while the canonical scoreToBucket in
 * scripts/lib/score-extractors.js uses 83/70/55/35. A direct entry of 72 was
 * written to reviews.json as 'Mixed'; the rebuild calls 72 'Positive'.
 *
 * Uses the REAL scoreToBucket / scoreToThumb (CLAUDE.md §15) and pins the
 * call site so the ladder cannot come back.
 *
 * Run: node --test scripts/lib/score-to-bucket-boundaries.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { scoreToBucket, scoreToThumb, BUCKET_SCORES } = require('./score-extractors.js');
const helpers = require('./rebuild-helpers.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('scoreToBucket at the real edges (83 / 70 / 55 / 35)', () => {
  test('Rave from 83', () => {
    assert.equal(scoreToBucket(83), 'Rave');
    assert.equal(scoreToBucket(82), 'Positive');
    assert.equal(scoreToBucket(100), 'Rave');
  });

  test('Positive from 70 — NOT 75', () => {
    assert.equal(scoreToBucket(70), 'Positive');
    assert.equal(scoreToBucket(69), 'Mixed');
    assert.equal(scoreToBucket(72), 'Positive'); // the manual-review-direct regression value
    assert.equal(scoreToBucket(74), 'Positive');
  });

  test('Mixed from 55', () => {
    assert.equal(scoreToBucket(55), 'Mixed');
    assert.equal(scoreToBucket(54), 'Negative');
  });

  test('Negative from 35 — NOT 30', () => {
    assert.equal(scoreToBucket(35), 'Negative');
    assert.equal(scoreToBucket(34), 'Pan');
    assert.equal(scoreToBucket(31), 'Pan'); // 75/30 ladder called this Negative
    assert.equal(scoreToBucket(0), 'Pan');
  });

  test('scoreToThumb edges (70 / 55) agree with the bucket ladder', () => {
    assert.equal(scoreToThumb(70), 'Up');
    assert.equal(scoreToThumb(69), 'Flat');
    assert.equal(scoreToThumb(55), 'Flat');
    assert.equal(scoreToThumb(54), 'Down');
  });

  test('BUCKET_SCORES representative values land in their own bucket', () => {
    for (const [bucket, score] of Object.entries(BUCKET_SCORES)) {
      assert.equal(scoreToBucket(score), bucket, `${bucket}=${score}`);
    }
  });

  test('rebuild-helpers re-exports the same function (single source of truth)', () => {
    assert.equal(helpers.scoreToBucket, scoreToBucket);
    assert.equal(helpers.scoreToThumb, scoreToThumb);
  });
});

describe('call sites use the shared ladder', () => {
  test('manual-review-direct.js requires scoreToBucket and carries no hardcoded 75/30 ladder', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'manual-review-direct.js'), 'utf8');
    assert.match(src, /require\('\.\/lib\/score-extractors'\)/);
    assert.match(src, /const bucket = scoreToBucket\(score\)/);
    assert.doesNotMatch(src, /score >= 75 \? 'Positive'/);
    assert.doesNotMatch(src, /score >= 30 \? 'Negative'/);
  });

  test('score-extractors.js is the only definition of the ladder in scripts/lib', () => {
    const src = fs.readFileSync(path.join(HERE, 'score-extractors.js'), 'utf8');
    assert.match(src, /function scoreToBucket\(score\) \{\s*\n\s*if \(score >= 83\) return 'Rave';\s*\n\s*if \(score >= 70\) return 'Positive';\s*\n\s*if \(score >= 55\) return 'Mixed';\s*\n\s*if \(score >= 35\) return 'Negative';/);
  });
});
