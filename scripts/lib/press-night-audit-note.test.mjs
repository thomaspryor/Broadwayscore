import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const note = require('./press-night-audit-note.js');
const lib = require('./press-night-record.js');

const EMB = '2026-10-23T02:00:00.000Z';
const at = (min) => new Date(Date.parse(EMB) + min * 60000).toISOString();

function dirWith(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-audit-'));
  for (const r of records) fs.writeFileSync(path.join(dir, `${r.showId}-${r.night}.json`), JSON.stringify(r));
  return dir;
}

function passingRecord(showId) {
  const rec = lib.emptyRecord({ showId, night: '2026-10-22', market: 'broadway', embargoAt: EMB });
  lib.applySample(rec, { at: at(-5), reviews: [] });
  lib.applySample(rec, { at: at(10), reviews: [{ outlet: 'NYT', critic: 'A', tier: 1, date: '2026-10-22' }] });
  rec.reference['2h'] = { status: 'complete', coverage: 1, covered: 1, count: 1, missing: [], fetchedAt: at(120) };
  rec.fileState = { capturedAt: at(500), files: [{ outletId: 'nytimes', includable: true, firstSeenAt: at(5) }] }; // BRO-6070 gate
  return rec;
}

test('a FAIL/UNKNOWN night rewrites "no fixes needed" and puts the verdict on top', () => {
  const failing = lib.emptyRecord({ showId: 'slow-show', night: '2026-10-22', market: 'broadway', embargoAt: EMB });
  lib.applySample(failing, { at: at(-5), reviews: [] });
  lib.applySample(failing, { at: at(87), reviews: [{ outlet: 'Deadline', critic: 'G', tier: 1, date: '2026-10-22T02:00:00Z' }] });
  const dir = dirWith([failing, passingRecord('fine-show')]);
  const r = note.annotateAuditText('Opening-night audit 2026-10-23', 'Routine log; no fixes needed.', { dir });
  assert.equal(r.changed, true);
  assert.ok(r.text.startsWith(note.MARKER));
  assert.match(r.text, /slow-show 2026-10-22: FAIL/);
  assert.doesNotMatch(r.text, /no fixes needed\./i);
  assert.doesNotMatch(r.text, /fine-show/);
});

test('a show of a probed market opening that night with no record is UNKNOWN', () => {
  const dir = dirWith([]);
  const shows = [{ id: 'unprobed', category: 'broadway', openingDate: '2026-10-22' }, { id: 'ob', category: 'off-broadway', openingDate: '2026-10-22' }];
  const r = note.annotateAuditText('Opening-night audit 2026-10-23', 'no fixes needed', { dir, shows });
  assert.equal(r.notPassing.length, 1);
  assert.match(r.text, /unprobed 2026-10-22: UNKNOWN/);
});

test('all PASS, other titles and already-annotated text are left alone', () => {
  const dir = dirWith([passingRecord('fine-show')]);
  assert.equal(note.annotateAuditText('Opening-night audit 2026-10-23', 'no fixes needed', { dir }).changed, false);
  assert.equal(note.annotateAuditText('Some other card', 'no fixes needed', { dir: dirWith([]), shows: [{ id: 'x', category: 'broadway', openingDate: '2026-10-22' }] }).changed, false);
  const once = note.annotateAuditText('Opening-night audit 2026-10-23', 'x', { dir: dirWith([]), shows: [{ id: 'x', category: 'broadway', openingDate: '2026-10-22' }] });
  assert.equal(note.annotateAuditText('Opening-night audit 2026-10-23', once.text, { dir: dirWith([]), shows: [{ id: 'x', category: 'broadway', openingDate: '2026-10-22' }] }).changed, false);
});

test('the real 2026-10-23 audit text is flagged for the committed Imaginary Invalid record', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const r = note.annotateAuditCard('Opening-night audit 2026-10-23', 'Morning-after audit 2026-10-23 (openings 2026-10-22). Routine log; no fixes needed.', root);
  assert.equal(r.changed, true);
  assert.match(r.text, /the-imaginary-invalid-2026 2026-10-22: FAIL/);
  assert.doesNotMatch(r.text, /no fixes needed/i);
});

test('follow-up comments get the banner only when they call the night clean', () => {
  const shows = [{ id: 'x', category: 'broadway', openingDate: '2026-10-22' }];
  const opts = { dir: dirWith([]), shows, onlyIfCleanClaim: true };
  assert.equal(note.annotateAuditText('Opening-night audit 2026-10-23', 'closing, done', opts).changed, false);
  assert.equal(note.annotateAuditText('Opening-night audit 2026-10-23', 'No fixes required.', opts).changed, true);
});

test('BRO-6614: a night whose release came late carries the observed-release verdict into the audit note', () => {
  const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'audit', 'press-night', 'a-few-good-men-2026-2026-10-29.json');
  const rec = JSON.parse(fs.readFileSync(src, 'utf8'));
  const r = note.annotateAuditText('Opening-night audit 2026-10-30', 'Routine log; no fixes needed.', { dir: dirWith([rec]) });
  assert.match(r.text, /a-few-good-men-2026 2026-10-29: FAIL/);
  assert.match(r.text, /first review at 2026-10-30T03:02:18\.463Z, 62 min after the assumed embargo 2026-10-30T02:00:00\.000Z; the verdict uses the assumed one\. Measured from the observed release: FAIL\./);
});
