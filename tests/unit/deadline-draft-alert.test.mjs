import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readChecklistErrors, buildDeadlineDraftAlert, plainFindings } = require('../../scripts/lib/deadline-draft-alert.js');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { buildAlertEmail } = require('../../scripts/lib/discord-notify.js');

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
  // The whole rendered email, not just the description: no slug, no [CRITICAL] tag.
  const email = buildAlertEmail({ title: a.title, description: a.description, severity: 'error', url: a.url, subjectLabel: '' });
  const rendered = JSON.stringify(email);
  assert.doesNotMatch(rendered, /here-there-are-blueberries-2026|CRITICAL/);
});

test('title comes from the checklist JSON when shows.json is not passed; stored draftUrl wins; links de-duplicated', () => {
  const a = buildDeadlineDraftAlert({
    checklistIds: ['here-there-are-blueberries-2026', 'other'], outletName,
    readChecklist: (id) => (id === 'other' ? { shows: [{ show: { id: 'other', title: 'Other Show' }, results: [{ name: 'x', severity: 'error', ok: true, description: 'Something is off', message: 'detail.' }] }] } : checklist),
    sentTracker: { shows: { 'here-there-are-blueberries-2026': { draftUrl: 'https://resend.com/broadcasts/shared' }, other: { draftUrl: 'https://resend.com/broadcasts/shared' } } },
  });
  assert.match(a.title, /^Here There Are Blueberries and Other Show email draft/);
  assert.equal((a.description.match(/resend\.com\/broadcasts\/shared/g) || []).length, 1);
  // severity 'error' counts even if ok is true (matches the summary's error count)
  assert.match(a.description, /did not say which one/);
  assert.doesNotMatch(a.description, /Something is off/);
});

test('long violation lists are capped', () => {
  const violations = Array.from({ length: 8 }, (_, i) => ({ outletId: 'o' + i, criticName: 'C' + i }));
  const a = buildDeadlineDraftAlert({ checklistIds: ['s'], readChecklist: () => ({ shows: [{ results: [{ name: 'cv-wrongproduction-unhandled', severity: 'error', ok: false, details: { violations } }] }] }) });
  assert.match(a.description, /3 more reviews have the same problem/);
});

test('missing checklist output says the reviews were not checked; unknown critic is omitted', () => {
  const a = buildDeadlineDraftAlert({ checklistIds: ['x'], readChecklist: () => null });
  assert.match(a.description, /could not run, so none of the reviews were checked/);
  assert.equal(a.url, 'https://resend.com/broadcasts');
  assert.match(a.description, /Open your drafts in Resend \(it is the newest one\)/);
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

// Class guard: every checklist check that can raise an error (and so hold or
// annotate the owner's draft) must have plain owner wording in CHECK_LINES.
// A new error check without it would leak engineer text into the email.
test('every error-severity opening-night check has plain owner wording', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'lib', 'opening-night-checks');
  const { CHECK_LINES: lines } = require('../../scripts/lib/deadline-draft-alert.js');
  const missing = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.check.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/severity:\s*'error'/.test(src)) continue;
    const name = require(path.join(dir, f)).name;
    if (!lines[name]) missing.push(name);
  }
  assert.deepEqual(missing, []);
});

test('no finding line echoes engineer text (slug, file name, check threw)', () => {
  const engineer = /\.json|check threw|--|https?:|[a-z]+-[a-z]+-\d{4}/;
  const cases = [
    { name: 'slug-mismatch', ok: false, severity: 'error', message: 'Review URL for nyt/Jesse Green does not mention show slug (checked: foo-2026): https://x', details: { mismatches: [{ outletId: 'nyt', criticName: 'Jesse Green', url: 'https://x/foo' }] } },
    { name: 'fulltext-mentions-show', ok: false, severity: 'error', message: 'nyt/Jesse (nyt--jesse.json) SHIPPED', details: { violations: [{ filename: 'nyt--jesse.json', outletId: 'nyt', criticName: 'Jesse' }] } },
    { name: 'publish-date-pre-opening', ok: false, severity: 'error', message: 'x', details: { violations: [{ outletId: 'nyt', criticName: 'J', publishDate: '2025-01-02' }] } },
    { name: 'assigned-score-schema', ok: false, severity: 'error', message: 'x', details: { violations: [{ outletId: 'nyt', criticName: 'J' }] } },
    { name: 'wrong-production-bww', ok: false, severity: 'error', message: 'x', details: { problems: [{ url: 'https://bww/x' }] } },
    { name: 'cv-wrongproduction-unhandled', ok: false, severity: 'error', message: "check threw: ENOENT '/home/runner/data/x.json'", details: {} },
    { name: 'some-future-check', ok: false, severity: 'error', message: 'foo-bar-2026 (x.json)', description: 'Catches EBT class (task #1)' },
  ];
  for (const r of cases) {
    for (const line of plainFindings(r, { outletName: (id) => (id === 'nyt' ? 'New York Times' : id) })) {
      assert.doesNotMatch(line, engineer, `${r.name}: ${line}`);
    }
  }
});

test('outlet names that start with "The" are not doubled; dates read like dates', () => {
  const [line] = plainFindings({ name: 'publish-date-pre-opening', severity: 'error', ok: false, details: { violations: [{ outletId: 'nyt', criticName: 'J', publishDate: '2024-05-14' }] } }, { outletName: () => 'The New York Times' });
  assert.match(line, /^The New York Times review by J is dated May 14, 2024,/);
});
