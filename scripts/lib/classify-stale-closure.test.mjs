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
const { classifyStaleClosure, buildClassifiedClosureEntry, closedTbdLossAction } = require('./classify-stale-closure');

const now = Date.parse('2026-10-15T12:00:00Z');
const show = { status: 'closed', closingDate: '2026-07-01' };
const afterWindow = Date.parse('2027-01-01T12:00:00Z');
const pending = { designation: 'Flop', recouped: false, ownerApproved: true };
const release = (row = pending) => sanitizeForPublicRecord(
  buildCommercialEntry(row, { designation: 'TBD', researchAttempts: 0 }, { mergeExisting: true }),
  show, { ownerApproved: row.ownerApproved === true, now },
).entry;

test('an owner Flop survives release as TBD, then is written as human-reviewed Flop', () => {
  const entry = release();
  assert.equal(entry.designation, 'TBD');
  assert.equal(entry.recouped, null);
  assert.equal(entry.ownerDesignationAfterWindow, 'Flop');
  assert.equal(entry.ownerDesignationReviewedAt, new Date(now).toISOString());
  assert.notEqual(entry.humanReviewedDesignation, true);
  const result = classifyStaleClosure({ show, entry, now: afterWindow });
  assert.equal(result.action, 'classify-fizzle');
  assert.equal(result.designation, 'Flop');
  assert.equal(result.humanReviewedDesignation, true);
  const written = buildClassifiedClosureEntry(entry, show, result, afterWindow);
  assert.equal(written.designation, 'Flop');
  assert.equal(written.recouped, false);
  assert.equal(written.humanReviewedDesignation, true);
  assert.equal(written.designationBasis, 'no-recoupment-announced');
  assert.equal(written.needsLossEvidence, undefined);
  assert.equal(classifyStaleClosure({ show, entry: written, now: afterWindow }).action, 'no-change');
});

test('Fizzle verdicts are preserved too, and research-only labels are never marked reviewed', () => {
  const entry = release({ ...pending, designation: 'Fizzle' });
  assert.equal(classifyStaleClosure({ show, entry, now: afterWindow }).designation, 'Fizzle');
  const automated = release({ ...pending, ownerApproved: false });
  assert.equal(automated.ownerDesignationAfterWindow, undefined);
  assert.equal(automated.ownerDesignationReviewedAt, undefined);
  const result = classifyStaleClosure({ show, entry: { ...automated, researchAttempts: 1 }, now: afterWindow });
  assert.equal(result.designation, 'Fizzle');
  assert.notEqual(buildClassifiedClosureEntry(automated, show, result, afterWindow).humanReviewedDesignation, true);
});

test('the closure window and loss-evidence kill switch still apply to owner verdicts', () => {
  const entry = release();
  const at = (days, thresholds) => classifyStaleClosure({ show, entry,
    now: Date.parse(show.closingDate) + days * 86400000, thresholds });
  assert.equal(at(10).action, 'wait');
  assert.equal(at(182).action, 'flag-needs-loss-evidence');
  assert.equal(at(183).designation, 'Flop');
  assert.equal(at(200, { requireLossEvidence: true }).action, 'flag-needs-loss-evidence');
  assert.equal(at(400).designation, 'Flop');
});

test('recoupment, running shows, carve-outs and review locks still protect deferred verdicts', () => {
  const entry = release();
  const classify = (overrides) => classifyStaleClosure({ show, entry, now: afterWindow, ...overrides });
  assert.equal(classify({ show: { ...show, status: 'open' } }).action, 'no-change');
  assert.equal(classify({ show: { ...show, closingDate: 'invalid' } }).action, 'no-change');
  assert.equal(classify({ entry: { ...entry, recouped: true } }).action, 'no-change');
  assert.equal(classify({ entry: { ...entry, humanReviewedDesignation: true } }).action, 'no-change');
  assert.equal(classify({ entry: { ...entry, productionType: 'tour-stop' } }).action, 'skip-carve-out');
  assert.equal(classify({ pending: { recouped: true, researchedAt: new Date(afterWindow).toISOString() } }).action, 'human-review');
});

test('automated refreshes retain deferred verdicts; cleanup leaves them to the classifier', () => {
  const entry = release();
  const refreshed = buildCommercialEntry({ designation: 'Fizzle', recouped: false }, entry);
  assert.equal(refreshed.ownerDesignationAfterWindow, 'Flop');
  assert.equal(refreshed.ownerDesignationReviewedAt, entry.ownerDesignationReviewedAt);
  assert.equal(refreshed.designation, 'TBD');
  assert.equal(closedTbdLossAction(entry, show, { now: afterWindow }), null);
  assert.equal(classifyStaleClosure({ show, entry: refreshed, now: afterWindow }).designation, 'Flop');
  const recouped = buildCommercialEntry({ recouped: true, recoupedDate: '2026-12' }, entry, { isClaimAutoApply: true });
  assert.equal(recouped.ownerDesignationAfterWindow, undefined);
  assert.equal(recouped.ownerDesignationReviewedAt, undefined);
  assert.equal(classifyStaleClosure({ show, entry: recouped, now: afterWindow }).action, 'no-change');
});

test('invalid deferred labels are ignored and an approved mature loss is locked immediately', () => {
  const entry = { designation: 'TBD', researchAttempts: 1, ownerDesignationAfterWindow: 'Miracle' };
  const result = classifyStaleClosure({ show, entry, now: afterWindow });
  assert.equal(result.designation, 'Fizzle');
  assert.notEqual(result.humanReviewedDesignation, true);
  const mature = sanitizeForPublicRecord(buildCommercialEntry(pending),
    { ...show, closingDate: '2025-01-01' }, { ownerApproved: true, now }).entry;
  assert.equal(mature.designation, 'Flop');
  assert.equal(mature.humanReviewedDesignation, true);
});

test('the held-release CLI passes explicit owner approval to the sanitizer', () => {
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
    assert.match(out, /Would apply "approved"[^\n]*"ownerDesignationAfterWindow":"Flop"/);
    assert.match(out, /Would apply "approved"[^\n]*"ownerDesignationReviewedAt":/);
    assert.doesNotMatch(out, /Would apply "research"[^\n]*ownerDesignation/);
    assert.match(out, /would apply 2, skip 0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
