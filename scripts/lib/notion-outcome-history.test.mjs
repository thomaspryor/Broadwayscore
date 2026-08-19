import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOutcomeRow, buildOutcomeHistory, redactEmails } from './notion-outcome-history.js';

function record(id, props, fields = {}) {
  return { id, url: `https://notion.so/${id}`, properties: props, fields: { notes: '', outcome: '', keyFiles: '', ...fields } };
}

test('a Done card with a written Outcome is extracted', () => {
  const r = record(
    'p-done',
    { Name: 'Fix duplicate outlet merge bug', Status: 'Done', Priority: 'P1 Next', 'Completed Date': '2026-07-19' },
    { outcome: '## Closed — fixed the merge cascade', keyFiles: 'scripts/rebuild-all-reviews.js' }
  );
  const row = extractOutcomeRow(r);
  assert.ok(row);
  assert.equal(row.pageId, 'p-done');
  assert.equal(row.title, 'Fix duplicate outlet merge bug');
  assert.equal(row.outcome, '## Closed — fixed the merge cascade');
  assert.equal(row.keyFiles, 'scripts/rebuild-all-reviews.js');
  assert.equal(row.completedDate, '2026-07-19');
  assert.equal(row.disposition, 'skip');
});

test('a live P0/P1 card is NEVER extracted, even with outcome text — it stays on the live board, not archived', () => {
  const r = record(
    'p-live',
    { Name: 'Fix scoring drift on temporal overrides', Status: 'In progress', Priority: 'P0 Now' },
    { outcome: 'partial progress notes' }
  );
  assert.equal(extractOutcomeRow(r), null);
});

test('a Done card with an empty Outcome is not extracted — nothing to preserve', () => {
  const r = record('p-done-empty', { Name: 'Some stub card', Status: 'Done', Priority: 'P2 Later' }, { outcome: '   ' });
  assert.equal(extractOutcomeRow(r), null);
});

test('an archived (low-priority) card with an Outcome is extracted — it is leaving the live board too', () => {
  const r = record(
    'p-archive',
    { Name: 'Rename legacy audience-buzz field', Status: 'Not started', Priority: 'P2 Later' },
    { outcome: 'Renamed in a follow-up sweep, closing as superseded.' }
  );
  const row = extractOutcomeRow(r);
  assert.ok(row);
  assert.equal(row.disposition, 'archive');
});

test('a self-referential fleet-noise card with an Outcome is extracted — noise is excluded from Linear, not from the knowledge archive', () => {
  const r = record(
    'p-noise',
    { Name: 'BSC Daily: 3 shows missing reviews', Status: 'Done', Priority: 'P1 Next' },
    { outcome: 'Resolved via manual ingest.' }
  );
  const row = extractOutcomeRow(r);
  assert.ok(row);
});

test('a card with no title still exports if it carries an Outcome — title is metadata, outcome is the knowledge', () => {
  const r = record('p-blank-title', { Name: '   ', Status: 'Done', Priority: 'P1 Next' }, { outcome: 'Closed as duplicate.' });
  const row = extractOutcomeRow(r);
  assert.ok(row);
  assert.equal(row.title, null);
});

test('buildOutcomeHistory: sorted by pageId, deterministic, excludes live and empty-outcome rows', () => {
  const records = [
    record('z-archive', { Name: 'Z card', Status: 'Not started', Priority: 'P2 Later' }, { outcome: 'z outcome' }),
    record('a-live', { Name: 'A card', Status: 'Not started', Priority: 'P0 Now' }, { outcome: 'should not appear' }),
    record('m-done', { Name: 'M card', Status: 'Done', Priority: 'P1 Next' }, { outcome: 'm outcome' }),
    record('b-empty', { Name: 'B card', Status: 'Done', Priority: 'P1 Next' }, { outcome: '' }),
  ];
  const rows = buildOutcomeHistory(records);
  assert.deepEqual(rows.map((r) => r.pageId), ['m-done', 'z-archive']);
});

