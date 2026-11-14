/**
 * linear-predispatch-audit.test.mjs — BRO-3431.
 *
 * Covers the verdict mapping predispatch-queue-audit.js's digest banner
 * (send-morning-digest.js's "Predispatch queue backlog" block) now depends
 * on — get this wrong and the backlog number lies again, just via a
 * different source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const src = require('./linear-predispatch-audit.js');

const ARMED = 'Do the thing.\n\n## Acceptance criteria\n`node --test scripts/lib/thing.test.mjs`\n';

function issue(over = {}) {
  return {
    identifier: 'BRO-3000',
    title: 'Something needs doing',
    description: ARMED,
    priority: 2,
    state: { name: 'Backlog', type: 'backlog' },
    ...over,
  };
}

test('classifyLinearIssueForAudit: armed P0/P1 -> OK-TO-DISPATCH', () => {
  const c = src.classifyLinearIssueForAudit(issue({ priority: 1 }));
  assert.equal(c.verdict, 'OK-TO-DISPATCH');
  assert.equal(c.id, 'linear:BRO-3000');
});

test('classifyLinearIssueForAudit: unarmed P0/P1 -> DO-NOT-DISPATCH', () => {
  const c = src.classifyLinearIssueForAudit(issue({ description: 'No acceptance criteria here.' }));
  assert.equal(c.verdict, 'DO-NOT-DISPATCH');
  assert.deepEqual(c.flags, ['unarmed']);
});

test('classifyLinearIssueForAudit: Medium/Low priority is excluded, not counted as blocked', () => {
  assert.equal(src.classifyLinearIssueForAudit(issue({ priority: 3 })), null);
  assert.equal(src.classifyLinearIssueForAudit(issue({ priority: 0, title: 'Tidy up' })), null);
});

test('classifyLinearIssueForAudit: already-started issues are excluded, not counted as blocked', () => {
  assert.equal(src.classifyLinearIssueForAudit(issue({ state: { name: 'In Progress', type: 'started' } })), null);
});

test('classifyLinearIssueForAudit: terminal-state issues are excluded', () => {
  assert.equal(src.classifyLinearIssueForAudit(issue({ state: { name: 'Done', type: 'completed' } })), null);
});

test('classifyLinearIssueForAudit: malformed issue is excluded, never throws', () => {
  assert.equal(src.classifyLinearIssueForAudit(null), null);
  assert.equal(src.classifyLinearIssueForAudit({}), null);
});

test('fetchLinearBacklogClassifications: no client -> ok:false, never throws', async () => {
  const res = await src.fetchLinearBacklogClassifications(null);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-linear-client');
  assert.deepEqual(res.classifications, []);
});

test('fetchLinearBacklogClassifications: paginates and classifies, excludes out-of-scope issues', async () => {
  const pages = [
    {
      issues: {
        nodes: [
          issue({ identifier: 'BRO-1', priority: 1 }), // OK-TO-DISPATCH
          issue({ identifier: 'BRO-2', priority: 2, description: 'unarmed' }), // DO-NOT-DISPATCH
          issue({ identifier: 'BRO-3', priority: 3 }), // excluded (not P0/P1)
        ],
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
      },
    },
    {
      issues: {
        nodes: [issue({ identifier: 'BRO-4', priority: 1, state: { name: 'In Progress', type: 'started' } })], // excluded
        pageInfo: { hasNextPage: false },
      },
    },
  ];
  let call = 0;
  const client = { graphql: async () => pages[call++] };
  const res = await src.fetchLinearBacklogClassifications(client, {});
  assert.equal(res.ok, true);
  assert.equal(res.scanned, 4);
  assert.equal(res.classifications.length, 2);
  assert.deepEqual(res.classifications.map((c) => c.id).sort(), ['linear:BRO-1', 'linear:BRO-2']);
});

test('fetchLinearBacklogClassifications: a fetch error reports ok:false, never an empty-looking success', async () => {
  const client = { graphql: async () => { throw new Error('boom'); } };
  const res = await src.fetchLinearBacklogClassifications(client, {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /linear-fetch-failed/);
});
