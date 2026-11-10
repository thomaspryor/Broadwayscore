import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readChecklistErrors, buildDeadlineDraftAlert } = require('../../scripts/lib/deadline-draft-alert.js');

// Shape written by scripts/opening-night-checklist.js --json (shows[].results).
const checklist = {
  generatedAt: '2026-11-10T14:11:00Z',
  shows: [{
    show: { id: 'here-there-are-blueberries-2026', title: 'Here There Are Blueberries' },
    summary: { ok: 17, warnings: 4, errors: 1 },
    results: [
      { name: 'bww-rr-count-mismatch', ok: true, severity: 'warning', message: 'gap' },
      {
        name: 'cv-wrongproduction-unhandled', ok: false, severity: 'error',
        description: 'Source file has contentVerification.wrongProduction=true without top-level clear flag',
        message: 'cititour/Brian Scott Lipton (cititour--brian-scott-lipton.json) SHIPPED with CV.wrongProduction=true',
        details: { violations: [{ outletId: 'cititour', criticName: 'Brian Scott Lipton', filename: 'cititour--brian-scott-lipton.json' }] },
      },
    ],
  }],
};
const showsById = { 'here-there-are-blueberries-2026': { title: 'Here There Are Blueberries' } };
const outletName = (id) => ({ cititour: 'Cititour' }[id] || id);

test('reads errors from shows[].results (the key the checklist writes)', () => {
  const errs = readChecklistErrors(checklist);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].name, 'cv-wrongproduction-unhandled');
});

test('owner email names the show title, outlet and critic in plain words', () => {
  const a = buildDeadlineDraftAlert({
    checklistIds: ['here-there-are-blueberries-2026'], showsById, outletName,
    readChecklist: () => checklist,
    sentTracker: { shows: { 'here-there-are-blueberries-2026': { draftId: 'abc-123' } } },
  });
  assert.match(a.title, /^Here There Are Blueberries email draft is ready in Resend: check one thing/);
  assert.match(a.description, /The Cititour review by Brian Scott Lipton looks like it is about a different production/);
  assert.doesNotMatch(a.description, /none could be read back|CV\.|wrongProduction|here-there-are-blueberries-2026|\.json/);
  assert.equal(a.url, 'https://resend.com/broadcasts/abc-123');
  assert.match(a.description, /Open the draft: https:\/\/resend\.com\/broadcasts\/abc-123/);
});

test('missing checklist output says the reviews were not checked; unknown critic is omitted', () => {
  const a = buildDeadlineDraftAlert({ checklistIds: ['x'], readChecklist: () => null });
  assert.match(a.description, /could not run, so none of the reviews were checked/);
  assert.equal(a.url, 'https://resend.com/broadcasts');
  const b = buildDeadlineDraftAlert({
    checklistIds: ['x'], outletName,
    readChecklist: () => ({ shows: [{ results: [{ name: 'cv-wrongproduction-unhandled', ok: false, severity: 'error', details: { violations: [{ outletId: 'cititour', criticName: 'unknown' }] } }] }] }),
  });
  assert.match(b.description, /The Cititour review looks like/);
});

test('drift and orphan overrides read as plain sentences and count toward the title', () => {
  const a = buildDeadlineDraftAlert({ driftIds: ['s'], orphanEntries: ['s:wait'], showsById: { s: { title: 'Show' } } });
  assert.match(a.title, /check 2 things/);
  assert.match(a.description, /may be missing from the draft/);
  assert.match(a.description, /still waiting for its score/);
});
