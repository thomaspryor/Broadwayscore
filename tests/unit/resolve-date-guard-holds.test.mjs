// BRO-5032: automatic resolution of date-guard holds. Requires the real
// resolveHoldDecision (CLAUDE.md rule 15), never a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveHoldDecision, classifyDateGuardBackstop, applyDateGuardHold, clearDateGuardHold } =
  require('../../scripts/lib/date-guard-hold.js');

const show = { id: 'x-2026', title: 'Sample Show', category: 'broadway', previewsStartDate: '2026-03-01', openingDate: '2026-03-20', closingDate: '2026-09-01' };
const held = (extra = {}) => ({ publishDate: '2025-12-01', fullText: 'A fine review of Sample Show.', ...extra });

test('in-run refetch date corrects publishDate', () => {
  const d = resolveHoldDecision({ review: held(), show, refetch: { ok: true, date: '2026-03-21' }, cv: null });
  assert.equal(d.action, 'correct-date');
  assert.equal(d.date, '2026-03-21');
  // The corrected record no longer trips the backstop.
  const fixed = held({ publishDate: d.date });
  assert.equal(classifyDateGuardBackstop({ review: fixed, show }).kind, 'ok');
});

test('in-run date but Time Out style republish becomes wrongProduction', () => {
  const text = 'This review is from 2025. Sample Show was great.';
  const d = resolveHoldDecision({ review: held(), show, refetch: { ok: true, date: '2026-03-21', text }, cv: null });
  assert.equal(d.action, 'wrong-production');
});

test('same old date asks for CV, then affirm or reject', () => {
  const refetch = { ok: true, date: '2025-12-01' };
  assert.equal(resolveHoldDecision({ review: held(), show, refetch, cv: null }).action, 'need-cv');
  assert.equal(resolveHoldDecision({ review: held(), show, refetch, cv: { isValid: true, confidence: 'high' } }).action, 'cv-affirm');
  assert.equal(resolveHoldDecision({ review: held(), show, refetch, cv: { isValid: false, wrongProduction: true, confidence: 'high' } }).action, 'wrong-production');
});

test('inconclusive CV retries, then exhausts on the third attempt', () => {
  const refetch = { ok: true, date: null };
  const cv = { isValid: true, confidence: 'low' };
  assert.equal(resolveHoldDecision({ review: held(), show, refetch, cv, attempts: 0 }).action, 'retry');
  assert.equal(resolveHoldDecision({ review: held(), show, refetch, cv, attempts: 2 }).action, 'exhausted');
});

test('fetch failure retries without spending an attempt', () => {
  const d = resolveHoldDecision({ review: held(), show, refetch: { ok: false }, cv: null });
  assert.equal(d.action, 'retry');
  assert.equal(d.countAttempt, false);
});

test('never touches a humanReviewScore or exhausted file', () => {
  assert.equal(resolveHoldDecision({ review: held({ humanReviewScore: 80 }), show, refetch: { ok: true, date: '2026-03-21' }, cv: null }).action, 'refuse');
  assert.equal(resolveHoldDecision({ review: held({ dateGuardResolveExhausted: { at: 'x' } }), show, refetch: { ok: true, date: '2026-03-21' }, cv: null }).action, 'refuse');
});

test('marker round trip: apply then clear', () => {
  const r = held();
  applyDateGuardHold(r, { signals: ['cv-affirms-production'] });
  assert.ok(r.dateGuardHeld);
  assert.equal(clearDateGuardHold(r), true);
  assert.equal(r.dateGuardHeld, null);
});

test('CV affirm does not resolve a date past the 180-day backstop', () => {
  const far = { publishDate: '2018-05-01', fullText: 'x' };
  const d = resolveHoldDecision({ review: far, show, refetch: { ok: true, date: '2018-05-01' }, cv: { isValid: true, confidence: 'high' }, attempts: 2 });
  assert.equal(d.action, 'exhausted');
});

test('refuses files with an operator decision on them', () => {
  for (const f of [{ _locked: true }, { wrongProductionOverride: true }, { wrongProductionManualClear: true }, { humanReviewedWrongProduction: false }, { publishDateVerified: true }]) {
    assert.equal(resolveHoldDecision({ review: held(f), show, refetch: { ok: true, date: '2026-03-21' }, cv: null }).action, 'refuse');
  }
});
