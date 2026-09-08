// BRO-392 — "Audit Aggregator Review Gap" workflow repeat-failure.
//
// Root cause: audit-show-review-gap.js's blast-radius guard quarantines a
// show whose coverage state changed too much to trust, and rolls its
// gap-audit-checkpoint.json entry back to the PRE-quarantine snapshot
// (rollbackCheckpointEntries -> applyCheckpointRollback in
// scripts/lib/gap-audit-checkpoint.js). Before this fix, `at` was the ONLY
// timestamp, and compareAuditPriority (scripts/lib/gap-audit-freshness.js)
// always selects the OLDEST one first — so a show whose `at` never advances
// becomes permanently "most overdue" and gets re-selected into nearly every
// subsequent hourly batch, re-tripping the guard and reddening the workflow
// run after run. Confirmed against real production runs (2026-09-07/08):
// the same ~9-10 off-broadway shows, frozen at an early-August `at`,
// recurred in nearly every hourly run and made the job fail almost every
// tick.
//
// The fix separates two concerns that were sharing one field:
//   - `checkedAt` — scheduling only. Stamped unconditionally every run
//     (audit-show-review-gap.js's per-show loop, before the blast-radius
//     guard even runs) and NEVER touched by rollback. checkpointTs() now
//     reads this first.
//   - `at`/`gaps`/`uncollected` — the last genuinely TRUSTED snapshot.
//     Rollback restores these in full on a refused run, exactly like the
//     original #923/#893 design — this is what newsletter-preflight.js's
//     classifyGapEntry() reads as a hard completeness gate, so it must never
//     see a refused run's numbers.
//
// (Two earlier attempts at this fix used a rollback-streak cap that let `at`
// itself advance after N strikes — each version leaked either the refused
// run's own untrusted numbers, or a stale-but-old-trusted snapshot paired
// with a suspiciously fresh `at`, into the newsletter gate. Splitting the
// timestamp into two fields with two different consumers removes that whole
// class of bug: scheduling can move forward unconditionally because it no
// longer shares a field with anything that requires trust.)
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { applyCheckpointRollback } = require('../../scripts/lib/gap-audit-checkpoint.js');
const { compareAuditPriority } = require('../../scripts/lib/gap-audit-freshness.js');

test('a chronically-risky show\'s scheduling clock keeps advancing across refused runs, even though its trusted snapshot never does', () => {
  const trustedSnapshot = { at: '2026-08-17T09:42:27.329Z', gaps: 3, uncollected: 3 };
  let checkpoint = { 'stuck-show': trustedSnapshot };
  const checkpointAtStart = checkpoint; // never becomes trusted again — always refused

  let lastCheckedAt = null;
  for (let run = 1; run <= 20; run++) {
    const thisRunStamp = {
      at: new Date(Date.now() + run).toISOString(),
      checkedAt: new Date(Date.now() + run).toISOString(),
      gaps: 0,
      uncollected: 0,
    };
    checkpoint = applyCheckpointRollback({ 'stuck-show': thisRunStamp }, ['stuck-show'], checkpointAtStart);
    assert.strictEqual(checkpoint['stuck-show'].at, trustedSnapshot.at, `run ${run}: trusted 'at' must never move`);
    assert.strictEqual(checkpoint['stuck-show'].gaps, trustedSnapshot.gaps, `run ${run}: trusted 'gaps' must never move`);
    assert.notStrictEqual(checkpoint['stuck-show'].checkedAt, lastCheckedAt, `run ${run}: checkedAt must advance every run`);
    lastCheckedAt = checkpoint['stuck-show'].checkedAt;
  }
});

test('before the fix (single at-field model): a rolled-back show is permanently "most overdue" against a healthily-audited peer', () => {
  // Reproduces the ORIGINAL bug shape directly: `at` is both the trust
  // timestamp AND the only thing compareAuditPriority sorts on. Restoring
  // the exact pre-quarantine `at` every run means it never advances no
  // matter how many runs pass.
  const ancientAt = '2026-08-17T00:00:00.000Z';
  const stuckShowEntry = { at: ancientAt, gaps: 3 }; // no checkedAt — the old shape
  const peerEntry = { at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }; // audited 24h ago

  const order = compareAuditPriority(
    { id: 'stuck-show', status: 'closed' },
    { id: 'healthy-peer', status: 'closed' },
    { 'stuck-show': stuckShowEntry, 'healthy-peer': peerEntry },
    Date.now()
  );
  assert.ok(order < 0, 'the perpetually-stale show sorts ahead of a normally-audited peer, dominating every batch — the literal starvation bug');
});

