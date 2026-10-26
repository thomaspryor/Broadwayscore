import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildCommercialEntry } = require('./commercial-apply-gate');
const { sanitizeForPublicRecord } = require('./commercial-record-checks');
const { classifyStaleClosure, buildClassifiedClosureEntry, closedTbdLossAction, undoAutoFizzleOnRunningShow } = require('./classify-stale-closure');

const now = Date.parse('2026-10-15T12:00:00Z');
const show = { status: 'closed', closingDate: '2026-07-01' };
const later = Date.parse('2027-01-01T12:00:00Z');
const day = 86400000;
const pending = { designation: 'Flop', recouped: false, ownerApproved: true };
const release = (row = pending) => sanitizeForPublicRecord(
  buildCommercialEntry(row, { designation: 'TBD', researchAttempts: 0 }, { mergeExisting: true }),
  show, { ownerApproved: row.ownerApproved === true, now },
).entry;

const estimate = (pct, extra = {}) => ({ designation: 'TBD', modelDataQuality: 'low', modelReturnedExCreditPct: [pct - 10, pct, pct + 10], ...extra });

test('an owner-approved verdict is written at once as a human-reviewed label, with no wait', () => {
  const entry = release();
  assert.equal(entry.designation, 'Flop');
  assert.equal(entry.humanReviewedDesignation, true);
  assert.equal(entry.ownerDesignationAfterWindow, undefined);
  assert.equal(entry.ownerDesignationReviewedAt, undefined);
  const automated = release({ ...pending, ownerApproved: false });
  // Research alone is sized by its estimate (none here: Did Not Recoup) and never marked reviewed.
  assert.equal(automated.designation, 'Did Not Recoup');
  assert.notEqual(automated.humanReviewedDesignation, true);
});

test('a closed show is labelled from our estimate right after the grace days, at any data quality (BRO-6158)', () => {
  const closed = Date.parse(show.closingDate);
  const at = (days, entry, thresholds) => classifyStaleClosure({ show, entry, now: closed + days * day, thresholds });
  assert.equal(at(3, estimate(10)).action, 'wait');
  for (const [pct, label] of [[10, 'Flop'], [29, 'Flop'], [30, 'Fizzle'], [70, 'Fizzle'], [100, 'Trickle'], [149, 'Trickle'], [150, 'Windfall'], [-40, 'Flop']]) {
    const r = at(20, estimate(pct, { researchAttempts: 0 }));
    assert.equal(r.action, 'classify-fizzle', `${pct}%`);
    assert.equal(r.designation, label, `${pct}%`);
    assert.equal(r.designationBasis, 'model-estimate');
  }
  // An analyst's range outranks the model.
  assert.equal(at(20, estimate(90, { analystRecoupPct: [5, 15] })).designation, 'Flop');
  // No figure at all, or the kill switch: stays TBD and flagged.
  assert.equal(at(20, { designation: 'TBD', researchAttempts: 1 }).action, 'flag-needs-loss-evidence');
  assert.equal(at(200, estimate(10), { requireLossEvidence: true }).action, 'flag-needs-loss-evidence');
});

test('an estimate never asserts Not Recouped, and an owner verdict still does', () => {
  const r = classifyStaleClosure({ show, entry: estimate(20), now: later });
  const written = buildClassifiedClosureEntry(estimate(20), show, r, later);
  assert.equal(written.designation, 'Flop');
  assert.equal(written.designationBasis, 'model-estimate');
  assert.equal(written.recouped ?? null, null);
  assert.equal(written.recoupedSource ?? null, null);
  assert.equal(classifyStaleClosure({ show, entry: written, now: later }).action, 'no-change');
  const owner = classifyStaleClosure({ show, entry: { designation: 'TBD', ownerDesignationAfterWindow: 'Fizzle' }, now: later });
  assert.equal(owner.designation, 'Fizzle');
  assert.equal(owner.humanReviewedDesignation, true);
  assert.equal(buildClassifiedClosureEntry({}, show, owner, later).recouped, false);
});

