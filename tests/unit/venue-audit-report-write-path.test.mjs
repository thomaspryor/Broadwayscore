// BRO-2696 — end-to-end regression test for the SHARED audit report's write path.
//
// The incident: `node scripts/validate-show-venue.js --show=<id>` overwrote the
// tracked, repo-wide data/audit/venue-date-mismatches.json with the ONE row it
// had checked. CI's provisional gate loads that file as `previousResultById` to
// decide check order, so a one-row report made 64 of 65 provisional shows tier
// as "new"; the 15 shows the 9-minute budget deferred were therefore also "new",
// and deferredHighPriorityShows() correctly refused to certify a clean pass.
// Main went red on run 33454567745 (sha ad2edb31c78) reporting `0 mismatch` —
// nothing was wrong with the data, the gate simply could not prove coverage.
// It happened twice in one day, both times from the per-show command CLAUDE.md
// rule 3 tells operators to run before committing a provisional entry.
//
// scripts/lib/venue-date-compare.test.mjs covers buildAuditResults() itself.
// This file covers the seam that actually broke: the CALLER used to populate
// `currentProvisionalIds` only inside its --all-provisional branch, so the
// filtered branches fell through to "write exactly what this run checked".
// A unit test of the merge helper would have stayed green through that bug,
// so this drives the real script, on a real (temp) shows.json and a real
// (temp) audit path, and asserts the file on disk afterwards.
//
// No network: --candidates-file with an empty list gives the run zero targets,
// so it goes straight to the write path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'validate-show-venue.js');

/** Three provisional shows, matching what isProvisional() actually accepts. */
const SHOWS = [
  { id: 'alpha-off-broadway-2026', title: 'Alpha', venue: 'Venue A', category: 'off-broadway', provisional: true },
  { id: 'beta-off-broadway-2026', title: 'Beta', venue: 'Venue B', category: 'off-broadway', discoverySource: 'manual-user-request' },
  { id: 'gamma-off-broadway-2026', title: 'Gamma', venue: 'Venue C', category: 'off-broadway', discoverySource: 'venue-page:example' },
  // Not provisional — must never be carried forward into the report.
  { id: 'delta-broadway-2026', title: 'Delta', venue: 'Venue D', category: 'broadway', discoverySource: 'aggregator-roundup' },
];

/** The prior report: full coverage of the provisional set, all previously clean. */
const PRIOR = {
  generatedAt: '2026-08-31T12:00:00.000Z',
  filter: { allProvisional: true, limit: null },
  counts: { total: 3, match: 3, mismatch: 0, unresolved: 0, infraUnavailable: 0 },
  results: [
    { id: 'alpha-off-broadway-2026', result: 'match' },
    { id: 'beta-off-broadway-2026', result: 'match' },
    { id: 'gamma-off-broadway-2026', result: 'match' },
    // A show that has since been promoted out of provisional: must be dropped,
    // not carried forward forever.
    { id: 'retired-off-broadway-2025', result: 'match' },
  ],
};

function runFiltered() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro2696-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'shows.json'), JSON.stringify(SHOWS));
  const auditPath = path.join(tmp, 'venue-date-mismatches.json');
  fs.writeFileSync(auditPath, JSON.stringify(PRIOR));
  const candidates = path.join(tmp, 'candidates.json');
  fs.writeFileSync(candidates, JSON.stringify({ candidates: [] }));

  execFileSync(process.execPath, [
    SCRIPT,
    `--candidates-file=${candidates}`,
    `--data-dir=${dataDir}`,
  ], {
    env: { ...process.env, VENUE_AUDIT_PATH: auditPath },
    stdio: 'pipe',
    timeout: 60_000,
  });

  return JSON.parse(fs.readFileSync(auditPath, 'utf8'));
}

test('a filtered validate-show-venue run does not truncate the shared audit report (BRO-2696)', () => {
  const after = runFiltered();
  const ids = after.results.map((r) => r.id).sort();
  assert.deepEqual(
    ids,
    ['alpha-off-broadway-2026', 'beta-off-broadway-2026', 'gamma-off-broadway-2026'],
    'every still-provisional show must keep its row; the run checked none of them',
  );
});

test('a filtered run drops rows for shows that are no longer provisional (BRO-2696)', () => {
  const after = runFiltered();
  // Asserted first so this case also fails on a revert to the truncating
  // behaviour — "nothing forbidden is present" is trivially true of an empty
  // report, which would let the old bug pass this test (pre-ship review).
  assert.ok(
    after.results.some((r) => r.id === 'alpha-off-broadway-2026'),
    'the still-provisional rows must actually be there for the exclusions to mean anything',
  );
  assert.ok(
    !after.results.some((r) => r.id === 'retired-off-broadway-2025'),
    'carry-forward must not resurrect a show that left the provisional set',
  );
  assert.ok(
    !after.results.some((r) => r.id === 'delta-broadway-2026'),
    'a non-provisional show must never enter the report',
  );
});

test('carried-forward rows keep their result, so the next run tiers them as previously-clean (BRO-2696)', () => {
  // This is the property the CI gate depends on. A row whose `result` is
  // anything other than 'match' tiers as 1 (needs recheck) and escalates when
  // deferred; a missing row tiers as 0 (new) and escalates too. Only a
  // preserved 'match' lets the budget defer a show without failing the build.
  const after = runFiltered();
  for (const r of after.results) {
    assert.equal(r.result, 'match', `${r.id} lost its previously-clean result`);
  }
  assert.equal(after.counts.carriedForward, 3, 'the run must report what it carried forward');
});
