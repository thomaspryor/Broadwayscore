import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeScorecard, reworkStats, cardOfBranch, THRESHOLDS } = require('./model-quality-scorecard.js');

const D = 86400 * 1000;
const SWITCH = '2026-12-01';
const SW = Date.parse(`${SWITCH}T00:00:00Z`);
const row = (ms, card, attempts = 1, prefix = 'land/bro') => ({ ts: new Date(ms).toISOString(), branch: `${prefix}-${card}-x`, attempts });

// n distinct cards landed spread over a window, plus `reworkN` second landings 1 day later.
function window(startMs, n, reworkN, attempts = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(row(startMs + i * 3600 * 1000, 1000 + Math.round(startMs / D) * 100 + i, i < 3 ? attempts : 1));
  for (let i = 0; i < reworkN; i++) out.push(row(startMs + D + i * 3600 * 1000 + 7e6, 1000 + Math.round(startMs / D) * 100 + i));
  return out;
}

test('cardOfBranch reads the card from a land branch', () => {
  assert.strictEqual(cardOfBranch('land/bro-8285-birthright-redirect'), 'BRO-8285');
  assert.strictEqual(cardOfBranch('land/data-fix'), null);
});

test('rework counts a card landing again 6h-7d later, not a same-hour split', () => {
  const t0 = SW;
  const rows = [row(t0, 1), row(t0 + 3600e3, 1), row(t0 + 2 * D, 1)];
  const s = reworkStats(rows, t0, t0 + 10 * D);
  assert.strictEqual(s.landed, 3);
  assert.strictEqual(s.rework, 1);
});

test('too little data is INSUFFICIENT DATA, never OK', () => {
  const landings = [...window(SW - 28 * D, 30, 0), ...window(SW, 5, 0)];
  const sc = computeScorecard({ sessionRows: [], landings, switchDate: SWITCH, nowMs: SW + 10 * D });
  assert.strictEqual(sc.verdict, 'INSUFFICIENT DATA');
});

test('a short after window is INSUFFICIENT DATA even with enough landings', () => {
  const landings = [...window(SW - 28 * D, 30, 0), ...window(SW, 20, 0)];
  const sc = computeScorecard({ sessionRows: [], landings, switchDate: SWITCH, nowMs: SW + 2 * D });
  assert.strictEqual(sc.verdict, 'INSUFFICIENT DATA');
});

test('rework doubling after the switch is WORSE', () => {
  const landings = [...window(SW - 28 * D, 40, 2), ...window(SW, 40, 14)];
  const sc = computeScorecard({ sessionRows: [], landings, switchDate: SWITCH, nowMs: SW + 10 * D });
  assert.strictEqual(sc.verdict, 'WORSE');
  assert.match(sc.reasons.join(' '), /rework rate/);
});

test("similar rates are OK", () => {
  const landings = [...window(SW - 28 * D, 40, 4), ...window(SW, 40, 4)];
  const sc = computeScorecard({ sessionRows: [], landings, switchDate: SWITCH, nowMs: SW + 10 * D });
  assert.strictEqual(sc.verdict, 'OK');
});

test('reopened cards need the minimum count before they can fail the check', () => {
  const landings = [...window(SW - 28 * D, 40, 4), ...window(SW, 40, 4)];
  const reopens = [{ ms: SW + D, card: 'BRO-1' }, { ms: SW + 2 * D, card: 'BRO-2' }];
  const sc = computeScorecard({ sessionRows: [], landings, reopens, switchDate: SWITCH, nowMs: SW + 10 * D });
  assert.strictEqual(sc.verdict, 'OK');
  assert.ok(THRESHOLDS.reopenMinCount > reopens.length);
  const many = [...reopens, { ms: SW + 3 * D, card: 'BRO-3' }, { ms: SW + 4 * D, card: 'BRO-4' }];
  assert.strictEqual(computeScorecard({ sessionRows: [], landings, reopens: many, switchDate: SWITCH, nowMs: SW + 10 * D }).verdict, 'WORSE');
});

test('minAfterDays boundary: just under 7 days is INSUFFICIENT DATA, exactly 7 days is judged', () => {
  const landings = [...window(SW - 28 * D, 30, 0), ...window(SW, 20, 0)];
  const under = computeScorecard({ sessionRows: [], landings, switchDate: SWITCH, nowMs: SW + 7 * D - 3600 * 1000 });
  assert.strictEqual(under.verdict, 'INSUFFICIENT DATA');
  const exact = computeScorecard({ sessionRows: [], landings, switchDate: SWITCH, nowMs: SW + 7 * D });
  assert.notStrictEqual(exact.verdict, 'INSUFFICIENT DATA');
  assert.strictEqual(THRESHOLDS.minAfterDays, 7);
});
