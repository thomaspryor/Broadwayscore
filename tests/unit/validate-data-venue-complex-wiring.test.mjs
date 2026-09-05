/**
 * Wiring test for validateOrphanSubVenueSlugs in scripts/validate-data.js.
 *
 * WHY A SPAWN AND NOT A UNIT TEST. scripts/audit-venue-complex-slugs.test.mjs
 * already covers the pure functions thoroughly, but an adversarial review made
 * the point that every one of those tests still passes if the single line
 * `validateOrphanSubVenueSlugs(shows);` is deleted from validate-data.js's main
 * runner — none of them touches parsing, severity, warning text, exit status or
 * wiring. The whole reason the validator exists is that it RUNS at the moment
 * the core data changes, so "does it run, and is it advisory rather than
 * blocking" is exactly the property worth pinning.
 *
 * WHAT IT PINS, and how it fails:
 *  - delete the runner call        -> no ADVISORY line in stdout  -> fails
 *  - change warn() back to error() -> ADVISORY prefix gone AND the run turns
 *                                     blocking on this condition -> fails
 *  - rename/reword the advisory    -> fails (deliberate: the text is the
 *                                     operator-facing contract)
 *
 * HOW THE ORPHAN IS PRODUCED without touching a shared file. validate-data.js
 * honours VALIDATE_DATA_SHOWS_JSON (scripts/validate-data.js:137) to point at a
 * throwaway shows.json; data/venue-complexes.json is NOT overridable and must
 * never be mutated by a test, since ~20 parallel worktree sessions share this
 * checkout. So the fixture carries ZERO off-Broadway shows, which orphans every
 * off-Broadway subVenueSlug by construction — the same condition the live
 * incident produced by deleting one show.
 *
 * COST, measured rather than assumed: about 190s. An earlier version of this
 * comment claimed "seconds", which was wrong — the fixture replaces shows.json
 * only, so reviews.json and every other validator still run against the full
 * corpus. It is one of the slower entries in the unit suite. That is accepted
 * because the property it pins has no cheaper proof: the pure functions are
 * already covered in scripts/audit-venue-complex-slugs.test.mjs, and every one
 * of those tests passes with the runner call deleted.
 *
 * ISOLATION, and why each piece is needed:
 *  - RUNNER_TEMP is pointed at a per-test directory. validate-data.js resolves
 *    its push-refusal sentinel under RUNNER_TEMP (validate-data.js:60), so
 *    without this the child writes /tmp/.skip-push-core-data on a machine where
 *    ~20 sessions share it — silently blocking another session's push-core-data
 *    on a fake refusal, or (if the run exited 0) deleting a real one.
 *  - validate-data.js now refuses to write its tracked audit artifacts whenever
 *    VALIDATE_DATA_SHOWS_JSON is set. Before that, this test recomputed
 *    data/audit/london-only-nyc-accumulation.json FROM THE FIXTURE and cut it
 *    from 3,357 lines to 161 in the shared checkout.
 *  - stdout AND stderr are captured on BOTH paths. warn() writes via
 *    console.warn, i.e. stderr, and execFileSync returns stdout only on success,
 *    which is why this uses spawnSync — it hands back both streams on every
 *    so asserting on advisory text without merging stderr passes only while the
 *    fixture happens to make the run exit non-zero.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');
const VALIDATE = join(ROOT, 'scripts', 'validate-data.js');
const COMPLEXES = join(ROOT, 'data', 'venue-complexes.json');

// A single non-off-Broadway show. Every off-Broadway venue-complex subVenueSlug
// is therefore unresolvable, which is precisely the orphan condition.
const FIXTURE_SHOWS = {
  shows: [
    {
      id: 'venue-complex-wiring-fixture-2025',
      title: 'Venue Complex Wiring Fixture',
      slug: 'venue-complex-wiring-fixture-2025',
      venue: 'Fixture Theatre',
      category: 'broadway',
      market: 'broadway',
      status: 'open',
      type: 'play',
      openingDate: '2025-01-01',
      closingDate: null,
      previewsStartDate: null,
      isRevival: false,
      tags: [],
      cast: [],
      creativeTeam: [],
      images: {},
      synopsis: '',
      runtime: null,
      intermissions: null,
      ageRecommendation: null,
    },
  ],
};

describe('validate-data.js — venue-complex orphan advisory is wired into the runner', () => {
  // The check needs at least one off-Broadway complex with a sub-venue slug to
  // have something to orphan. Skip loudly rather than pass vacuously if the
  // config file is absent or has been emptied.
  if (!existsSync(COMPLEXES)) {
    test('[skip] data/venue-complexes.json absent in this context', () => {});
    return;
  }
  // Shape-guard the top level before touching it. Object.values(undefined)
  // throws, and a throw at suite-construction time is reported by node --test as
  // a ✖ suite with `fail 0` — a failure that reads like a pass in the tally. This
  // is the same defect the reviewer reproduced inside validate-data.js itself, so
  // it would be careless to reintroduce it in the test that guards against it.
  const complexes = JSON.parse(readFileSync(COMPLEXES, 'utf8')).complexes;
  if (!complexes || typeof complexes !== 'object' || Array.isArray(complexes)) {
    test('[skip] data/venue-complexes.json has no usable top-level complexes object', () => {});
    return;
  }
  const slugCount = Object.values(complexes)
    .reduce((n, def) => n + (def && Array.isArray(def.subVenueSlugs) ? def.subVenueSlugs.length : 0), 0);
  if (slugCount === 0) {
    test('[skip] no off-Broadway subVenueSlugs to orphan', () => {});
    return;
  }

  test('a corpus with no off-Broadway shows emits the ADVISORY and does not block on it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcw-'));
    const fixturePath = join(dir, 'shows.json');
    writeFileSync(fixturePath, JSON.stringify(FIXTURE_SHOWS, null, 2));
    // Sandbox the sentinel: the child resolves it under RUNNER_TEMP, so it can
    // only ever touch a file inside this test's own throwaway directory.
    const sandboxSentinel = join(dir, '.skip-push-core-data');
    let out = '';
    let status = 0;
    let sentinelLandedInSandbox = false;
    try {
      // spawnSync, not execFileSync: execFileSync RETURNS stdout only and exposes
      // stderr just on the throw path, so a version of this test that asserted on
      // its return value passed only while the fixture happened to make the run
      // exit non-zero. warn() writes to stderr, so the advisory text this test
      // exists to find lives there. spawnSync hands back both streams on every
      // exit code, which removes that dependency entirely.
      const res = spawnSync('node', [VALIDATE], {
        encoding: 'utf8',
        env: { ...process.env, VALIDATE_DATA_SHOWS_JSON: fixturePath, RUNNER_TEMP: dir },
        // spawnSync's default maxBuffer is 1 MiB, and this child deliberately
        // runs the WHOLE validator against a ONE-SHOW fixture, so essentially
        // every corpus-wide validator reports failures and the combined
        // stdout+stderr is far larger than a normal run's. It crossed 1 MiB on
        // main and the child was killed with ENOBUFS, which surfaces here as
        // `res.error` and turned Unit Tests red (run 33989118480). Raising the
        // ceiling is the fix, not trimming the child's output: the assertions
        // below scan that text for the advisory, so a truncated stream would
        // fail them for a reason that has nothing to do with the wiring this
        // test guards.
        maxBuffer: 64 * 1024 * 1024,
      });
      // ENOBUFS also truncates whatever was captured, so re-raising here rather
      // than asserting on a partial stream is deliberate — a buffer overflow
      // must never be reported as "the advisory did not fire".
      if (res.error) throw res.error;
      // A one-show fixture trips plenty of unrelated validators; that is fine
      // and expected. We assert on the advisory TEXT, never on the exit code.
      status = res.status ?? 0;
      out = `${res.stdout || ''}${res.stderr || ''}`;
    } finally {
      // Positive isolation check, done BEFORE cleanup. A non-zero exit means
      // validate-data.js wrote a refusal sentinel; if RUNNER_TEMP took effect it
      // is inside `dir` and dies with it. Asserting on the SHARED /tmp path
      // instead would be flaky, since another session may legitimately have one
      // there — so assert the sandbox copy exists rather than that the shared
      // one does not.
      sentinelLandedInSandbox = existsSync(sandboxSentinel);
      rmSync(dir, { recursive: true, force: true });
    }
    if (status !== 0) {
      assert.ok(sentinelLandedInSandbox,
        'validate-data.js exited non-zero but wrote no sentinel inside the sandboxed RUNNER_TEMP — isolation regressed, and a real push elsewhere could be blocked by this test');
    }

    assert.match(
      out,
      /Checking venue-complex sub-venue slugs resolve to real venues/,
      'validateOrphanSubVenueSlugs did not run — is the call still in validate-data.js\'s main runner?'
    );
    assert.match(
      out,
      /Venue-complex ADVISORY: data\/venue-complexes\.json complex "[^"]+" lists sub-venue slug\(s\)/,
      'the orphan advisory did not fire on a corpus with zero off-Broadway shows'
    );
    // Severity contract: the orphan finding must be a WARNING, never an ERROR.
    // An error() here reaches exitWithError -> .skip-push-core-data and wedges
    // automated core-data pushes over a cosmetic defect (see the comment above
    // validateOrphanSubVenueSlugs). If someone escalates it, this fails.
    const orphanLines = out.split('\n').filter(l => l.includes('Venue-complex ADVISORY:'));
    assert.ok(orphanLines.length > 0, 'expected at least one advisory line');
    for (const line of orphanLines) {
      assert.ok(
        !line.includes('❌ ERROR'),
        `orphan finding was raised as an ERROR, which blocks push-core-data: ${line}`
      );
    }
    assert.ok(typeof status === 'number');
  });
});
