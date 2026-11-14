// BRO-4158: scripts/tests/ is covered by one push-path glob in test.yml, so a
// solo edit to any scripts/tests/*.test.mjs triggers CI. Hand-listed literal
// entries are redundant and drift; this keeps the glob and bans new literals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const text = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
const entries = [...text.matchAll(/^\s*- '(scripts\/tests\/[^']*)'/gm)].map(m => m[1]);

test('test.yml keeps the scripts/tests/** push-path glob', () => {
  assert.ok(entries.includes('scripts/tests/**'));
});

test('test.yml has no hand-listed scripts/tests/<file> entries', () => {
  const literals = entries.filter(e => !e.includes('*'));
  assert.deepEqual(literals, [], 'covered by scripts/tests/**; remove the literal lines');
});

test('the glob matches a scripts/tests test file under GitHub path semantics', () => {
  // `**` matches any depth, so a solo scripts/tests/x.test.mjs push is covered.
  const globToRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
  assert.match('scripts/tests/ack-landed-job-id.test.mjs', globToRe('scripts/tests/**'));
});
