// BRO-7189: `block` overrides `line-clamp-N`'s display, so the clamp is lost.
// Run: node --test tests/unit/block-line-clamp.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findConflicts, scanTree } = require('../../scripts/lib/block-line-clamp.js');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('detector flags block + line-clamp and ignores responsive block', () => {
  assert.equal(findConflicts('<a className="block text-sm line-clamp-1">x</a>').length, 1);
  assert.equal(findConflicts('<a className={`line-clamp-2 block ${x}`}>x</a>').length, 1);
  assert.equal(findConflicts('<a className="hidden sm:block line-clamp-1">x</a>').length, 0);
  assert.equal(findConflicts('<a className="inline-block line-clamp-1">x</a>').length, 0);
  assert.equal(findConflicts('<a className="block text-sm">x</a>').length, 0);
});

test('no element in src/ combines block with line-clamp-N', () => {
  const hits = scanTree(ROOT);
  assert.deepEqual(hits, [], `drop \`block\` (line-clamp is already block-level):\n${JSON.stringify(hits, null, 2)}`);
});
