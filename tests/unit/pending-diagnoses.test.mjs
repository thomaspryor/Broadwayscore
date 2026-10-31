// Tests for scripts/lib/pending-diagnoses.js — the persistence layer that keeps
// bug diagnoses recoverable when process-feedback.yml is cancelled between the
// tracking commit and issue creation (2026-07-07 incident, run 28876301784).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadPendingDiagnoses, mergePendingDiagnoses } = require('../../scripts/lib/pending-diagnoses.js');

// Same identifier logic as process-feedback.js submissionId()
const submissionId = (sub) => sub._id || sub.id || sub.createdAt || sub._date;

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pending-diag-')), 'pending.json');

test('loadPendingDiagnoses: missing file returns []', () => {
  assert.deepEqual(loadPendingDiagnoses(tmpFile()), []);
});

test('loadPendingDiagnoses: corrupt JSON returns []', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{not json');
  assert.deepEqual(loadPendingDiagnoses(f), []);
});

test('loadPendingDiagnoses: non-array JSON returns []', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{"a":1}');
  assert.deepEqual(loadPendingDiagnoses(f), []);
});

test('loadPendingDiagnoses: round-trips a valid pending list', () => {
  const f = tmpFile();
  const entries = [{ item: { summary: 'bug' }, submission: { _date: 'A' }, diagnosis: { confidence: 'high' } }];
  fs.writeFileSync(f, JSON.stringify(entries));
  assert.deepEqual(loadPendingDiagnoses(f), entries);
});

test('mergePendingDiagnoses: keeps leftovers, appends fresh', () => {
  const pending = [{ submission: { _date: 'A' }, diagnosis: { v: 'old' } }];
  const fresh = [{ submission: { _date: 'B' }, diagnosis: { v: 'new' } }];
  const merged = mergePendingDiagnoses(pending, fresh, submissionId);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(d => submissionId(d.submission)), ['A', 'B']);
});

test('mergePendingDiagnoses: fresh re-diagnosis of same submission wins over leftover', () => {
  const pending = [{ submission: { _date: 'A' }, diagnosis: { v: 'stale' } }];
  const fresh = [{ submission: { _date: 'A' }, diagnosis: { v: 'fresh' } }];
  const merged = mergePendingDiagnoses(pending, fresh, submissionId);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].diagnosis.v, 'fresh');
});

test('mergePendingDiagnoses: entries without submission survive (never crash on malformed leftover)', () => {
  const pending = [{ diagnosis: { v: 'orphan' } }];
  const fresh = [{ submission: { _date: 'B' }, diagnosis: { v: 'new' } }];
  const merged = mergePendingDiagnoses(pending, fresh, submissionId);
  assert.equal(merged.length, 2);
});
