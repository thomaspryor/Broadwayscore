// BRO-4453: reader name/email/message live in the private store, not in the
// public GitHub issues. These tests pin both halves: what a new issue may
// contain, and that every consumer still gets the reader back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const store = require('../../scripts/lib/feedback-submitter-store.js');
const body = require('../../scripts/lib/feedback-issue-body.js');
const { readerFromDiagnosis } = require('../../scripts/lib/owner-fix-email.js');
const { firstRealEmail } = require('../../scripts/lib/pii-scan.js');

const READER = {
  _date: '2026-10-01T01:00:00.000Z',
  name: 'Jane Quigley',
  email: 'jane.quigley@gmail.com',
  show: 'Hamilton',
  category: 'Bug',
  message: 'The Hamilton page lists the wrong closing date, it says 2025.',
  phone: '555-0100',
};

const DIAGNOSIS = {
  summary: 'Wrong closing date on Hamilton',
  whatsHappening: 'Jane Quigley (jane.quigley@gmail.com) reports the closing date is wrong.',
  findings: ['shows.json has closingDate 2025-01-01', 'Reader quote: The Hamilton page lists the wrong closing date, it says 2025.'],
  proposedFix: 'Clear closingDate',
  confidence: 'high',
  fixType: 'data',
  relevantFiles: ['data/shows.json'],
};

function storeWithReader() {
  const s = store.emptyStore();
  store.recordSubmitter(s, READER);
  return s;
}

function newIssueBody(s = storeWithReader()) {
  const submission = store.redactSubmission(READER);
  const showIds = ['hamilton-2015'];
  const payload = body.buildPublicDiagnosisPayload({ diagnosis: DIAGNOSIS, submission, resolvedShow: { id: 'hamilton-2015', slug: 'hamilton' }, showIds });
  const reader = store.lookupSubmitter(s, store.submissionKey(submission));
  return body.buildBugDiagnosisBody({ item: { summary: DIAGNOSIS.summary, priority: 'High' }, submission, diagnosis: DIAGNOSIS, payload, showIds, reader });
}

function assertNoReaderPII(text) {
  assert.equal(firstRealEmail(text), null, `email leaked: ${text}`);
  assert.ok(!/Jane Quigley/i.test(text), 'reader name leaked');
  assert.ok(!text.includes(READER.message), 'reader message leaked');
  assert.ok(!text.includes('555-0100'), 'extra form field leaked');
}

test('new bug-diagnosis issue body has no reader email, name or message (even when the LLM quotes them)', () => {
  const text = newIssueBody();
  assertNoReaderPII(text);
  const diag = store.parseDiagnosisJson(text);
  assert.equal(diag.submissionId, READER._date);
  for (const f of store.PII_DIAGNOSIS_FIELDS) assert.equal(diag[f], undefined, f);
  assert.equal(diag.submitterShow, 'Hamilton');
  assert.equal(diag.showId, 'hamilton-2015');
});

test('needs-review body, title and duplicate comment carry no reader PII', () => {
  const s = storeWithReader();
  const submission = store.redactSubmission(READER);
  const reader = store.lookupSubmitter(s, store.submissionKey(submission));
  const item = { summary: 'Jane Quigley says email jane.quigley@gmail.com back', priority: 'High' };
  for (const isContentRequest of [true, false]) {
    assertNoReaderPII(body.buildNeedsReviewBody({ item, submission, contentActions: [{ kind: 'missing-show', workflow: 'x.yml', inputs: {} }], dispatchableCount: 1, isContentRequest, reader }));
  }
  assertNoReaderPII(body.buildIssueTitle('Bug Diagnosis: ', item.summary, reader));
  assertNoReaderPII(body.buildDuplicateComment({ submission, reason: 'same show' }));
});

test('consumers get the reader back from the store (owner fix email, thank-you, approval email)', () => {
  const diag = store.loadIssueDiagnosis(newIssueBody(), { store: storeWithReader() });
  assert.equal(diag.submitterEmail, READER.email);
  assert.equal(diag.submitterName, READER.name);
  assert.equal(diag.originalMessage, READER.message);
  assert.deepEqual(readerFromDiagnosis(diag), { name: READER.name, email: READER.email, show: 'Hamilton', message: READER.message });
});

test('legacy issues with inline details still work; unknown ids degrade to no reader', () => {
  const legacy = `x\n<!-- DIAGNOSIS_JSON\n${JSON.stringify({ summary: 's', submitterName: 'Old Reader', submitterEmail: 'old@example.org', submitterShow: 'Wicked', originalMessage: 'm' })}\nDIAGNOSIS_JSON -->`;
  const diag = store.loadIssueDiagnosis(legacy, { store: store.emptyStore() });
  assert.equal(diag.submitterEmail, 'old@example.org');
  assert.equal(diag.submitterName, 'Old Reader');

  const orphan = store.loadIssueDiagnosis(newIssueBody(), { store: store.emptyStore() });
  assert.equal(readerFromDiagnosis(orphan).email, null);
  assert.equal(store.loadIssueDiagnosis('no block here', { store: store.emptyStore() }), null);
});

