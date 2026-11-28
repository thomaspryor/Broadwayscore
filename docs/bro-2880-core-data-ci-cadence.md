# BRO-2880: accept daily core-data CI detection

Decision, 2026-10-22: accept the existing daily 06:00 UTC Test Suite cron as
sufficient for the general core-data drift gap. This selects the card's written
acceptance alternative, as an engineering decision permitted by its board triage.
It does not add a core-data push trigger or claim immediate attribution.

## Rationale and accepted limits

The [Test Suite](../.github/workflows/test.yml) schedules `0 6 * * *`. Its
`unit-tests` job checks out private core data before running the collected tests.
That provides an independent scheduled check even when no code push occurs.
Accept a nominal daily detection interval for persistent data-dependent test
failures. Queue delays, cancellation, checkout failures and job runtime can make
the interval longer than 24 hours; this is a cadence decision, not a detection SLA.
A transient defect between snapshots can escape detection.

An intervening unrelated push can still discover a data failure first. Such a
failure requires comparison against the same core-data snapshot before blaming
the code change. This decision accepts that attribution limitation. Adding
`data/shows.json` to public-repo push paths would not help: it is gitignored and
untracked here. Existing blocking data-validation checks retain their severity.

There is also targeted monitoring already on main. The
[corpus-drift workflow](../.github/workflows/check-corpus-drift.yml) runs after
`Rebuild Reviews Data` completes and daily at 08:20 UTC. It checks out core data
and runs selected live-data assertions, including
[venue-complex-live-data.test.mjs](../tests/unit/venue-complex-live-data.test.mjs).
It routes failing assertions through `route-live-data-failures.js`. This is
additional coverage, not a claim that every private-data push triggers all
data-dependent tests or that the selected tests cover the historical 40+ files.

The daily backstop plus existing rebuild-linked monitoring is sufficient for
this card's detection requirement. Reconsider the cadence if a persistent
defect survives a successful scheduled suite or repeated data failures still
consume unrelated code investigations. Any future dispatch design must address
private-repo authentication, snapshot identity and debounce rather than adding
an inert public-repo path filter.

## Verification at the starting main revision

Checked at `2c784262978d4a32d5a8debaccf5f9542643f4cc` (both HEAD and
`origin/main`). The historical venue failure is already fixed:

- `node --test scripts/audit-venue-complex-slugs.test.mjs`: 15 passed, 0 failed.
  This file now tests functions and tracked configuration, not `shows.json`.
- `node --test --test-timeout 300000 tests/unit/venue-complex-live-data.test.mjs`:
  6 passed, 0 failed against the supplied private-data snapshot.
- The real `findOrphanSubVenueSlugs()` and `findCandidateGaps()` functions found
  no orphans or gaps across 593 off-Broadway and 1,063 London shows, out of
  3,808 total records. Example complex memberships: New World Stages, 5 shows;
  The Public Theater, 25; Soho Theatre, 25.

The historical write path is
[push-core-data](../.github/actions/push-core-data/action.yml), which syncs
changed data into the private checkout and pushes there. The public Test Suite
has no `repository_dispatch` trigger. The venue validator in
[validate-data.js](../scripts/validate-data.js) calls the shared audit functions
but treats findings as advisory. Neither the venue-test relocation nor that
warning alone closes the general trigger gap; the explicit cadence acceptance
above resolves the remaining decision.

This change is documentation only: zero data records change, zero new scripts
or callers, zero additional paid fetches, LLM calls, API calls or cron runs.
