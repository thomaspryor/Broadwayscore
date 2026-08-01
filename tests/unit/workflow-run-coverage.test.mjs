/**
 * Unit tests for findNeverRunWorkflows (task #737) — detects workflow files
 * registered on GitHub Actions with a lifetime run count of zero, filtered
 * by an age floor so brand-new workflows aren't flagged before they've had
 * a realistic chance to fire.
 *
 * Pattern: require() the real function; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findNeverRunWorkflows } = require('../../scripts/lib/workflow-run-coverage.js');

const NOW = '2026-08-01T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days) => new Date(new Date(NOW).getTime() - days * DAY_MS).toISOString();

describe('findNeverRunWorkflows', () => {
  test('flags a 0-run workflow older than minAgeDays', () => {
    const offenders = findNeverRunWorkflows({
      workflows: [{ file: 'ingest-urls.yml', createdAt: isoDaysAgo(90) }],
      runCountsByFile: {},
      now: NOW,
      minAgeDays: 30,
    });
    assert.deepStrictEqual(offenders, ['ingest-urls.yml']);
  });

  test('does NOT flag a 0-run workflow newer than minAgeDays', () => {
    const offenders = findNeverRunWorkflows({
      workflows: [{ file: 'brand-new.yml', createdAt: isoDaysAgo(5) }],
      runCountsByFile: {},
      now: NOW,
      minAgeDays: 30,
    });
    assert.deepStrictEqual(offenders, []);
  });

  test('never flags a workflow with runs, regardless of age', () => {
    const offenders = findNeverRunWorkflows({
      workflows: [{ file: 'rebuild-reviews.yml', createdAt: isoDaysAgo(400) }],
      runCountsByFile: { 'rebuild-reviews.yml': 812 },
      now: NOW,
      minAgeDays: 30,
    });
    assert.deepStrictEqual(offenders, []);
  });

  test('treats a workflow absent from runCountsByFile as zero runs', () => {
    const offenders = findNeverRunWorkflows({
      workflows: [{ file: 'btc-results-preview.yml', createdAt: isoDaysAgo(200) }],
      runCountsByFile: { 'some-other-workflow.yml': 5 },
      now: NOW,
      minAgeDays: 30,
    });
    assert.deepStrictEqual(offenders, ['btc-results-preview.yml']);
  });

  test('a 0-run workflow exactly at minAgeDays is not yet flagged (strictly older required)', () => {
    const offenders = findNeverRunWorkflows({
      workflows: [{ file: 'exactly-30.yml', createdAt: isoDaysAgo(30) }],
      runCountsByFile: {},
      now: NOW,
      minAgeDays: 30,
    });
    assert.deepStrictEqual(offenders, []);
  });

  test('defaults minAgeDays to 30 when omitted', () => {
    const offenders = findNeverRunWorkflows({
      workflows: [
        { file: 'old-enough.yml', createdAt: isoDaysAgo(45) },
        { file: 'too-new.yml', createdAt: isoDaysAgo(10) },
      ],
      runCountsByFile: {},
      now: NOW,
    });
    assert.deepStrictEqual(offenders, ['old-enough.yml']);
  });

  test('missing/unparseable createdAt is treated as infinitely old (flag if 0 runs)', () => {
    const offenders = findNeverRunWorkflows({
      workflows: [
        { file: 'no-created-at.yml' },
        { file: 'bad-created-at.yml', createdAt: 'not-a-date' },
      ],
      runCountsByFile: {},
      now: NOW,
      minAgeDays: 30,
    });
    assert.deepStrictEqual(offenders, ['no-created-at.yml', 'bad-created-at.yml']);
  });

  test('multiple workflows: only 0-run + old ones are returned, order preserved', () => {
    const offenders = findNeverRunWorkflows({
      workflows: [
        { file: 'a-active.yml', createdAt: isoDaysAgo(200) },
        { file: 'b-never-run-old.yml', createdAt: isoDaysAgo(60) },
        { file: 'c-never-run-new.yml', createdAt: isoDaysAgo(2) },
        { file: 'd-never-run-old.yml', createdAt: isoDaysAgo(100) },
      ],
      runCountsByFile: { 'a-active.yml': 3 },
      now: NOW,
      minAgeDays: 30,
    });
    assert.deepStrictEqual(offenders, ['b-never-run-old.yml', 'd-never-run-old.yml']);
  });

  test('empty workflows list returns empty offenders', () => {
    const offenders = findNeverRunWorkflows({ workflows: [], runCountsByFile: {}, now: NOW });
    assert.deepStrictEqual(offenders, []);
  });
});
