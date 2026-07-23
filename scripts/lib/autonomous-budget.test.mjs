import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const budget = require('./autonomous-budget.js');
const {
  ENVELOPES, pickModel, createNightBudget, checkSharedDailyCap, FORBIDDEN_MODEL_RE, estimateUSD,
} = budget;

// ── pickModel policy ────────────────────────────────────────────────────────

test('attempt 1 is Sonnet; attempt 2 escalates to Opus only on content failure', () => {
  assert.equal(pickModel(1), 'claude-sonnet-5');
  assert.equal(pickModel(2, 'content'), 'claude-opus-4-8');
  assert.equal(pickModel(2, 'infra'), 'claude-sonnet-5');
  assert.equal(pickModel(2, null), 'claude-sonnet-5');
  assert.equal(pickModel(2, 'rebase-conflict'), 'claude-sonnet-5');
});

test('attempt cap 2: attempt 3 throws', () => {
  assert.throws(() => pickModel(3, 'content'), /attempt cap/);
  assert.throws(() => pickModel(0), /attempt cap/);
});

// Hard exclusion (user directive, mock-v2 2026-07-12): fable is NEVER
// selectable, for any input. Enumerate every reachable output.
test('fable/mythos tier is never selectable by pickModel', () => {
  const kinds = ['content', 'infra', null, undefined, 'anything', 'FABLE'];
  for (const attempt of [1, 2]) {
    for (const kind of kinds) {
      assert.ok(!FORBIDDEN_MODEL_RE.test(pickModel(attempt, kind)),
        `pickModel(${attempt}, ${kind}) must not be fable-tier`);
    }
  }
});

// ── Admission + reservation ─────────────────────────────────────────────────

test('admission reserves worst case (both attempts)', () => {
  const b = createNightBudget({ nightUSD: 10, reserveUSD: 0.5, sizes: ['S'] });
  const r = b.admit('c1', 'S');
  assert.equal(r.admitted, true);
  assert.equal(r.reservedUSD, 6); // estUSD 2 + estAttempt2USD 4
  assert.equal(b.remaining(), 3.5); // 9.5 - 6
});

test('M card refused when 2-attempt estimate exceeds remaining (VERIFY line)', () => {
  // Night $18 → available $17.5. One S card reserves $6 → remaining $11.5.
  // M worst case is $12 → refused even though $11.5 remains.
  const b = createNightBudget({ nightUSD: 18, reserveUSD: 0.5, sizes: ['S', 'M'], maxItems: 5 });
  assert.equal(b.admit('s1', 'S').admitted, true);
  const m = b.admit('m1', 'M');
  assert.equal(m.admitted, false);
  assert.match(m.reason, /worst-case \$12\.00.*exceeds remaining \$11\.50/);
});

test('a genuinely unknown size has no envelope and is refused', () => {
  const b = createNightBudget({ nightUSD: 50, sizes: ['S', 'M', 'L', 'XL'], maxItems: 5 });
  const r = b.admit('xl1', 'XL');
  assert.equal(r.admitted, false);
  assert.match(r.reason, /no budget envelope/);
});

// L (Sprint 3, S3-T4): has a real envelope now — one S-sized slice per night,
// no attempt-2 reservation (the checkpoint IS the retry, next night).
test('L has a one-slice-per-night envelope: incremental, no attempt-2 reservation', () => {
  assert.equal(ENVELOPES.L.incremental, true);
  assert.equal(ENVELOPES.L.estAttempt2USD, 0);
  const b = createNightBudget({ nightUSD: 5, reserveUSD: 0.5, sizes: ['L'], maxItems: 5 });
  const r = b.admit('l1', 'L');
  assert.equal(r.admitted, true);
  assert.equal(r.reservedUSD, ENVELOPES.L.estUSD); // no attempt-2 slice reserved
});

test('L not enabled tonight is refused just like S/M (same size gate)', () => {
  const b = createNightBudget({ nightUSD: 50, sizes: ['S', 'M'], maxItems: 5 });
  const r = b.admit('l1', 'L');
  assert.equal(r.admitted, false);
  assert.match(r.reason, /not enabled tonight/);
});

test('size not enabled tonight is refused (S-only first live night)', () => {
  const b = createNightBudget({ nightUSD: 50, sizes: ['S'], maxItems: 5 });
  const r = b.admit('m1', 'M');
  assert.equal(r.admitted, false);
  assert.match(r.reason, /not enabled tonight/);
});

test('night item cap refuses further admissions', () => {
  const b = createNightBudget({ nightUSD: 50, maxItems: 2, sizes: ['S'] });
  assert.equal(b.admit('a', 'S').admitted, true);
  assert.equal(b.admit('b', 'S').admitted, true);
  const r = b.admit('c', 'S');
  assert.equal(r.admitted, false);
  assert.match(r.reason, /item cap/);
});

// ── Attempt-2 refund (carry-forward #3) ─────────────────────────────────────

