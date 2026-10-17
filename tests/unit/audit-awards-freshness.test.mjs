/**
 * scripts/audit-awards-freshness.js (BRO-4434) — the 14-month staleness
 * check that used to be test.yml's awards-data-freshness job, now a
 * check-corpus-drift.js AUDITS entry. Requires the real functions (CLAUDE.md
 * §15); the GitHub call is injected.
 */
// TESTS-VS-DERIVED-DATA-EXEMPT: asserts the AWARDS_PATH constant string and the API query built from it; never opens data/awards.json (structural — the audit matches the path literal, not a read)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideAwardsFreshness, fetchLastTouchedIso, AWARDS_PATH, MAX_AGE_DAYS } = require('../../scripts/audit-awards-freshness');

const NOW = new Date('2026-09-30T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400e3).toISOString();

describe('decideAwardsFreshness', () => {
  test('within the window is fresh, with the age', () => {
    const r = decideAwardsFreshness({ lastTouchedIso: daysAgo(100), now: NOW });
    assert.equal(r.status, 'fresh');
    assert.equal(r.ageDays, 100);
  });

  test('exactly MAX_AGE_DAYS is still fresh; one day more is stale', () => {
    assert.equal(decideAwardsFreshness({ lastTouchedIso: daysAgo(MAX_AGE_DAYS), now: NOW }).status, 'fresh');
    const r = decideAwardsFreshness({ lastTouchedIso: daysAgo(MAX_AGE_DAYS + 1), now: NOW });
    assert.equal(r.status, 'stale');
    assert.match(r.reason, /awards-annual-update\.md/, 'the runbook pointer rides the message');
  });

  test('no date / unparseable date is unknown, never fresh', () => {
    assert.equal(decideAwardsFreshness({ lastTouchedIso: null, now: NOW }).status, 'unknown');
    assert.equal(decideAwardsFreshness({ lastTouchedIso: 'yesterday', now: NOW }).status, 'unknown');
  });

  test('the window is ~14 months', () => {
    assert.equal(MAX_AGE_DAYS, 425);
    assert.equal(AWARDS_PATH, 'data/awards.json');
  });
});

describe('fetchLastTouchedIso', () => {
  test('asks the commits-by-path API for the newest commit and returns its committer date', () => {
    const calls = [];
    const runGh = (args) => { calls.push(args); return '2026-06-08T21:00:00Z'; };
    assert.equal(fetchLastTouchedIso({ runGh, repo: 'o/r' }), '2026-06-08T21:00:00Z');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'api');
    assert.match(calls[0][1], /^repos\/o\/r\/commits\?path=data%2Fawards\.json&per_page=1$/);
  });

  test('a failed call (null), an empty answer, or jq "null" all resolve to null', () => {
    for (const out of [null, '', 'null']) {
      assert.equal(fetchLastTouchedIso({ runGh: () => out, repo: 'o/r' }), null, JSON.stringify(out));
    }
  });
});
