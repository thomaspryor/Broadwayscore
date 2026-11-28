import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { extractCardIds, buildFreshnessNotice, freshnessNotice } = createRequire(import.meta.url)('./card-freshness.js');

const DONE_7741 = { identifier: 'BRO-7741', state: { name: 'Done' }, updatedAt: '2026-11-19T10:00:00Z',
  comments: { nodes: [{ createdAt: '2026-11-18T05:00:00Z' }, { createdAt: '2026-11-19T09:00:00Z' }] } };

test('BRO-7741 resumed: Done card is injected with the verify-before-answering instruction', async () => {
  const seen = [];
  const out = await freshnessNotice({
    title: 'BRO-7741 fast manual URL channel', transcriptText: 'the fix isn\'t live yet BRO-7741 BRO-5955',
    env: {}, fetchIssue: async (id) => { seen.push(id); return id === 'BRO-7741' ? DONE_7741 : null; },
  });
  assert.equal(seen[0], 'BRO-7741', 'the title card is looked up first');
  assert.match(out, /BRO-7741 is now Done \(updated 2026-11-19\): read its latest comment \(2026-11-19\) and git log origin\/main before answering; do not claim work is unreleased without checking/);
});
test('fails open: fetch error, no ids, disabled all give empty text', async () => {
  assert.equal(await freshnessNotice({ title: 'BRO-1234', transcriptText: '', env: {}, fetchIssue: async () => { throw new Error('down'); } }), '');
  assert.equal(await freshnessNotice({ title: 'no card here', transcriptText: 'x', env: {}, fetchIssue: async () => DONE_7741 }), '');
  assert.equal(await freshnessNotice({ title: 'BRO-7741', transcriptText: '', env: { CARD_FRESHNESS_DISABLED: 'true' }, fetchIssue: async () => DONE_7741 }), '');
});
test('extractCardIds ranks by mentions and caps at 3', () => {
  assert.deepEqual(extractCardIds(['BRO-1111 BRO-2222 BRO-2222 BRO-3333 BRO-4444 BRO-2222']).slice(0, 2), ['BRO-2222', 'BRO-4444']);
  assert.equal(extractCardIds(['BRO-1111 BRO-2222 BRO-3333 BRO-4444']).length, 3);
  assert.equal(buildFreshnessNotice([]), '');
});

test('ties go to the most recent mention, not the highest id', () => {
  assert.equal(extractCardIds(['BRO-9000 BRO-1111'])[0], 'BRO-1111');
});
