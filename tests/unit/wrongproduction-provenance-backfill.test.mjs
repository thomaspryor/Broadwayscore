// BRO-5582: the legacy wrongProduction audit backfill selects only trail-less flags, stamps a
// behavior-neutral field, and never invents a wrongProductionProvenance value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AUDIT_FIELD, isLegacyUnprovenanced, legacyAuditStamp } = require('../../scripts/lib/wrongproduction-legacy-audit');
const { WRONG_PRODUCTION_PROVENANCE_FIELDS, isUrlProvenanceWrongProduction } = require('../../scripts/lib/wrongproduction-provenance');
const { PROVENANCE_FIELDS } = require('../../scripts/lib/orphaned-wrongprod-provenance');
const { backfill, problemWith } = require('../../scripts/backfill-wrongproduction-legacy-audit');

const AT = '2026-10-29T00:00:00.000Z';

test('selects a bare wrongProduction=true flag', () => {
  assert.equal(isLegacyUnprovenanced({ wrongProduction: true, outlet: 'x' }), true);
});

test('skips flags that already have any wrongProduction trail', () => {
  for (const extra of [
    { wrongProductionNote: 'n' }, { wrongProductionReason: 'r' }, { wrongProductionProvenance: 'url' },
    { wrongProductionDetectedBy: 'd' }, { wrongProductionDetail: 'x' }, { _wrongProductionDetectedBy: 'd' },
  ]) assert.equal(isLegacyUnprovenanced({ wrongProduction: true, ...extra }), false, JSON.stringify(extra));
});

test('skips cleared, absent and already-stamped flags', () => {
  assert.equal(isLegacyUnprovenanced({ wrongProduction: false }), false);
  assert.equal(isLegacyUnprovenanced({}), false);
  assert.equal(isLegacyUnprovenanced({ wrongProduction: true, [AUDIT_FIELD]: { basis: 'unrecorded' } }), false);
});

test('stamp records a recorded rejection and otherwise says unrecorded', () => {
  assert.deepEqual(legacyAuditStamp({ wrongProduction: true }, { at: AT }),
    { basis: 'unrecorded', backfilledAt: AT, backfilledBy: 'BRO-5582' });
  const s = legacyAuditStamp({ wrongProduction: true, rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'wrong show' }, { at: AT });
  assert.equal(s.basis, 'recorded-rejection');
  assert.equal(s.rejectedBy, 'ensemble-scoreability-check');
  assert.equal(legacyAuditStamp({ wrongProduction: false }, { at: AT }), null);
});

test('the stamp never touches behavior-bearing provenance', () => {
  const rec = { wrongProduction: true };
  const stamped = { ...rec, [AUDIT_FIELD]: legacyAuditStamp(rec, { at: AT }) };
  assert.equal(stamped.wrongProductionProvenance, undefined);
  assert.equal(stamped.wrongProductionDetectedBy, undefined);
  assert.equal(isUrlProvenanceWrongProduction(stamped), isUrlProvenanceWrongProduction(rec));
});

test('the audit field dies with the flag and counts as an orphan trail', () => {
  assert.ok(WRONG_PRODUCTION_PROVENANCE_FIELDS.includes(AUDIT_FIELD));
  assert.ok(PROVENANCE_FIELDS.includes(AUDIT_FIELD));
});

test('problemWith enforces --expect and refusals', () => {
  assert.match(problemWith({ scanned: 0, written: 0, refused: [] }, { apply: false }), /no review files/);
  assert.equal(problemWith({ scanned: 5, eligible: 2, written: 0, refused: [] }, { apply: false }), null);
  assert.match(problemWith({ scanned: 5, eligible: 2, written: 1, refused: [] }, { apply: true, expect: 2 }), /expected 2/);
  assert.match(problemWith({ scanned: 5, eligible: 2, written: 2, refused: ["a/b.json"] }, { apply: true, expect: 2 }), /changed beyond/);
  assert.equal(problemWith({ scanned: 5, eligible: 2, written: 2, refused: [] }, { apply: true, expect: 2 }), null);
});

test('dry run over a temp tree counts eligible files and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5582-'));
  try {
    fs.mkdirSync(path.join(dir, 'show-a'));
    const f = path.join(dir, 'show-a', 'x.json');
    const body = JSON.stringify({ showId: 'show-a', wrongProduction: true });
    fs.writeFileSync(f, body);
    fs.writeFileSync(path.join(dir, 'show-a', 'y.json'), JSON.stringify({ showId: 'show-a', wrongProduction: true, wrongProductionNote: 'n' }));
    const r = backfill({ apply: false, reviewDir: dir, at: AT });
    assert.deepEqual([r.scanned, r.eligible, r.written, r.dryRun], [2, 1, 0, true]);
    assert.equal(fs.readFileSync(f, 'utf8'), body);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5582-'));
  fs.mkdirSync(path.join(dir, 'show-a'));
  for (const [name, rec] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'show-a', name), JSON.stringify(rec));
  return dir;
}

test('apply adds only the audit key and leaves every other field alone', () => {
  // A url-collision twin: safeWriteReview would mark one of these duplicateOf; the raw write must not.
  const a = { showId: 'show-a', wrongProduction: true, url: 'https://x.test/a ', criticName: 'Ann', outlet: 'nyt' };
  const b = { showId: 'show-a', wrongProduction: true, url: 'https://x.test/a ', criticName: 'Ann', outlet: 'nyt2' };
  const dir = tree({ 'a.json': a, 'b.json': b });
  try {
    const r = backfill({ apply: true, reviewDir: dir, at: AT, expect: 2 });
    assert.deepEqual([r.eligible, r.written, r.refused.length], [2, 2, 0]);
    for (const [name, before] of [['a.json', a], ['b.json', b]]) {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'show-a', name), 'utf8'));
      const { [AUDIT_FIELD]: stamp, ...rest } = saved;
      assert.deepEqual(rest, before);
      assert.equal(stamp.backfilledBy, 'BRO-5582');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a wrong --expect refuses before writing anything', () => {
  const dir = tree({ 'a.json': { showId: 'show-a', wrongProduction: true } });
  try {
    const r = backfill({ apply: true, reviewDir: dir, at: AT, expect: 5 });
    assert.equal(r.written, 0);
    assert.match(problemWith(r, { apply: true, expect: 5 }), /nothing written/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'show-a', 'a.json'), 'utf8'))[AUDIT_FIELD], undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