test('refundAttempt2 returns the attempt-2 slice to the pool when attempt 1 lands', () => {
  const b = createNightBudget({ nightUSD: 10, reserveUSD: 0.5, sizes: ['S'] });
  b.admit('c1', 'S'); // remaining 3.5 — a second S ($6 worst case) would be refused
  assert.equal(b.admit('c2', 'S').admitted, false);
  const refund = b.refundAttempt2('c1', 'S');
  assert.equal(refund, ENVELOPES.S.estAttempt2USD); // 4 back
  assert.equal(b.remaining(), 7.5);
  assert.equal(b.admit('c2', 'S').admitted, true, 'refund restores headroom for the next card');
});

test('settle swaps the rest of the reservation for actual spend', () => {
  const b = createNightBudget({ nightUSD: 10, reserveUSD: 0.5, sizes: ['S'] });
  b.admit('c1', 'S');
  b.refundAttempt2('c1', 'S');
  b.settle('c1', 0.55); // actual < est 2
  const s = b.state();
  assert.equal(s.reserved, 0);
  assert.equal(s.spent, 0.55);
  assert.equal(b.remaining(), 8.95);
});

test('settle on a card that used attempt 2 keeps both attempts of spend', () => {
  const b = createNightBudget({ nightUSD: 10, reserveUSD: 0.5, sizes: ['S'] });
  b.admit('c1', 'S');
  b.settle('c1', 5.1); // spent through the retry — no refund was taken
  assert.equal(b.state().spent, 5.1);
  assert.equal(b.remaining(), 4.4); // available 9.5 − spent 5.1
});

// ── Runaway card cut at sub-budget (VERIFY line) ────────────────────────────

test('shouldAbort cuts a runaway card at its per-card sub-budget', () => {
  const b = createNightBudget({ nightUSD: 50, sizes: ['S'] });
  assert.equal(b.shouldAbort('S', { elapsedMin: 5, attemptUSD: 0.4 }).abort, false);
  const overUSD = b.shouldAbort('S', { elapsedMin: 5, attemptUSD: 4.2 });
  assert.equal(overUSD.abort, true);
  assert.match(overUSD.reason, /per-card cap \$4\.00/);
  const overWall = b.shouldAbort('S', { elapsedMin: 46, attemptUSD: 0.1 });
  assert.equal(overWall.abort, true);
  assert.match(overWall.reason, /wall clock/);
});

// ── Shared daily cap ────────────────────────────────────────────────────────

test('checkSharedDailyCap: $5 ok, half-cap warns, over-cap refuses', () => {
  assert.equal(checkSharedDailyCap(5).ok, true);
  assert.equal(checkSharedDailyCap(5).warning, undefined);
  assert.ok(checkSharedDailyCap(60).warning); // >50% of the $100 shared cap
  assert.equal(checkSharedDailyCap(60).ok, true); // owner 2026-07-22: $60 nights must pass
  assert.equal(checkSharedDailyCap(120).ok, false);
});

// ── Weekly clamp (owner 2026-07-22: high nightly ceiling, bounded week) ─────

test('clampNightToWeekly: no weekly cap → untouched', () => {
  const { clampNightToWeekly } = budget;
  assert.deepEqual(clampNightToWeekly(60, null, 999), { nightUSD: 60, clamped: false });
});

test('clampNightToWeekly: under the weekly cap → untouched', () => {
  const { clampNightToWeekly } = budget;
  assert.deepEqual(clampNightToWeekly(60, 150, 80), { nightUSD: 60, clamped: false });
});

test('clampNightToWeekly: trailing spend shrinks tonight', () => {
  const { clampNightToWeekly } = budget;
  const r = clampNightToWeekly(60, 150, 120);
  assert.equal(r.clamped, true);
  assert.equal(r.nightUSD, 30);
  assert.match(r.reason, /weekly cap/);
});

test('clampNightToWeekly: exhausted week floors at $0, never negative', () => {
  const { clampNightToWeekly } = budget;
  const r = clampNightToWeekly(60, 150, 170);
  assert.equal(r.clamped, true);
  assert.equal(r.nightUSD, 0);
});

test('config validation: bad nightUSD/maxItems throw', () => {
  assert.throws(() => createNightBudget({ nightUSD: 0 }), /nightUSD/);
  assert.throws(() => createNightBudget({ maxItems: 0.5 }), /maxItems/);
});

// ── estimateUSD (raw-API triage cost, night-1 fix #4) ───────────────────────

test('estimateUSD prices by model family and never crashes on junk', () => {
  // Sonnet: $3/MTok in, $15/MTok out → 100k in + 10k out = $0.45
  assert.equal(estimateUSD('claude-sonnet-5', 100_000, 10_000), 0.45);
  // date-suffixed ids still price via substring match
  assert.equal(estimateUSD('claude-sonnet-5-20260101', 1_000_000, 0), 3);
  assert.equal(estimateUSD('claude-opus-4-8', 1_000_000, 1_000_000), 30);
  assert.equal(estimateUSD('claude-haiku-4-5', 2_000_000, 0), 2);
  // unknown family / junk inputs → 0, never NaN or throw
  assert.equal(estimateUSD('gpt-4o', 100_000, 100_000), 0);
  assert.equal(estimateUSD(null, undefined, NaN), 0);
});
