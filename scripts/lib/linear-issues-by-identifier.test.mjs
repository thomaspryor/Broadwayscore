// BRO-7559: Done cards that left the completion window are re-fetched by id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fetchLinearIssuesByIdentifier, buildIssuesByIdentifierQuery } = require('./linear-recheck-source.js');

const node = (id, type = 'completed') => ({ identifier: id, title: `t ${id}`, description: 'VERIFY: node --test a.test.mjs', updatedAt: '2026-11-01T00:00:00Z', completedAt: '2026-11-01T00:00:00Z', state: { name: 'Done', type }, comments: { nodes: [] } });

test('aliased query, ids validated and deduped, cards mapped', async () => {
  const seen = [];
  const client = { graphql: async (q) => { seen.push(q); return { i0: node('BRO-1'), i1: node('BRO-22'), i2: null }; } };
  const r = await fetchLinearIssuesByIdentifier(client, ['bro-1', 'BRO-22', 'BRO-1', 'BRO-9"){x}', '']);
  assert.equal(r.error, null);
  assert.deepEqual(r.cards.map((c) => [c.id, c.status]), [['BRO-1', 'Done'], ['BRO-22', 'Done']]);
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0], /BRO-9/);
  assert.match(buildIssuesByIdentifierQuery(['BRO-1']), /i0: issue\(id: "BRO-1"\)/);
});

test('never throws: a failing call is reported with what was fetched', async () => {
  let n = 0;
  const client = { graphql: async () => { if (n++) throw new Error('429'); return { i0: node('BRO-1') }; } };
  const ids = Array.from({ length: 25 }, (_, i) => `BRO-${i + 1}`);
  const r = await fetchLinearIssuesByIdentifier(client, ids);
  assert.equal(r.truncated, true);
  assert.match(r.error, /429/);
  assert.equal(r.cards.length, 1);
});
