// BRO-266: cloud-memory/MEMORY.md is loaded every session. Keep it within its
// caps (180 lines / 20KB) and make sure every link points at a real file, so a
// merge or archive of a memory file cannot leave a dangling pointer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cloud-memory');
const index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');

test('MEMORY.md index is within its line and byte caps', () => {
  assert.ok(index.split('\n').length <= 181, 'over 180 lines');
  assert.ok(Buffer.byteLength(index, 'utf8') <= 20 * 1024, 'over 20KB');
});

test('every file the index links to exists', () => {
  const targets = new Set();
  for (const m of index.matchAll(/\]\(([^)#\s]+\.md)\)/g)) targets.add(m[1]);
  for (const m of index.matchAll(/\[\[([^\]|#]+\.md)\]\]/g)) targets.add(m[1]);
  assert.ok(targets.size > 50, 'index parsed no links');
  const missing = [...targets].filter((t) => !fs.existsSync(path.join(dir, t)));
  assert.deepEqual(missing, [], `dangling index links: ${missing.join(', ')}`);
});
