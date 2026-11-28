import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const proposal = require('../../scripts/lib/feedback-proposal.js');

test('legacy needs-review issues produce a diagnosis without accepting arbitrary bodies', () => {
  const body = 'Content-addition request from user feedback\n\n**Show:** Example Show | **Priority:** low\n\n**Original message:**\nPlease add this show.\n\n**Routing:**\n- no route';
  const d = proposal.buildNeedsReviewDiagnosis(body, {});
  assert.equal(d.submitterShow, 'Example Show');
  assert.equal(d.originalMessage, 'Please add this show.');
  assert.equal(d.submittedAt, null);
  assert.equal(proposal.buildNeedsReviewDiagnosis('unrelated issue', {}), null);
});

test('proposal ledger merge preserves independently sent issues as whole entries', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proposal-merge-'));
  try {
    const keys = ['1124', '1193'];
    const base = { version: 1, entries: {} };
    const a = { version: 1, entries: { [keys[0]]: { proposalSentAt: '2026-11-19T19:28:28Z', kind: 'needs-fix' } } };
    const b = { version: 1, entries: { [keys[1]]: { proposalSentAt: '2026-11-19T19:54:12Z', kind: 'needs-fix' } } };
    for (const [name, obj] of Object.entries({ base, a, b })) writeFileSync(path.join(dir, name), JSON.stringify(obj));
    const result = spawnSync('bash', ['scripts/lib/merge-keep-run.sh', 'B', path.join(dir, 'base'), path.join(dir, 'a'), path.join(dir, 'b'), 'data/audit/feedback-proposals.json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const merged = JSON.parse(readFileSync(path.join(dir, 'a'), 'utf8'));
    assert.deepEqual(merged.entries, { ...a.entries, ...b.entries });
    assert.equal(proposal.decideSend(merged, keys[0]).reason, 'already-sent');
    assert.equal(proposal.decideSend(merged, keys[1]).reason, 'already-sent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// BRO-8260: an already-fixed issue whose soft-fail close step failed stayed open forever.
test('stranded already-fixed sweep selects only open, non-reopened issues the ledger marked already-fixed', () => {
  const ledger = { version: 1, entries: {
    '10': { proposalSentAt: '2026-11-20T00:00:00Z', kind: 'already-fixed' },
    '11': { proposalSentAt: '2026-11-20T00:00:00Z', kind: 'needs-fix' },
    '12': { proposalSentAt: '2026-11-20T00:00:00Z', kind: 'already-fixed' },
    '13': { proposalSentAt: '2026-11-20T00:00:00Z', kind: 'already-fixed' },
    '14': { proposalSentAt: '2026-11-20T00:00:00Z', kind: 'already-fixed' },
  } };
  const issues = [
    { number: 10, state: 'open', state_reason: null },
    { number: 11, state: 'open' },
    { number: 12, state: 'open', state_reason: 'reopened' },
    { number: 13, state: 'open', pull_request: {} },
    { number: 14, state: 'closed' },
    { number: 15, state: 'open' },
  ];
  assert.deepEqual(proposal.selectStrandedAlreadyFixed(issues, ledger).map((i) => i.number), [10]);
  assert.deepEqual(proposal.selectStrandedAlreadyFixed(issues, { entries: {} }), []);
});

test('sweep comment dedupe recognises the workflow close comment', () => {
  const body = proposal.buildAlreadyFixedComment(['https://broadwayscorecard.com/show/x']);
  assert.ok(proposal.hasAlreadyFixedComment([{ body: 'Work card filed' }, { body }]));
  assert.ok(!proposal.hasAlreadyFixedComment([{ body: 'Work card filed' }]));
  // The workflow posts its own copy of this comment; the sweep's dedupe keys on the heading.
  const wf = readFileSync('.github/workflows/auto-fix-feedback-bug.yml', 'utf8');
  assert.ok(wf.includes(`'${proposal.ALREADY_FIXED_HEADING}'`), 'auto-fix close step comment heading drifted from ALREADY_FIXED_HEADING');
});