test('buildOutcomeHistory is a pure re-run: identical input yields identical (byte-comparable) output', () => {
  const records = [
    record('p1', { Name: 'One', Status: 'Done', Priority: 'P1 Next' }, { outcome: 'one' }),
    record('p2', { Name: 'Two', Status: 'Done', Priority: 'P2 Later' }, { outcome: 'two' }),
  ];
  assert.deepEqual(buildOutcomeHistory(records), buildOutcomeHistory(records));
});

test('a record with Outcome ONLY in properties (no fields at all) still extracts — matches the real importer\'s own fallback', () => {
  // Not `{ id, url, properties, fields: {...} }` — a record shape that never
  // went through notion-corpus.js's buildRecord(), e.g. a hand-built fixture
  // or a lighter-weight future export. linear-import-corpus.js's own
  // buildDescription() falls back to properties the same way (`f.outcome ||
  // p.Outcome`); this export must not be less complete than the importer it
  // exists to double-check.
  const r = { id: 'p-props-only', url: 'https://notion.so/p-props-only', properties: { Name: 'Legacy card', Status: 'Done', Priority: 'P1 Next', Outcome: 'closed via properties fallback', 'Key Files': 'a.js' } };
  const row = extractOutcomeRow(r);
  assert.ok(row);
  assert.equal(row.outcome, 'closed via properties fallback');
  assert.equal(row.keyFiles, 'a.js');
});

test('a record with no id throws rather than silently writing a keyless row', () => {
  const r = { url: 'https://notion.so/x', properties: { Name: 'No id', Status: 'Done', Priority: 'P1 Next' }, fields: { outcome: 'orphaned', notes: '', keyFiles: '' } };
  assert.throws(() => extractOutcomeRow(r), /no id/);
});

test('buildOutcomeHistory throws on a duplicate pageId rather than silently keeping both rows', () => {
  const records = [
    record('dup-1', { Name: 'First', Status: 'Done', Priority: 'P1 Next' }, { outcome: 'first version' }),
    record('dup-1', { Name: 'First (again)', Status: 'Done', Priority: 'P1 Next' }, { outcome: 'second version' }),
  ];
  assert.throws(() => buildOutcomeHistory(records), /duplicate pageId/);
});

// Regression fixture: the real leaked row (pageId 363637c5-416f-818b, "Beat
// the Critics launch") that shipped a real contest entrant's personal email
// addresses into a public repo before this redaction existed (adversarial
// review, BRO-376). Never loosen this without re-reading that incident.
test('redactEmails strips every email-shaped string, third-party PII included', () => {
  const text = "Olivia's first attempt (olivia.papa@ekohealth.com) was a genuine storeSubmission failure. Her retry (papa.olivia@gmail.com) stored successfully. Alert sent to thomas.pryor@gmail.com.";
  const redacted = redactEmails(text);
  assert.ok(!redacted.includes('olivia.papa@ekohealth.com'));
  assert.ok(!redacted.includes('papa.olivia@gmail.com'));
  // Blanket rule — the OWNER's own email is redacted too, no per-address
  // judgment call at export time.
  assert.ok(!redacted.includes('thomas.pryor@gmail.com'));
  assert.ok(redacted.includes('[email-redacted]'));
  assert.ok(redacted.includes("Olivia's first attempt"), 'surrounding prose survives — only the address is stripped');
});

test('extractOutcomeRow redacts emails in outcome, title, AND keyFiles', () => {
  const r = record(
    'p-pii',
    { Name: 'Contact jane@example.com about the bug', Status: 'Done', Priority: 'P1 Next' },
    { outcome: 'Fixed after emailing jane@example.com for repro steps.', keyFiles: 'see thread with jane@example.com' }
  );
  const row = extractOutcomeRow(r);
  assert.ok(!row.title.includes('jane@example.com'));
  assert.ok(!row.outcome.includes('jane@example.com'));
  assert.ok(!row.keyFiles.includes('jane@example.com'));
});
