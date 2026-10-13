import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { buildIndex, searchIndex } = require('./cloud-memory-index.js');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cmi-'));
  writeFileSync(join(dir, 'MEMORY.md'), '- [x](a.md)\n');
  writeFileSync(join(dir, 'a.md'), '---\nname: Alpha note\ndescription: poller 404 handling\ntype: feedback\n---\nbody\n');
  writeFileSync(join(dir, 'b.md'), '# Beta heading\nno frontmatter here\n');
  writeFileSync(join(dir, 'c.txt'), 'ignored');
  return dir;
}

test('indexes every .md note except MEMORY.md, with a fallback description', () => {
  const dir = fixture();
  try {
    const idx = buildIndex(dir);
    assert.deepEqual(idx.map((e) => e.file), ['a.md', 'b.md']);
    assert.equal(idx[0].description, 'poller 404 handling');
    assert.equal(idx[1].description, 'Beta heading');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('search requires all terms, case-insensitive', () => {
  const dir = fixture();
  try {
    const idx = buildIndex(dir);
    assert.deepEqual(searchIndex(idx, ['POLLER', '404']).map((e) => e.file), ['a.md']);
    assert.equal(searchIndex(idx, ['poller', 'zzz']).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real cloud-memory: finds notes beyond the MEMORY.md pointers', () => {
  const idx = buildIndex(new URL('../../cloud-memory', import.meta.url).pathname);
  const pointers = new Set([...readFileSync(new URL('../../cloud-memory/MEMORY.md', import.meta.url), 'utf8').matchAll(/\(([^)]+\.md)\)/g)].map((m) => m[1]));
  const outside = idx.filter((e) => !pointers.has(e.file));
  assert.ok(outside.length > 100, 'most notes are not in MEMORY.md');
  const target = outside[0];
  assert.ok(searchIndex(idx, [target.file.replace(/\.md$/, '')]).some((e) => e.file === target.file));
});
