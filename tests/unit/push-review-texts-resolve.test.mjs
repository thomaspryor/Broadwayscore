// BRO-6941: a stale writer's rewrite of a file another writer deleted must not
// resurrect it. Requires the real resolver (scripts/lib/resolve-modify-delete.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveModifyDelete } = require('../../scripts/lib/resolve-modify-delete.js');
const rev = (o) => JSON.stringify({ outlet: 'x', ...o });

test('stale rewrite with same fullText keeps the deletion', () => {
  const base = rev({ fullText: 'Long review body.', rejectedBy: null });
  const ours = rev({ fullText: 'Long review body.', rejectedBy: 'ensemble-scoreability-check' });
  assert.equal(resolveModifyDelete({ baseRaw: base, oursRaw: ours }), 'delete');
});

test('real fullText change keeps the workflow copy', () => {
  const base = rev({ fullText: 'short' });
  const ours = rev({ fullText: 'a much longer re-fetched body' });
  assert.equal(resolveModifyDelete({ baseRaw: base, oursRaw: ours }), 'keep');
});

test('empty or invalid workflow copy is deleted', () => {
  const base = rev({ fullText: 'body' });
  assert.equal(resolveModifyDelete({ baseRaw: base, oursRaw: rev({ fullText: '' }) }), 'delete');
  assert.equal(resolveModifyDelete({ baseRaw: base, oursRaw: '{not json' }), 'delete');
  assert.equal(resolveModifyDelete({ baseRaw: base, oursRaw: null }), 'delete');
});

test('missing base with real text keeps workflow copy', () => {
  assert.equal(resolveModifyDelete({ baseRaw: null, oursRaw: rev({ fullText: 'new' }) }), 'keep');
});
