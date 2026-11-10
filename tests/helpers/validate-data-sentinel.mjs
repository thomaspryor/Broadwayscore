// Shared fixture for the validate-data.js push-refusal sentinel tests
// (tests/unit/validate-data-push-refusal-sentinel*.test.mjs, Notion 362637c5-416f-8174).
//
// BRO-7068: the failure-path and success-path runs each validate the whole corpus
// (~150 s apiece with review-texts present). In one file they ran back to back and
// passed the live-data lane's 300 s per-file timeout, so each lives in its own file
// and both share this fixture instead of a copy of it (CLAUDE.md rule 15).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');
export const VALIDATE = join(ROOT, 'scripts/validate-data.js');
export const REAL_SHOWS_JSON = join(ROOT, 'data/shows.json');

/**
 * Per-test throwaway copy of shows.json, never the real path (task #1649: the old
 * backup/mutate/restore-in-place approach raced parallel sessions and CI). The child's
 * sentinel resolves under RUNNER_TEMP, which runValidate points at the fixture's own
 * directory, so no other validate-data.js run on the host can plant or clear it
 * between a run and its assert (BRO-2167).
 * @returns {{dir: string, fixturePath: string, sentinel: string, cleanup: () => void}}
 */
export function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'validate-data-sentinel-'));
  const fixturePath = join(dir, 'shows.json');
  copyFileSync(REAL_SHOWS_JSON, fixturePath);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  };
  process.on('exit', cleanup);
  return { dir, fixturePath, sentinel: join(dir, '.skip-push-core-data'), cleanup };
}

export function plantSyntheticBadRow(fixturePath) {
  const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
  data.shows.push({
    id: 'synthetic-sentinel-test-row',
    title: 'Sentinel Test',
    slug: 'synthetic-sentinel-test-row',
    venue: 'Test Venue',
    openingDate: '2025-01-01',
    closingDate: null,
    status: 'open',
    category: null,    // ← the gate that produces the error
    market: null,
    type: 'play',
    isRevival: false,
    tags: [],
    cast: [],
    creativeTeam: [],
    images: {},
    synopsis: '',
    runtime: null,
    intermissions: null,
    ageRecommendation: null,
    previewsStartDate: null,
  });
  writeFileSync(fixturePath, JSON.stringify(data, null, 2));
}

/**
 * Run the real validate-data.js --write against the fixture. Pass --write because
 * BRO-5892's cloudAuditDryRun defaults cloud sessions to dry-run mode, which
 * suppresses both writing and clearing the sentinel. VALIDATE_DATA_SHOWS_JSON keeps
 * shows writes in the throwaway copy and enables FIXTURE_MODE to block shared
 * audit-artifact writes.
 * @returns {number} the exit code
 */
export function runValidate(fixture, env = process.env) {
  try {
    execFileSync('node', [VALIDATE, '--write'], {
      stdio: 'pipe',
      env: { ...env, VALIDATE_DATA_SHOWS_JSON: fixture.fixturePath, RUNNER_TEMP: fixture.dir },
      // Same ceiling, same reason, as validate-data-venue-complex-wiring.test.mjs:
      // the 1 MiB default killed that sibling with ENOBUFS on main and turned
      // Unit Tests red (run 33989118480). This fixture is a full-corpus copy so
      // its output is smaller, but the corpus only grows.
      maxBuffer: 64 * 1024 * 1024,
    });
    return 0;
  } catch (e) {
    // `e.status ?? 1` on its own turns EVERY spawn failure into "exited 1",
    // including an ENOBUFS kill — and these suites read a non-zero code as
    // "validate-data.js refused the push", so a buffer overflow would have been
    // reported as the very contract being tested. A spawn that never produced an
    // exit code carries no verdict; re-raise instead of inventing one.
    if (typeof e.status !== 'number') throw e;
    return e.status;
  }
}
