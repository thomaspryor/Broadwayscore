/**
 * BRO-2326: end-to-end coverage for timestamp-aware conflict resolution on
 * data/opening-night-sent.json across its ~6 concurrent writers
 * (reconcile-newsletter-state, broadcast-send, the opening-night
 * orchestrator, per-show opening-night-poller-*, reconcile-broadcast-state,
 * refresh-show-score-opening-night).
 *
 * Filed after adversarial review (Codex + Claude general-purpose,
 * independently) of task #1853 (reconcile-broadcast-state.js origin-sync
 * fix) found two writer paths for this file both doing positional
 * last-write-wins on a key conflict instead of comparing content recency —
 * fixed by task #1914 (commits 2fa7551849b, 36561a00777), which gave both
 * paths a shared comparator: scripts/lib/tracker-record-recency.js's
 * recordRecencyMs(). Unlike scripts/lib/merge-opening-night-sent.test.mjs
 * and scripts/lib/opening-night-tracker-sync.test.mjs (which unit-test each
 * merge function's individual branches), this file simulates realistic
 * concurrent-write races BETWEEN named writers and asserts the two
 * independent reconciliation surfaces — the git-push merge path
 * (mergeOpeningNightSent, used by push-core-data/action.yml via
 * core-data-merge-registry.js) and the REST/gh-api sync path
 * (mergeTrackerEntries, used by scripts/lib/opening-night-tracker-sync.js) —
 * agree on the same outcome regardless of arrival order.
 *
 * Both functions are require()'d from production code, per CLAUDE.md rule 15
 * (never copy merge logic into a test file) — a regression in either real
 * comparator fails this test, not a reimplementation of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { mergeOpeningNightSent } = require(
  path.join(__dirname, '..', '..', 'scripts', 'lib', 'merge-opening-night-sent.js'),
);
const { mergeTrackerEntries } = require(
  path.join(__dirname, '..', '..', 'scripts', 'lib', 'opening-night-tracker-sync.js'),
);
const { recordRecencyMs } = require(
  path.join(__dirname, '..', '..', 'scripts', 'lib', 'tracker-record-recency.js'),
);

// The two production functions do NOT share an argument order —
// mergeOpeningNightSent(ours, remote) vs mergeTrackerEntries(remoteParsed,
// localParsed), i.e. "mine" is the FIRST positional arg on one and the
// SECOND on the other. Both do default to "mine" (the local/ours side)
// winning a tie or a no-comparable-timestamp conflict, so this wrapper gives
// every scenario below one uniform run(mine, theirs) call shape by reversing
// the REST surface's argument order to match — verified against both
// functions' real signatures, not assumed from naming alone.
const SURFACES = [
  {
    name: 'git-push merge (mergeOpeningNightSent)',
    run: (mine, theirs) => mergeOpeningNightSent(mine, theirs).merged,
  },
  {
    name: 'REST/gh-api sync (mergeTrackerEntries)',
    run: (mine, theirs) => mergeTrackerEntries(theirs, mine),
  },
];

function showsOf(record) {
  return { shows: { 'giant-2026': record } };
}

// ---- Scenario: opening-night-poller observes 'queued' before broadcast-send's
// 'sent' write lands on origin — the exact regression task #1914 closed for
// reconcile-broadcast-state.js's own writes; here driven by two DIFFERENT
// named writers to confirm the fix generalizes across the whole writer set. ----

for (const { name, run } of SURFACES) {
  test(`${name}: a stale poller observation never clobbers a newer broadcast-send 'sent' state, in either arrival order`, () => {
    const pollerObservation = {
      draftStatus: 'queued',
      draftCreatedAt: '2026-04-11T12:00:00Z',
    };
    const broadcastSendResult = {
      draftStatus: 'sent',
      sentAt: '2026-04-11T12:05:00Z',
      recipientCount: 5000,
      draftCreatedAt: '2026-04-11T12:00:00Z',
    };

    // Order A: poller's stale write arrives locally, broadcast-send's newer
    // write is what's already on the other side.
    const orderA = run(showsOf(pollerObservation), showsOf(broadcastSendResult));
    assert.equal(orderA.shows['giant-2026'].draftStatus, 'sent');
    assert.equal(orderA.shows['giant-2026'].recipientCount, 5000);

    // Order B: reversed — broadcast-send's write is local, the poller's
    // stale observation is what's on the other side. Same real-world
    // recency, so the same winner must come out regardless of which side
    // happened to observe first.
    const orderB = run(showsOf(broadcastSendResult), showsOf(pollerObservation));
    assert.equal(orderB.shows['giant-2026'].draftStatus, 'sent');
    assert.equal(orderB.shows['giant-2026'].recipientCount, 5000);
  });
}

// ---- Scenario: three writers race on the same key with three distinct
// content timestamps — the merge must always surface the single newest one,
// no matter which pairwise order the races happen to resolve in. ----

for (const { name, run } of SURFACES) {
  test(`${name}: three-way race on one key converges on the single newest write under every pairwise merge order`, () => {
    // t1 vs t2 are distinguishable ONLY by draftCreatedAt (t2 has no sentAt) —
    // deliberately, so a comparator that ignores draftCreatedAt and only
    // checks sentAt (leaving t1/t2 recency-tied) fails this test, not just a
    // comparator that ignores recency altogether. t2 models the orchestrator
    // re-issuing a draft on a retry (a real observed shape — e.g.
    // schmigadoon-2026's draftId changed between its preview and sent
    // records in data/opening-night-sent.json); applyResendStatusUpdate
    // (scripts/lib/broadcast-state.js) never sets sentAt on a 'sending'
    // transition, only on a confirmed 'sent' one, so t2 deliberately does not
    // fabricate one.
    const t1 = { draftStatus: 'draft', draftCreatedAt: '2026-04-11T10:00:00Z', method: 'orchestrator-draft' };
    const t2 = { draftStatus: 'draft', draftCreatedAt: '2026-04-11T11:00:00Z', method: 'orchestrator-redraft' };
    const t3 = { draftStatus: 'sent', draftCreatedAt: '2026-04-11T11:00:00Z', sentAt: '2026-04-11T12:00:00Z', method: 'broadcast-send', recipientCount: 4800 };
    const records = [t1, t2, t3];

    // Every ordering two writers' updates could plausibly arrive in.
    const orders = [
      [t1, t2, t3], [t1, t3, t2], [t2, t1, t3],
      [t2, t3, t1], [t3, t1, t2], [t3, t2, t1],
    ];

    for (const order of orders) {
      let state = { shows: {} };
      for (const rec of order) {
        state = run(showsOf(rec), state);
      }
      assert.equal(
        state.shows['giant-2026'].method,
        'broadcast-send',
        `order ${order.map((r) => r.method).join(' -> ')} must converge on the newest write (broadcast-send)`,
      );
      assert.equal(state.shows['giant-2026'].recipientCount, 4800);
    }
    // Sanity: the fixture actually has three DISTINCT recency values (via the
    // real recordRecencyMs comparator, not a raw string comparison — this is
    // what the merge functions themselves compare) or this test would pass
    // vacuously.
    assert.equal(new Set(records.map((r) => recordRecencyMs(r))).size, 3);
  });
}

// ---- Scenario: concurrent writers touching DIFFERENT keys/shows must union,
// never lose an untouched show's record just because another show raced it. ----

for (const { name, run } of SURFACES) {
  test(`${name}: concurrent writers on different shows union without loss (per-show poller isolation)`, () => {
    const mine = {
      shows: {
        'giant-2026': { draftStatus: 'sent', sentAt: '2026-04-11T12:00:00Z' },
      },
    };
    const theirs = {
      shows: {
        'schmigadoon-2026': { draftStatus: 'draft', draftCreatedAt: '2026-04-11T12:52:43Z' },
        'the-balusters-2026': { draftStatus: 'sending', draftCreatedAt: '2026-04-22T14:06:25Z' },
      },
    };
    const merged = run(mine, theirs);
    assert.equal(merged.shows['giant-2026'].draftStatus, 'sent');
    assert.equal(merged.shows['schmigadoon-2026'].draftStatus, 'draft');
    assert.equal(merged.shows['the-balusters-2026'].draftStatus, 'sending');
  });
}

// ---- Scenario: reconcile-newsletter-state's overdue-alert records carry no
// sentAt/draftCreatedAt (only lastOverdueAlertAt, an observation not in
// RECENCY_FIELDS by design). Neither side has a comparable content
// timestamp, so both surfaces must fall back to their documented default
// winner — deterministically, not by accident. ----

for (const { name, run } of SURFACES) {
  test(`${name}: overdue-alert records with no comparable recency field use the deterministic default winner`, () => {
    // "theirs" carries the chronologically NEWER lastOverdueAlertAt, and
    // "mine" must still win — the discriminating case. If a regression ever
    // added lastOverdueAlertAt back into RECENCY_FIELDS (the exact bug class
    // tracker-record-recency.js's header comment warns against for the
    // sibling field lastReconciledAt), "theirs" would incorrectly win here
    // instead. Giving "mine" the newer value, as an earlier draft of this
    // test did, would let that same regression pass unnoticed since "mine"
    // wins either way.
    const mine = showsOf({ lastOverdueAlertAt: '2026-04-10T09:00:00.000Z', draftStatus: 'draft' });
    const theirs = showsOf({ lastOverdueAlertAt: '2026-04-11T11:02:38.978Z', draftStatus: 'draft' });
    const merged = run(mine, theirs);
    // Documented default: the "mine" side wins when no content timestamp is
    // comparable — see mergeOpeningNightSent's and mergeTrackerEntries' own
    // header comments. Assert the winner is deterministic and matches that
    // contract, not "some" value.
    assert.equal(merged.shows['giant-2026'].lastOverdueAlertAt, '2026-04-10T09:00:00.000Z');
  });
}

// ---- Scenario: both reconciliation surfaces must agree with each other on
// the winner for the identical conflict, since they share one comparator
// (scripts/lib/tracker-record-recency.js) by design (task #1914). If they
// ever diverge, the file's true state depends on which sync path happens to
// run next — exactly the class of bug this card exists to prevent. ----

test('git-push merge and REST/gh-api sync surfaces agree on the winner for the same conflict', () => {
  const older = { draftStatus: 'queued', draftCreatedAt: '2026-04-11T12:00:00Z' };
  const newer = { draftStatus: 'sent', sentAt: '2026-04-11T12:05:00Z', draftCreatedAt: '2026-04-11T12:00:00Z' };

  const viaGitPush = mergeOpeningNightSent(showsOf(older), showsOf(newer)).merged;
  const viaRestSync = mergeTrackerEntries(showsOf(newer), showsOf(older));

  assert.equal(viaGitPush.shows['giant-2026'].draftStatus, 'sent');
  assert.equal(viaRestSync.shows['giant-2026'].draftStatus, 'sent');
  assert.deepEqual(viaGitPush.shows['giant-2026'], viaRestSync.shows['giant-2026']);
});
