// TESTS-VS-DERIVED-DATA-EXEMPT: structural: zero unallowlisted doubled-market ids, allowlist consistency; pins no show fact beyond the documented allowlist
// BRO-5729 (BRO-3425 pattern): live-data assertions split out of scripts/lib/doubled-market-ids.test.mjs. They assert ceilings / zero-counts over
// bot-rewritten data (data/shows.json), so in a code-test batch they turn main red with no code change.
// They run in check-corpus-drift.yml's "Live-data assertions" step (data-health, which checks out core data and
// review-texts), excluded from the unit batches in scripts/lib/unit-test-collection.js. Pure-logic tests stay in scripts/lib/doubled-market-ids.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const D = require('../../scripts/lib/doubled-market-ids.js');
const here = path.dirname(fileURLToPath(import.meta.url));

// ASSERTING "zero flagged" ALONE IS NOT A TEST OF THIS DETECTOR. A detector that
// matches nothing at all also reports zero flagged rows, so a broken regex makes
// this file greener, not redder — MEASURED: reverting the lazy quantifier turns
// 8 of these 17 tests red while the zero-flagged corpus assertion stays GREEN.
// That is why the detected-set assertion sits beside it.
//
// AND A SKIPPED TEST IS NOT A PASSING ONE. These read data/shows.json, which a
// worktree does not have. They used to `return` on a missing file, which node
// reports as a pass — so "13/13 pass" could mean the corpus was never opened.
// They now skip VISIBLY, so the runner prints what did not run.
function loadCorpus() {
  const showsPath = path.join(here, '..', '..', 'data', 'shows.json');
  if (!fs.existsSync(showsPath)) return null;
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
}
const NO_CORPUS = 'data/shows.json absent (worktree without core data) — NOT a pass';

test('the live corpus has zero unallowlisted doubled-market ids', (t) => {
  const shows = loadCorpus();
  if (!shows) return t.skip(NO_CORPUS);
  const { flagged } = D.sweepShows(shows);
  return assert.deepEqual(
    flagged.map((r) => `${r.id} ${JSON.stringify(r.title)}`),
    [],
    'fix the title, or allowlist the id with the source you checked',
  );
});

test('the detector still DETECTS every allowlisted row in the live corpus', (t) => {
  const shows = loadCorpus();
  if (!shows) return t.skip(NO_CORPUS);
  const { allowlisted } = D.sweepShows(shows);
  return assert.deepEqual(
    allowlisted.map((r) => r.id).sort(),
    [...D.ALLOWLIST.keys()].sort(),
    'the detected set no longer matches the allowlist — either detection broke '
      + '(every allowlisted row silently stopped matching) or a row was renamed',
  );
});

// Not just "these three ids were detected" — the PARSE of each is pinned. The
// first review's mutation was to return an arbitrary doubledWord for the rows
// nothing asserted the parts of; only Lauder's were checked.
test('every allowlisted corpus row parses to the expected parts', (t) => {
  const shows = loadCorpus();
  if (!shows) return t.skip(NO_CORPUS);
  const byId = new Map(D.sweepShows(shows).allowlisted.map((r) => [r.id, r]));
  const expected = {
    'lauder-scotlands-kilted-king-of-broadway-off-broadway-2026':
      { prefix: 'lauder-scotlands-kilted-king-of-broadway', market: 'off-broadway', doubledWord: 'broadway', year: '2026' },
    'september-l-davis-the-apology-tour-off-broadway-2026':
      { prefix: 'september-l-davis-the-apology-tour', market: 'off-broadway', doubledWord: 'tour', year: '2026' },
    'paranormal-activity-national-tour-regional-2025':
      { prefix: 'paranormal-activity-national-tour', market: 'regional', doubledWord: 'tour', year: '2025' },
    'strictly-come-dancing-london-off-west-end-2027':
      { prefix: 'strictly-come-dancing-london', market: 'off-west-end', doubledWord: 'london', year: '2027' },
  };
  assert.deepEqual(Object.keys(expected).sort(), [...D.ALLOWLIST.keys()].sort(),
    'this table and ALLOWLIST have drifted apart');
  for (const [id, want] of Object.entries(expected)) {
    const got = byId.get(id);
    assert.ok(got, `${id} was not detected at all`);
    assert.deepEqual(
      { prefix: got.prefix, market: got.market, doubledWord: got.doubledWord, year: got.year },
      want,
      `${id} parsed differently than recorded`,
    );
  }
  return undefined;
});

test('no allowlist key is stale — every one names a show that still exists', (t) => {
  const shows = loadCorpus();
  if (!shows) return t.skip(NO_CORPUS);
  const ids = new Set(shows.map((s) => s.id));
  const missing = [...D.ALLOWLIST.keys()].filter((id) => !ids.has(id));
  return assert.deepEqual(
    missing,
    [],
    'an allowlisted id is not in shows.json. A rename or a year correction '
      + 'leaves the key matching nothing while the renamed row rejoins the '
      + 'flagged set — update the key, do not delete the reason.',
  );
});
