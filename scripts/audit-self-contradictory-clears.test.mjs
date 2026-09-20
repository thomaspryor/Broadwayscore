// Regression coverage for BRO-2283: audit-self-contradictory-clears.js
// reported "0 review file(s) scanned, 0 contradiction(s)" — a vacuous clean
// pass — whenever data/review-texts (a private-repo checkout) was missing
// from the working tree, instead of erroring. The root cause was
// listShowDirs() swallowing the readdirSync failure into a bare `[]`,
// indistinguishable from "no shows matched the --show filter".
//
// Requires the REAL exported listShowDirs (CLAUDE.md §15) — a regression to
// the old catch-and-return-[] behaviour fails this, not a restated copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listShowDirs } = require('./audit-self-contradictory-clears.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('listShowDirs reports rootMissing when the corpus directory does not exist', () => {
  const missingDir = path.join(tmpdir(), 'bro-2283-does-not-exist-' + Date.now());
  assert.ok(!existsSync(missingDir));
  const result = listShowDirs(missingDir);
  assert.equal(result.rootMissing, true, 'a missing corpus root must be distinguishable from an empty match');
  assert.deepEqual(result.dirs, []);
});

test('listShowDirs does NOT report rootMissing for a real directory with no matching --show filter', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'bro-2283-fixture-'));
  try {
    mkdirSync(path.join(fixtureRoot, 'some-other-show'));
    const result = listShowDirs(fixtureRoot, 'a-show-with-no-reviews-yet');
    assert.equal(result.rootMissing, false, 'a readable root with an unmatched --show filter is a legitimate empty result, not a missing corpus');
    assert.deepEqual(result.dirs, []);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('listShowDirs finds a real show directory and excludes tombstone dirs', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'bro-2283-fixture-'));
  try {
    mkdirSync(path.join(fixtureRoot, 'some-show-2026'));
    mkdirSync(path.join(fixtureRoot, '_superseded-misattributed'));
    const result = listShowDirs(fixtureRoot);
    assert.equal(result.rootMissing, false);
    assert.deepEqual(result.dirs.sort(), ['some-show-2026']);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// Fixture-level regression test for the exact repro from the Linear issue:
// listShowDirs() finding a real show directory (not rootMissing) and the
// exported detector recognizing the wrongProduction/wrongProductionAutoCleared
// pair on the file inside it — the same two calls main() chains together.
// The script hardcodes data/review-texts relative to the repo root with no
// --dir override, so this exercises the two functions directly rather than
// spawning the CLI against a fixture path it cannot be pointed at; the live-
// corpus test below covers the CLI's own scanned/count plumbing end to end.
test('listShowDirs + detectAllSelfContradictoryClears together find a fixture self-contradictory clear', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'bro-2283-fixture-'));
  try {
    const showDir = path.join(fixtureRoot, 'example-show-west-end-2026');
    mkdirSync(showDir, { recursive: true });
    const filePath = path.join(showDir, 'example-outlet--example-critic.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        showId: 'example-show-west-end-2026',
        outletId: 'example-outlet',
        wrongProduction: true,
        wrongProductionAutoCleared: 'rebuild: allowEarlyDate bypasses wrongProduction',
        wrongProductionAutoClearedAt: '2026-07-26',
      }, null, 2),
    );

    const result = listShowDirs(fixtureRoot);
    assert.equal(result.rootMissing, false);
    assert.deepEqual(result.dirs, ['example-show-west-end-2026']);

    const { detectAllSelfContradictoryClears } = require('./lib/flag-contradiction.js');
    const fileContents = JSON.parse(require('node:fs').readFileSync(filePath, 'utf8'));
    const contradictions = detectAllSelfContradictoryClears(fileContents);
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].flag, 'wrongProduction');
    assert.equal(contradictions[0].breadcrumb, 'wrongProductionAutoCleared');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// Acceptance check against the live corpus, mirroring the exact repro command
// from the Linear issue. Deliberately UNSCOPED (no --show=) rather than
// pinned to one show: a specific show can be renamed/merged/consolidated
// (this repo does that regularly — see memory/feedback_self_referential_
// duplicate_pointers.md), which would fail this test for reasons unrelated to
// the fix under test (code review finding) rather than skip. An unscoped scan
// only depends on the corpus existing at all, which is exactly what BRO-2283
// is about. Skips (not fails) when data/review-texts isn't checked out in
// this worktree — that absence is itself the bug's original trigger, now
// surfaced as a loud FAIL by the CLI rather than this test silently passing
// on stale live-corpus content.
test('CLI (unscoped) against the live corpus scans >0 files when the corpus is present', (t) => {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'audit-self-contradictory-clears.js'), '--json'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
  } catch (err) {
    if (err.status === 1 && /is missing or empty|does not exist or is unreadable/.test(err.stderr || '')) {
      t.skip('data/review-texts not present in this checkout — run from a checkout with the private repo cloned');
      return;
    }
    throw err;
  }
  const { scanned } = JSON.parse(out);
  assert.ok(scanned > 0, `expected >0 files scanned, got ${scanned} (0 scanned is the BRO-2283 regression)`);
});
