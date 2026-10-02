// BRO-4487: which auto-filed alert cards may be cancelled once their condition clears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ledgerCandidates, skipReason, cancelReason, AUTO_FILED_LINE } = require('./resolved-alert-card-sweep.js');

const ledger = {
  conditions: {
    'gap:a': { status: 'resolved', linearIdentifier: 'BRO-1' },
    'gap:b': { status: 'open', linearIdentifier: 'BRO-2' },
    'design:x': { status: 'resolved', linearIdentifier: 'BRO-3030' },
    'design:y': { status: 'open', linearIdentifier: 'BRO-3030' },
    'two:a': { status: 'resolved', linearIdentifier: 'BRO-9' },
    'two:b': { status: 'resolved', linearIdentifier: 'BRO-9' },
    'no-card': { status: 'resolved' },
  },
};

test('ledgerCandidates: only cards whose single linked condition is resolved', () => {
  assert.deepEqual(ledgerCandidates(ledger), [{ identifier: 'BRO-1', conditionKey: 'gap:a' }]);
});

const issue = (over = {}) => ({
  state: { type: 'backlog' },
  description: `PARKED: ${AUTO_FILED_LINE}gap:a); parked for triage.`,
  comments: { nodes: [] },
  ...over,
});

test('skipReason: an untouched backlog card filed for exactly this condition is eligible', () => {
  assert.equal(skipReason(issue(), 'gap:a'), null);
  assert.equal(skipReason(issue({ state: { type: 'unstarted' } }), 'gap:a'), null);
});

test('skipReason: started, closed, commented or foreign cards are never cancelled', () => {
  assert.equal(skipReason(issue({ state: { type: 'started' } }), 'gap:a'), 'state-started');
  assert.equal(skipReason(issue({ state: { type: 'completed' } }), 'gap:a'), 'state-completed');
  assert.equal(skipReason(issue({ comments: { nodes: [{ body: 'looking into it' }] } }), 'gap:a'), 'has-comments');
  assert.equal(skipReason(issue({ description: 'Human-filed design card mentioning gap:a' }), 'gap:a'), 'not-filed-for-this-condition');
  assert.equal(skipReason(issue(), 'gap:ab'), 'not-filed-for-this-condition', 'a key that is a prefix of another must not match');
  assert.equal(skipReason(null, 'gap:a'), 'issue-not-found');
});

test('cancelReason satisfies the 20-character cancel gate and names the condition', () => {
  const r = cancelReason('gap:a');
  assert.ok(r.length >= 20);
  assert.match(r, /gap:a/);
});
