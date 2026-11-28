// BRO-7693: selection rules for "it's fixed" owner drafts.
const assert = require('assert');
const { GRACE_MIN, selectIssuesNeedingDraft, showLinkFor } = require('./draft-fixed-replies');

const base = { state: 'closed', state_reason: 'completed', closed_at: '2026-11-18T10:00:00Z', labels: [{ name: 'bug-diagnosis' }, { name: 'auto-fixed' }] };
const issues = [
  { number: 1, ...base },
  { number: 2, ...base, state_reason: 'not_planned' },
  { number: 3, ...base, closed_at: '2026-11-10T10:00:00Z' },
  { number: 4, ...base, labels: [{ name: 'bug-diagnosis' }, { name: 'auto-fixed' }, { name: 'reply-drafted' }] },
  { number: 5, ...base, labels: [{ name: 'needs-review' }] },
  { number: 6, ...base, state: 'open' },
  { number: 7, ...base, pull_request: {} },
  { number: 8, ...base, labels: [{ name: 'bug-diagnosis' }] }, // closed by hand, no auto-fixed label: now drafted
  { number: 10, ...base, labels: [{ name: 'bug-diagnosis' }, { name: 'reply-drafted' }] }, // hand-closed, already drafted
  { number: 11, ...base, labels: [{ name: 'bug-diagnosis' }, { name: 'feedback-digest' }] }, // content request
  { number: 12, ...base, labels: [{ name: 'bug-diagnosis' }, { name: 'duplicate' }] },
  { number: 13, ...base, labels: ['bug-diagnosis'] }, // plain string labels
  { number: 14, ...base, labels: [{ name: 'bug-diagnosis' }, { name: 'not-a-bug' }] },
  { number: 15, ...base, labels: [{ name: 'bug-diagnosis' }, { name: 'needs-manual-review' }] },
];
assert.deepStrictEqual(selectIssuesNeedingDraft(issues, '2026-11-17T00:00:00Z', Date.parse('2026-11-19T00:00:00Z')).map((i) => i.number), [1, 8, 13]);
assert.deepStrictEqual(selectIssuesNeedingDraft(null, '2026-11-17T00:00:00Z'), []);

const shows = [{ id: 'gotta-dance-2026', title: 'Gotta Dance', slug: 'gotta-dance' }, { id: 'a', title: 'Dup' }, { id: 'b', title: 'Dup' }];
assert.strictEqual(showLinkFor('gotta dance', shows), 'https://broadwayscorecard.com/show/gotta-dance');
assert.strictEqual(showLinkFor('Dup', shows), null, 'ambiguous title gets no link');
assert.strictEqual(showLinkFor('Unknown', shows), null);
assert.strictEqual(showLinkFor(null, shows), null);
// W1: an issue closed seconds ago belongs to the auto-fix workflow's own draft step
const closedAt = Date.parse(base.closed_at);
assert.deepStrictEqual(selectIssuesNeedingDraft([{ number: 9, ...base }], '2026-11-17T00:00:00Z', closedAt + 60000), []);
assert.strictEqual(selectIssuesNeedingDraft([{ number: 9, ...base }], '2026-11-17T00:00:00Z', closedAt + (GRACE_MIN + 1) * 60000).length, 1);
console.log('draft-fixed-replies OK');