test('recoupment, running shows, carve-outs and review locks still protect a closed row', () => {
  const entry = estimate(20);
  const classify = (overrides) => classifyStaleClosure({ show, entry, now: later, ...overrides });
  assert.equal(classify({ show: { ...show, status: 'open' } }).action, 'no-change');
  assert.equal(classify({ show: { ...show, closingDate: 'invalid' } }).action, 'no-change');
  assert.equal(classify({ entry: { ...entry, recouped: true } }).action, 'no-change');
  assert.equal(classify({ entry: { ...entry, humanReviewedDesignation: true } }).action, 'no-change');
  assert.equal(classify({ entry: { ...entry, productionType: 'tour-stop' } }).action, 'skip-carve-out');
  const returnRun = classify({ entry: { ...entry, productionType: 'return-engagement' } });
  assert.equal(returnRun.action, 'classify-fizzle');
  assert.equal(returnRun.designation, 'Flop');
  assert.equal(classify({ pending: { recouped: true, researchedAt: new Date(later).toISOString() } }).action, 'human-review');
});

test('cleanup labels a closed TBD row from its estimate with no age wait, and flags one with no figure', () => {
  const act = closedTbdLossAction(estimate(55), show, { now });
  assert.deepEqual(act, { action: 'label', designation: 'Fizzle', designationBasis: 'model-estimate' });
  assert.deepEqual(closedTbdLossAction({ designation: 'TBD' }, show, { now }), { action: 'flag' });
  assert.equal(closedTbdLossAction(estimate(55), { ...show, status: 'open' }, { now }), null);
  assert.equal(closedTbdLossAction(estimate(55, { humanReviewedDesignation: true }), show, { now }), null);
  assert.equal(closedTbdLossAction(estimate(55, { recouped: true }), show, { now }), null);
  // A closed return engagement is labelled like any run; tours and transfers stay carved out (BRO-6218).
  assert.deepEqual(closedTbdLossAction(estimate(55, { productionType: 'return-engagement' }), show, { now }),
    { action: 'label', designation: 'Fizzle', designationBasis: 'model-estimate' });
  assert.equal(closedTbdLossAction(estimate(55, { productionType: 'international-transfer' }), show, { now }), null);
  assert.equal(closedTbdLossAction(estimate(55, { productionType: 'tour-stop' }), show, { now }), null);
  assert.equal(closedTbdLossAction(estimate(55, { productionType: 'International Transfer' }), show, { now }), null);
  assert.deepEqual(closedTbdLossAction({ designation: 'TBD', productionType: 'return-engagement' }, show, { now }), { action: 'flag' });
});

test('a recoupment announced later resets an estimate, and a reopened show undoes it', () => {
  const labelled = { designation: 'Flop', designationBasis: 'model-estimate', modelReturnedExCreditPct: [0, 10, 20] };
  const claim = buildCommercialEntry({ recouped: true, recoupedDate: '2026-12' }, labelled, { isClaimAutoApply: true });
  assert.equal(claim.designation, 'TBD');
  assert.equal(claim.recouped, true);
  assert.equal(undoAutoFizzleOnRunningShow(labelled, { status: 'open' }).designation, 'TBD');
});

test('the held-release CLI writes an owner-approved verdict straight away (BRO-6158)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5113-'));
  try {
    const write = (file, data) => fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
    write('pending.json', { shows: {
      approved: { ...pending, requiresHumanReview: true, confidence: 'high' },
      research: { ...pending, ownerApproved: false, requiresHumanReview: true, confidence: 'high' },
    } });
    write('commercial.json', { shows: {} });
    write('shows.json', { shows: ['approved', 'research'].map(slug => ({
      id: slug, slug, title: slug, category: 'broadway', status: 'closed',
      closingDate: new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10),
    })) });
    const out = execFileSync(process.execPath, [
      path.resolve('scripts/apply-commercial-pending.js'), '--dry-run', '--no-source-verify',
      '--release-held=approved,research', `--pending-file=${dir}/pending.json`,
      `--commercial-file=${dir}/commercial.json`, `--shows-file=${dir}/shows.json`,
    ], { encoding: 'utf8' });
    assert.match(out, /Would apply "approved"[^\n]*"designation":"Flop"/);
    assert.match(out, /Would apply "approved"[^\n]*"humanReviewedDesignation":true/);
    assert.doesNotMatch(out, /ownerDesignationAfterWindow/);
    assert.match(out, /would apply 2, skip 0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
