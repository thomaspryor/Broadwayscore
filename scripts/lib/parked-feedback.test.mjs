import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectParkedIssues, buildParkedCard } = require('./parked-feedback.js');
const { evaluateVerifiability } = require('./verify-gate.js');

const now = Date.parse('2026-11-19T15:00:00Z');
const base = { state: 'open', number: 1192, title: 'Content request needs review: User is offering cast list data for Dirty Dancing', created_at: '2026-11-18T01:48:50Z', labels: [{ name: 'feedback-digest' }, { name: 'needs-review' }] };

describe('parked feedback -> card selection (#1192)', () => {
  it('selects an open parked feedback issue with no card', () => {
    assert.deepEqual(selectParkedIssues([base], now).map((i) => i.number), [1192]);
  });
  it('skips issues already carded, closed, too new, PRs, or not from the feedback pipeline', () => {
    const cases = [
      { ...base, labels: [...base.labels, { name: 'carded' }] },
      { ...base, state: 'closed' },
      { ...base, created_at: '2026-11-19T14:30:00Z' },
      { ...base, pull_request: {} },
      { ...base, title: 'Some other review item', labels: [{ name: 'needs-review' }] },
    ];
    assert.equal(selectParkedIssues(cases, now).length, 0);
  });
  it('keeps spam-flagged digests (they can hide a real request)', () => {
    const spam = { ...base, number: 1083, title: 'Feedback Needs Review (spam-flagged) - 2026-10-15', labels: [{ name: 'needs-review' }] };
    assert.equal(selectParkedIssues([spam], now).length, 1);
    assert.match(buildParkedCard(spam).description, /spam filter/);
  });
});

describe('parked feedback card', () => {
  const card = buildParkedCard(base);
  it('links the issue and carries a VERIFY the Done gate accepts', () => {
    assert.match(card.description, /issues\/1192/);
    const v = evaluateVerifiability(card.description, []);
    assert.equal(v.cmd, 'node scripts/check-review-item-resolved.js --issue-closed=1192');
  });
  it('never carries reader contact details', () => {
    assert.doesNotMatch(card.description, /@/);
  });
});
