// BRO-2556: cloud sessions could only discover the notes MEMORY.md names.
// cloud-memory-index.js writes an uncapped cloud-memory/INDEX.txt; these tests
// pin the parser on the real frontmatter shapes and prove, on the committed
// repo, that a note MEMORY.md does not name is findable from INDEX.txt by
// following .claude/CLOUD.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const idx = require('./cloud-memory-index.js');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIRROR = path.join(REPO, 'cloud-memory');

test('parses flat frontmatter, JSON-escaped quotes and single quotes', () => {
  const fm = idx.parseNoteFrontmatter('---\nname: Stars\ndescription: "A \\"band\\", not a number"\ntype: feedback\n---\nbody');
  assert.equal(fm.name, 'Stars');
  assert.equal(fm.description, 'A "band", not a number');
  assert.equal(fm.type, 'feedback');
  assert.equal(idx.parseNoteFrontmatter("---\ndescription: 'it''s fine'\n---\n").description, "it's fine");
});

test('reads type nested under metadata: (about half the real notes) without overriding a top-level key', () => {
  const fm = idx.parseNoteFrontmatter('---\nname: Ref\ndescription: d\nmetadata:\n  type: reference\n  archived: true\n---\n');
  assert.equal(fm.type, 'reference');
  assert.equal(fm.archived, true);
  assert.equal(idx.parseNoteFrontmatter('---\ntype: feedback\nmetadata:\n  type: project\n---\n').type, 'feedback');
});

test('empty frontmatter, block scalars and emoji truncation are handled', () => {
  assert.equal(idx.indexLine('e.md', '---\n---\n# Heading\n\n---\nrule below'), 'e.md | - | Heading');
  assert.equal(idx.indexLine('b.md', '---\nname: Folded\ndescription: >\n  long text\n---\n'), 'b.md | - | Folded');
  const line = idx.indexLine('u.md', `---\ndescription: ${'a'.repeat(296)}🎭🎭🎭\n---\n`);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(line), 'no lone high surrogate');
});

// BRO-5261 retro-review of BRO-2684.
test('a cut that lands inside emoji keeps whole code points', () => {
  const line = idx.indexLine('t.md', `---\ndescription: ${'a'.repeat(295)}${'🎭'.repeat(10)}\n---\n`);
  assert.ok(line.endsWith('...'), 'truncated');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(line), 'no lone surrogate');
});

test('frontmatter closing on the last line, block-scalar indicators and their lines', () => {
  assert.equal(idx.parseNoteFrontmatter('---\ntype: project\n---').body, '');
  assert.equal(idx.indexLine('n.md', '---\ntype: project\n---'), 'n.md | project | (no description)');
  assert.equal(idx.indexLine('i.md', '---\nname: Ind\ndescription: >-2\n  text\n---\n'), 'i.md | - | Ind');
  assert.equal(idx.indexLine('c.md', '---\nname: Com\ndescription: > # folded\n  text\n---\n'), 'c.md | - | Com');
  // Prose inside a block scalar is not a nested key.
  assert.equal(idx.indexLine('k.md', '---\ndescription: |\n  type: secret\n  archived: true\n---\n# H'), 'k.md | - | H');
  // A key after the block scalar is still read.
  assert.equal(idx.parseNoteFrontmatter('---\ndescription: |\n  x\ntype: feedback\n---\n').type, 'feedback');
});

test('a note with no frontmatter falls back to its first heading', () => {
  assert.equal(idx.indexLine('loop.md', '# Autonomous Loop — Cron Map\n\ntext'), 'loop.md | - | Autonomous Loop — Cron Map');
});

test('archived notes are tagged, pipes and newlines flattened, long descriptions visibly truncated', () => {
  const line = idx.indexLine('a.md', `---\ndescription: x | y\narchived: true\ntype: feedback\n---\n`);
  assert.equal(line, 'a.md | feedback [archived] | x / y');
  const long = idx.indexLine('b.md', `---\ndescription: ${'w '.repeat(400)}\n---\n`);
  assert.ok(long.endsWith('...'));
  assert.ok(long.length < idx.DESCRIPTION_MAX + 20);
});

test('buildIndex skips MEMORY.md, dotfiles and non-.md, sorts, and is byte-stable', () => {
  const entries = [
    { file: 'z.md', text: '---\ndescription: zed\n---\n' },
    { file: 'MEMORY.md', text: '- [x](x.md)' },
    { file: '.hidden.md', text: '' },
    { file: 'notes.txt', text: '' },
    { file: 'a.md', text: '---\ndescription: ay\n---\n' },
  ];
  const out = idx.buildIndex(entries);
  assert.equal(out, `${idx.HEADER}\na.md | - | ay\nz.md | - | zed\n`);
  assert.equal(idx.buildIndex([...entries].reverse()), out);
});

test('writeIndex writes once, then reports unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmi-'));
  fs.writeFileSync(path.join(dir, 'n.md'), '---\ndescription: note\n---\n');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '');
  assert.deepEqual([idx.writeIndex(dir).written, idx.writeIndex(dir).written], [true, false]);
  assert.match(fs.readFileSync(path.join(dir, idx.INDEX_BASENAME), 'utf8'), /^n\.md \| - \| note$/m);
});

test('INDEX.txt is not .md, so the merge and reconcile never treat it as a note', () => {
  assert.equal(idx.INDEX_BASENAME.endsWith('.md'), false);
});

// Acceptance (card): a note that is NOT one of MEMORY.md's pointers can be
// located using only repo files, following .claude/CLOUD.md.
test('acceptance: CLOUD.md points at INDEX.txt and the committed index finds notes MEMORY.md does not name', () => {
  const cloud = fs.readFileSync(path.join(REPO, '.claude', 'CLOUD.md'), 'utf8');
  assert.match(cloud, /grep -i <topic> cloud-memory\/INDEX\.txt/);
  const indexText = fs.readFileSync(path.join(MIRROR, idx.INDEX_BASENAME), 'utf8');
  const indexed = new Set(indexText.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' | ')[0]));
  const memoryMd = fs.readFileSync(path.join(MIRROR, 'MEMORY.md'), 'utf8');
  // Picked from the committed index's own file set, so a note that landed
  // after the last regeneration can't fail this.
  const unlisted = [...indexed].filter((f) => !memoryMd.includes(f) && fs.existsSync(path.join(MIRROR, f)));
  assert.ok(unlisted.length > 100, `expected many notes MEMORY.md does not name, got ${unlisted.length}`);
  for (const f of unlisted.slice(0, 25)) {
    const line = indexText.split('\n').find((l) => l.startsWith(`${f} | `));
    assert.ok(line && line.split(' | ')[2].length > 0, `${f} has an index line with a description`);
  }
});