test('redactSubmission is an allowlist and keeps what the pipeline routes on', () => {
  const r = store.redactSubmission({ ...READER, _mergedSubmissionIds: ['a', 'b'], _isSpam: false });
  assert.deepEqual(Object.keys(r).sort(), ['_date', '_isSpam', '_mergedSubmissionIds', 'category', 'show']);
  assert.equal(store.submissionKey(r), store.submissionKey(READER));
});

test('store round-trips on disk and prunes entries past retention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsub-'));
  const p = path.join(dir, 'feedback-submitters.json');
  const s = storeWithReader();
  const now = Date.parse('2026-10-01T00:00:00Z');
  s.entries.old = { name: 'x', email: 'x@example.org', storedAt: new Date(now - (store.RETENTION_DAYS + 1) * 86400000).toISOString() };
  store.saveStore(s, p, now);
  const back = store.loadStore(p);
  assert.ok(back.entries[READER._date]);
  assert.equal(back.entries.old, undefined);
  assert.deepEqual(store.loadStore(path.join(dir, 'missing.json')), store.emptyStore());
});

test('recordSubmitter keeps the first storedAt and skips submissions with nothing personal', () => {
  const s = store.emptyStore();
  store.recordSubmitter(s, READER, Date.parse('2026-01-01T00:00:00Z'));
  store.recordSubmitter(s, READER, Date.parse('2026-06-01T00:00:00Z'));
  assert.equal(s.entries[READER._date].storedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(store.recordSubmitter(s, { _date: 'z', show: 'Wicked' }), null);
  assert.equal(store.recordSubmitter(s, { name: 'No Id' }), null);
});

test('scrubPublicText leaves ordinary text alone and ignores Anonymous/short names', () => {
  assert.equal(store.scrubPublicText('Hamilton closing date', { name: 'Anonymous' }), 'Hamilton closing date');
  assert.equal(store.scrubPublicText('Al is at the theatre', { name: 'Al' }), 'Al is at the theatre');
  assert.equal(store.scrubPublicText('Jane said hi', { name: 'jane' }), '[reader] said hi');
  assert.equal(store.scrubPublicText('Janet said hi', { name: 'Jane' }), 'Janet said hi');
});

test('pending-diagnoses write: public file redacted, reader in the private store, leftovers keep their reader', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpend-'));
  const pendingPath = path.join(dir, 'pending-bug-diagnoses.json');
  const storePath = path.join(dir, 'feedback-submitters.json');
  const entries = [{ item: { summary: 's' }, submission: READER, diagnosis: DIAGNOSIS }];

  const first = store.writePendingWithPrivateReaders(entries, { pendingPath, storePath });
  assert.equal(first.storeChanged, true);
  const publicText = fs.readFileSync(pendingPath, 'utf8');
  assertNoReaderPII(publicText);
  assert.equal(store.lookupSubmitter(store.loadStore(storePath), READER._date).email, READER.email);

  // Next run: the leftover comes back redacted. The store must keep the reader.
  const second = store.writePendingWithPrivateReaders(JSON.parse(publicText), { pendingPath, storePath });
  assert.equal(second.storeChanged, false);
  assert.equal(store.lookupSubmitter(store.loadStore(storePath), READER._date).name, READER.name);

  const empty = store.writePendingWithPrivateReaders([], { pendingPath, storePath });
  assert.equal(empty.storeChanged, false);
  assert.equal(fs.readFileSync(pendingPath, 'utf8'), '[]\n');
});

// Source guard: the public issue step must never interpolate the raw
// submission's personal fields again (the original leak was inline YAML).
test('process-feedback.yml issue step never reads submission.name/email/message', () => {
  const yml = fs.readFileSync(new URL('../../.github/workflows/process-feedback.yml', import.meta.url), 'utf8');
  const start = yml.indexOf('- name: Create Bug Diagnosis Issues');
  const end = yml.indexOf('- name: Create Needs-Review Issue (spam-flagged only)');
  assert.ok(start > 0 && end > start);
  const step = yml.slice(start, end);
  assert.doesNotMatch(step, /submission\.(name|email|message)\b/);
  assert.doesNotMatch(step, /submitter(Name|Email)\s*:/);
  assert.doesNotMatch(step, /originalMessage\s*:/);
});
