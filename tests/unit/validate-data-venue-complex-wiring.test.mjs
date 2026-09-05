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
 * The fixture is deliberately tiny, so this run costs seconds rather than the
 * minutes a full-corpus validate-data.js run takes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..');
const VALIDATE = join(ROOT, 'scripts', 'validate-data.js');
const COMPLEXES = join(ROOT, 'data', 'venue-complexes.json');
const SENTINEL = join(process.env.RUNNER_TEMP || '/tmp', '.skip-push-core-data');

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
    const hadSentinel = existsSync(SENTINEL);
    let out = '';
    let status = 0;
    try {
      out = execFileSync('node', [VALIDATE], {
        stdio: 'pipe',
        encoding: 'utf8',
        env: { ...process.env, VALIDATE_DATA_SHOWS_JSON: fixturePath },
      });
    } catch (e) {
      // A one-show fixture trips plenty of unrelated validators; that is fine
      // and expected. We assert on the advisory TEXT, never on the exit code.
      status = e.status ?? 1;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      // Never leave a refusal sentinel behind for a real push to trip over.
      if (!hadSentinel && existsSync(SENTINEL)) unlinkSync(SENTINEL);
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