test('after the fix: checkedAt gives scheduling its own clock, so the same chronically-risky show falls back behind a fresh peer', () => {
  const checkpointAtStart = { 'stuck-show': { at: '2026-08-17T00:00:00.000Z', gaps: 3, uncollected: 3 } };
  // Ten refused runs, exactly like the "before" scenario — but checkedAt
  // advances every time because it's stamped unconditionally and rollback
  // never touches it.
  let checkpoint = checkpointAtStart;
  for (let run = 1; run <= 10; run++) {
    const thisRunStamp = { at: new Date(Date.now() + run).toISOString(), checkedAt: new Date(Date.now() + run).toISOString(), gaps: 0, uncollected: 0 };
    checkpoint = applyCheckpointRollback({ 'stuck-show': thisRunStamp }, ['stuck-show'], checkpointAtStart);
  }

  const peer = { at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }; // legacy shape, no checkedAt
  const order = compareAuditPriority(
    { id: 'stuck-show', status: 'closed' },
    { id: 'healthy-peer', status: 'closed' },
    { 'stuck-show': checkpoint['stuck-show'], 'healthy-peer': peer },
    Date.now()
  );
  assert.ok(order > 0, 'once checkedAt is fresh, the show no longer out-prioritizes a normally-audited peer');
});

test('the fix never lets a refused run\'s completeness numbers become trusted (1st Codex adversarial review finding)', () => {
  // newsletter-preflight.js's classifyGapEntry() reads `at` + `uncollected`
  // off this exact file as a HARD send-blocking gate: a fresh `at` with
  // `uncollected: 0` reads as 'ok' and clears a show to send. Two earlier
  // cuts of this fix each let some version of untrusted/stale data escape
  // once a "circuit breaker" tripped. The final design has no breaker to
  // trip: `at`/gaps/uncollected are ALWAYS fully restored from the last
  // trusted snapshot, unconditionally, forever — there's no cap, no streak,
  // no path where refused numbers become trusted numbers.
  const checkpointAtStart = { 'stuck-show': { at: '2026-08-17T00:00:00.000Z', gaps: 5, uncollected: 5 } };
  const refusedRunClaim = { at: new Date().toISOString(), checkedAt: new Date().toISOString(), gaps: 0, uncollected: 0 }; // the lie
  const rolled = applyCheckpointRollback({ 'stuck-show': refusedRunClaim }, ['stuck-show'], checkpointAtStart);
  assert.strictEqual(rolled['stuck-show'].at, checkpointAtStart['stuck-show'].at, 'trusted "at" never advances to the refused run\'s stamp');
  assert.strictEqual(rolled['stuck-show'].uncollected, 5, 'must NOT adopt the refused run\'s uncollected count');
  assert.strictEqual(rolled['stuck-show'].gaps, 5, 'must NOT adopt the refused run\'s gaps count');
  assert.strictEqual(rolled['stuck-show'].checkedAt, refusedRunClaim.checkedAt, 'scheduling DOES advance — that is the actual fix');
});

test('the fix never pairs a fresh timestamp with stale-but-once-trusted data (2nd Codex adversarial review finding)', () => {
  // A design that let `at` itself advance once some cap tripped (an earlier
  // cut of this fix) would eventually pair a brand-new `at` with WEEKS-OLD
  // gaps/uncollected — upgrading an honest "this data is old, treat as
  // unverified" signal into a false "fresh and complete" one. Since `at`
  // now NEVER advances except on a genuine, non-refused, trusted audit, this
  // failure mode has no code path left to occur through.
  const weeksOldTrusted = { at: '2026-07-01T00:00:00.000Z', gaps: 0, uncollected: 0 };
  const checkpointAtStart = { 'show-a': weeksOldTrusted };
  const refusedRunStamp = { at: new Date().toISOString(), checkedAt: new Date().toISOString(), gaps: 4, uncollected: 4 };
  const rolled = applyCheckpointRollback({ 'show-a': refusedRunStamp }, ['show-a'], checkpointAtStart);
  assert.strictEqual(rolled['show-a'].at, weeksOldTrusted.at, '"at" stays exactly the old trusted timestamp — never refreshed by a refused run');
});
