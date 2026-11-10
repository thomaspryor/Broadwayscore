// LIVE-DATA-LANE: reads data/retired-show-ids.json (untracked core data); data/site-image-versions.json (untracked core data); data/grosses.json (untracked core data); +17 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// TESTS-VS-DERIVED-DATA-EXEMPT: tests validate-data.js exit-code + sentinel-file behavior using shows.json as fixture input; no factual pins.
/**
 * validate-data.js must write /tmp/.skip-push-core-data when it exits with errors,
 * and clear it when it exits 0. This sentinel gates .github/actions/push-core-data.
 *
 * Notion 362637c5-416f-8174 — 64 workflows use push-core-data with `if: always()`.
 * Without this gate, validate-data.js exit-1 doesn't prevent corrupt rows from
 * reaching the private repo. Composite action reads the sentinel and refuses.
 *
 * This test plants a synthetic corrupt row and runs the real script, but against
 * a throwaway copy of shows.json — never the real data/shows.json (task #1649:
 * the old backup/mutate/restore-in-place approach raced parallel sessions and CI,
 * which write shows.json every ~30 min, leaving a window of transient corruption
 * in the source of truth). validate-data.js reads VALIDATE_DATA_SHOWS_JSON to
 * override the shows.json path it validates; every other data file it reads
 * still resolves against the real data/ dir.
 *
 * Pass --write because BRO-5892's cloudAuditDryRun defaults cloud sessions to
 * dry-run mode, which suppresses both writing and clearing the sentinel.
 * VALIDATE_DATA_SHOWS_JSON keeps shows writes in the throwaway copy and enables
 * FIXTURE_MODE to block shared audit-artifact writes; RUNNER_TEMP isolates the
 * sentinel too.
 *
 * BRO-7068: the success path ("clean shows.json → exit 0") lives in
 * validate-data-push-refusal-sentinel-clean.test.mjs. Each full-corpus run takes
 * ~150 s with review-texts present; two in one file passed the live-data lane's
 * 300 s per-file timeout. Fixture helpers: tests/helpers/validate-data-sentinel.mjs.
 *
 * The "clean shows.json → exit 0" test runs validate-data.js
 * against an UNMODIFIED copy of the live corpus — they cannot use a hand-built
 * minimal fixture instead (rejected via /second-opinion, 2026-08-23):
 * validateMinimumCounts() compares against the real ~2920-show baseline (25%
 * floor), and the reviews.json orphan check reads the real ~20k-review
 * reviews.json unconditionally — both would hard-fail against a tiny fixture,
 * and a fixture this repo's own dtli-sibling-reroute.test.mjs already warns is
 * "the 'fixtures are not evidence' trap" for corpus-shaped logic. So the live
 * corpus can, transiently, actually fail validate-data.js at the moment CI runs
 * (this repo lands ~150 commits/hour) — that's a real if short-lived DATA
 * problem, not a bug in the sentinel mechanism these tests exist to guard, so
 * that test (in the -clean file) skips (not fail) when the unmodified baseline itself doesn't
 * validate clean. See task #466-adjacent noise write-up, 2026-08-23.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { REAL_SHOWS_JSON, makeFixture, plantSyntheticBadRow, runValidate } from '../helpers/validate-data-sentinel.mjs';

describe('validate-data.js — push-refusal sentinel contract (Notion 362637c5-416f-8174)', () => {
  // Skip the whole suite if data isn't symlinked (CI without core-data checkout).
  if (!existsSync(REAL_SHOWS_JSON)) {
    test('[skip] data/shows.json absent in this context', () => {});
    return;
  }

  test('corrupt shows.json → exit 1, sentinel written with marker', async (t) => {
    const fixture = makeFixture();
    const SENTINEL = fixture.sentinel;
    try {
      plantSyntheticBadRow(fixture.fixturePath);
      // Reuse this full-corpus run for the cloud regression to stay within CI's timeout.
      await t.test('cloud session: sentinel written without GITHUB_ACTIONS', () => {
        const env = { ...process.env, CLAUDE_CODE_REMOTE: 'true' };
        delete env.GITHUB_ACTIONS;
        const code = runValidate(fixture, env);
        assert.strictEqual(code, 1, 'expected exit 1 when shows.json has a null-category open show');
        assert.strictEqual(existsSync(SENTINEL), true,
          'sentinel was NOT written: push-core-data would push the corrupt row to the private repo');
        const content = readFileSync(SENTINEL, 'utf8');
        // Assert on the CONTRACT (refusal marker always present), not the brittle first-error
        // reason: validate-data runs many checks and any earlier unrelated error would
        // displace our synthetic one as errors[0]. The contract for push-core-data is "the
        // marker line exists"; the reason is operator-facing detail, not test surface.
        assert.match(content, /validate-data\.js refused push/, 'sentinel missing the refusal marker line');
        assert.match(content, /reason:/, 'sentinel missing the reason: prefix that operators key on');
      });
    } finally {
      fixture.cleanup();
    }
  });

  // Codex found two process.exit(1) paths in validate-data.js that bypassed the
  // sentinel before the refactor (missing shows.json, parse error). These tests
  // lock the coverage: if a future edit splits a new exit path off without going
  // through exitWithError(), this test fails.
  test('unparseable shows.json → exit 1, sentinel written (early-exit path coverage)', () => {
    const fixture = makeFixture();
    const SENTINEL = fixture.sentinel;
    try {
      writeFileSync(fixture.fixturePath, '{not json'); // truncated/invalid
      const code = runValidate(fixture);
      assert.strictEqual(code, 1, 'expected exit 1 on unparseable shows.json');
      assert.strictEqual(existsSync(SENTINEL), true,
        'sentinel NOT written on parse-error exit path — push-core-data would be unguarded');
      assert.match(readFileSync(SENTINEL, 'utf8'), /parse error/i,
        'sentinel reason should mention the parse error');
    } finally {
      fixture.cleanup();
    }
  });
});
