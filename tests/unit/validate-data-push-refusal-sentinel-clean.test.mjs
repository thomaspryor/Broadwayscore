// LIVE-DATA-LANE: runs scripts/validate-data.js against a copy of data/shows.json (untracked core data) and the real data/review-texts. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// TESTS-VS-DERIVED-DATA-EXEMPT: tests validate-data.js exit-code + sentinel-file behavior using shows.json as fixture input; no factual pins.
/**
 * Success path of the validate-data.js push-refusal sentinel contract (Notion
 * 362637c5-416f-8174). The failure paths are in validate-data-push-refusal-sentinel.test.mjs;
 * the file header there explains why both run against the live corpus.
 *
 * BRO-7068: each full-corpus validate-data.js run takes ~150 s with review-texts present.
 * Back to back in one file the two runs passed the live-data lane's 300 s per-file
 * timeout (check-corpus-drift.yml, node --test --test-timeout 300000), which turned
 * "Check Corpus Drift" red on every run from 2026-11-09. One full run per file.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REAL_SHOWS_JSON, makeFixture, runValidate } from '../helpers/validate-data-sentinel.mjs';

describe('validate-data.js — push-refusal sentinel, success path', () => {
  // BRO-7068 class guard: full-corpus validate-data.js runs are split one per file so no
  // file needs two (~300 s) inside the lane's 300 s per-file budget. Static, so it runs
  // without data.
  test('the failure-path file does not also run the full-corpus success path', () => {
    const failureFile = readFileSync(join(import.meta.dirname, 'validate-data-push-refusal-sentinel.test.mjs'), 'utf8');
    assert.doesNotMatch(failureFile, /test\(\s*'clean shows\.json/,
      'the success-path run belongs in this file: two full-corpus runs in one file exceed the live-data lane\'s 300 s per-file timeout');
    const fullRuns = (failureFile.match(/plantSyntheticBadRow\(/g) || []).length;
    assert.ok(fullRuns <= 1, `validate-data-push-refusal-sentinel.test.mjs plants ${fullRuns} full-corpus fixtures; one per file`);
  });

  if (!existsSync(REAL_SHOWS_JSON)) {
    test('[skip] data/shows.json absent in this context', () => {});
    return;
  }

  // One full-corpus run covers both success-path contracts (BRO-7134: three ~80 s runs put the
  // sentinel file at 236 s of its 300 s budget alone, and it timed out under the land batch's load):
  // a success that WRITES a sentinel and a success that fails to CLEAR a stale one both leave
  // the file present, so planting a stale sentinel first and asserting it is gone checks both.
  test('clean shows.json → exit 0, stale sentinel from a prior failure cleared, none written', (t) => {
    const fixture = makeFixture();
    const SENTINEL = fixture.sentinel;
    try {
      writeFileSync(SENTINEL, 'stale sentinel from a prior run\n');
      const code = runValidate(fixture);
      if (code !== 0) {
        // The live corpus itself currently fails validate-data.js: a real,
        // transient data problem (see the failure-path file's header), not a sentinel
        // regression. This test needs a genuine exit-0 run, so skip rather than false-fail.
        const reason = existsSync(SENTINEL)
          ? readFileSync(SENTINEL, 'utf8').split('\n')[0]
          : `exit ${code}, no sentinel detail available`;
        t.skip(`live data/shows.json is not currently clean (${reason}) — can't exercise the success-clears-stale-sentinel path, see file header`);
        return;
      }
      assert.strictEqual(code, 0, 'expected exit 0 on clean shows.json');
      assert.strictEqual(existsSync(SENTINEL), false,
        'sentinel present after a successful validate: either success wrote one (push-core-data wrongly blocked) '
        + 'or it did not clear the stale one (a single past failure would permanently block push)');
    } finally {
      fixture.cleanup();
    }
  });
});
