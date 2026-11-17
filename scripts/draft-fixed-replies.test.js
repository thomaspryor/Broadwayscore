// BRO-7693: selection rules for "it's fixed" owner drafts.
const assert = require('assert');
const { selectIssuesNeedingDraft, showLinkFor } = require('./draft-fixed-replies');

const base = { state: 'closed', state_reason: 'completed', closed_at: '2026-11-18T10:00:00Z', labels: [{ name: 'bug-diagnosis' }] };
const issues = [
  { number: 1, ...base },
  { number: 2, ...base, state_reason: 'not_planned' },
  { number: 3, ...base, closed_at: '2026-11-10T10:00:00Z' },
  { number: 4, ...base, labels: [{ name: 'bug-diagnosis' }, { name: 'reply-drafted' }] },
  { number: 5, ...base, labels: [{ name: 'needs-review' }] },
  { number: 6, ...base, state: 'open' },
  { number: 7, ...base, pull_request: {} },
];
assert.deepStrictEqual(selectIssuesNeedingDraft(issues, '2026-11-17T00:00:00Z').map((i) => i.number), [1]);
assert.deepStrictEqual(selectIssuesNeedingDraft(null, '2026-11-17T00:00:00Z'), []);

const shows = [{ id: 'gotta-dance-2026', title: 'Gotta Dance', slug: 'gotta-dance' }, { id: 'a', title: 'Dup' }, { id: 'b', title: 'Dup' }];
assert.strictEqual(showLinkFor('gotta dance', shows), 'https://broadwayscorecard.com/show/gotta-dance');
assert.strictEqual(showLinkFor('Dup', shows), null, 'ambiguous title gets no link');
assert.strictEqual(showLinkFor('Unknown', shows), null);
assert.strictEqual(showLinkFor(null, shows), null);
console.log('draft-fixed-replies OK');
