// BRO-4081: triage cards whose newest dispatch-ledger row is
// job-stopped-short/job-stranded. Requires the real decision module (rule 15).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { newestStrandedByRef, nonProofReason, triageCard, currentVerifyCmd, hasTriageComment } = require('../../scripts/lib/ack-landed-stranded-triage.js');

const stranded = { event: 'job-stopped-short', taskId: 'linear:BRO-3471', ts: '2026-09-23T10:00:00Z', jobId: 'j1' };
const work = { sha: '942b13f84d1aaaa', subject: 'fix(scores): BRO-3471 cap star bands', body: '', files: ['scripts/lib/x.js'] };
const merge = { sha: 'abcabcabcabc', subject: "Merge branch 'job/linear-BRO-3471-fix' into main", body: '', files: ['scripts/lib/x.js'] };
const bypass = { sha: 'deaddeaddead', subject: 'data: linear-gate-bypass ledger entry (BRO-3471)', body: '', files: ['data/audit/linear-gate-bypass.jsonl'] };

describe('newestStrandedByRef', () => {
  test('keeps refs whose NEWEST row is stopped-short or stranded', () => {
    const out = newestStrandedByRef([
      { event: 'job-spawned', taskId: 'linear:BRO-1' },
      { event: 'job-stranded', taskId: 'linear:BRO-1' },
      { event: 'job-stopped-short', taskId: 'linear:BRO-2' },
      { event: 'job-stopped-short', taskId: 'linear:BRO-3' },
      { event: 'landed-acked', taskId: 'linear:BRO-3' },
      { event: 'job-stranded', taskId: 'linear:BRO-4' },
      { event: 'job-spawned', taskId: 'linear:BRO-4' },
      { event: 'job-stranded', taskId: 'notion:abc' },
    ]);
    assert.deepEqual(out.map(c => c.ref), ['BRO-1', 'BRO-2']);
  });
});

describe('nonProofReason', () => {
  test('a real work commit naming the card is proof', () => {
    assert.equal(nonProofReason(work, 'BRO-3471'), null);
  });
  test('merge, gate-bypass, bookkeeping-only and near-miss commits are not', () => {
    assert.equal(nonProofReason(merge, 'BRO-3471'), 'merge commit');
    assert.equal(nonProofReason(bypass, 'BRO-3471'), 'gate-bypass ledger entry');
    assert.equal(nonProofReason({ ...work, subject: 'notes BRO-3471', files: ['memory/a.md', 'data/audit/x.jsonl'] }, 'BRO-3471'), 'bookkeeping paths only');
    assert.equal(nonProofReason({ ...work, subject: 'fix BRO-34712 thing' }, 'BRO-3471'), 'does not name the card (substring match only)');
  });
});

describe('triageCard', () => {
  test('work commit + safe VERIFY -> ack args without --sha', () => {
    const d = triageCard({ ref: 'BRO-3471', row: stranded, commits: [merge, work], verifyCmd: 'node --test a.test.mjs' });
    assert.equal(d.action, 'ack');
    assert.deepEqual(d.proofShas, [work.sha]);
    assert.equal(d.ackArgs.includes('--sha'), false);
    assert.deepEqual(d.ackArgs.slice(0, 4), ['--id', 'BRO-3471', '--verify', 'node --test a.test.mjs']);
  });
  test('only merge/ledger commits -> not-landed with an explaining comment', () => {
    const d = triageCard({ ref: 'BRO-3471', row: stranded, commits: [merge, bypass], verifyCmd: 'node --test a.test.mjs' });
    assert.equal(d.action, 'not-landed');
    assert.equal(d.ackArgs, undefined);
    assert.match(d.comment, /not provably on origin\/main/);
    assert.match(d.comment, /merge commit/);
  });
  test('no commits -> not-landed', () => {
    assert.equal(triageCard({ ref: 'BRO-9', row: stranded, commits: [], verifyCmd: 'x' }).action, 'not-landed');
  });
  test('work landed but no safe VERIFY -> needs-verify, never acked', () => {
    const d = triageCard({ ref: 'BRO-3471', row: stranded, commits: [work], verifyCmd: null });
    assert.equal(d.action, 'needs-verify');
    assert.equal(d.ackArgs, undefined);
  });
});

describe('currentVerifyCmd', () => {
  const extract = (t) => { const m = /VERIFY: (.+)/.exec(t); return { cmd: m && !/owner-judgment/.test(m[1]) ? m[1].trim() : null }; };
  test('newest comment VERIFY wins over description', () => {
    const issue = {
      description: 'VERIFY: owner-judgment',
      comments: { nodes: [
        { createdAt: '2026-10-14T00:00:00Z', body: 'VERIFY: node --test new.test.mjs' },
        { createdAt: '2026-10-01T00:00:00Z', body: 'VERIFY: node --test old.test.mjs' },
      ] },
    };
    assert.equal(currentVerifyCmd(issue, extract), 'node --test new.test.mjs');
  });
  test('falls back to description, then null', () => {
    assert.equal(currentVerifyCmd({ description: 'VERIFY: node --test d.test.mjs', comments: { nodes: [] } }, extract), 'node --test d.test.mjs');
    assert.equal(currentVerifyCmd({ description: 'nothing' }, extract), null);
    assert.equal(currentVerifyCmd(null, extract), null);
  });
});

describe('hasTriageComment', () => {
  test('a card already carrying the not-landed comment is not commented again', () => {
    const d = triageCard({ ref: 'BRO-9', row: stranded, commits: [], verifyCmd: null });
    assert.equal(hasTriageComment({ comments: { nodes: [{ body: d.comment }] } }), true);
    assert.equal(hasTriageComment({ comments: { nodes: [{ body: 'other' }] } }), false);
    assert.equal(hasTriageComment(null), false);
  });
});
