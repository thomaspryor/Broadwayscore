import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { isTextOnlyDiff } = createRequire(import.meta.url)('./visual-text-only-diff.js');

const hunk = (body) => `diff --git a/src/app/x/page.tsx b/src/app/x/page.tsx\nindex 1..2 100644\n--- a/src/app/x/page.tsx\n+++ b/src/app/x/page.tsx\n@@ -1,3 +1,3 @@\n${body}\n`;

test('copy change inside a JSX tag is text-only', () => {
  assert.equal(isTextOnlyDiff(hunk('-<p className="a">Old words</p>\n+<p className="a">New words here</p>')), true);
});
test('string literal change stays gated (can be a style value)', () => {
  assert.equal(isTextOnlyDiff(hunk("-  title: 'Old title',\n+  title: 'New title',")), false);
  assert.equal(isTextOnlyDiff(hunk("-  const s = { gap: '4' };\n+  const s = { gap: '8' };")), false);
  assert.equal(isTextOnlyDiff(hunk("-  return c ? 'a' : 'b';\n+  return c ? 'b' : 'a';")), false);
});
test('bare prose line change is text-only', () => {
  assert.equal(isTextOnlyDiff(hunk('-  We do not track you.\n+  We never track you.')), true);
});
test('className change is visual', () => {
  assert.equal(isTextOnlyDiff(hunk('-<p className="a">Hi</p>\n+<p className="b">Hi</p>')), false);
});
test('prop on its own line is visual', () => {
  assert.equal(isTextOnlyDiff(hunk('-  size="lg"\n+  size="sm"')), false);
  assert.equal(isTextOnlyDiff(hunk('+  size={big}')), false);
});
test('conditional rendering and added elements are visual', () => {
  assert.equal(isTextOnlyDiff(hunk('+{open && (')), false);
  assert.equal(isTextOnlyDiff(hunk('+<Badge />')), false);
});
test('an apostrophe in JSX text does not hide a later className edit', () => {
  const body = "-<p>We don't track you.</p>\n-<span className=\"a\">x</span>\n-<p>It's free.</p>\n+<p>We don't track you.</p>\n+<span className=\"b\">x</span>\n+<p>It's free.</p>";
  assert.equal(isTextOnlyDiff(hunk(body)), false);
});
test('new files, deletions, empty and header-only patches are visual', () => {
  assert.equal(isTextOnlyDiff('diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+hi\n'), false);
  assert.equal(isTextOnlyDiff(''), false);
  assert.equal(isTextOnlyDiff(null), false);
  assert.equal(isTextOnlyDiff('diff --git a/x b/x\nindex 1..2\n'), false);
});
test('a text change mixed with a style change is visual', () => {
  assert.equal(isTextOnlyDiff(hunk('-<p>Old</p>\n-  gap: 4,\n+<p>New</p>\n+  gap: 8,')), false);
});

// Review bypass cases (BRO-5844): each must stay gated.
const visual = {
  'comment out code': '+/*\n <Hero />\n+*/',
  'block comment attr swap': '-/* a */ <div className="a">\n+/* a */ <div className="b">',
  'moved line': '-<Badge />\n-<Title />\n+<Title />\n+<Badge />',
  'operator in braces': '-{items.length > 0 && x < 3 && <List/>}\n+{items.length > 9 || x < 3 && <List/>}',
  'arrow comparison': '-f(x => x.score < 50)\n+f(x => x.n !== 2 || x.score < 50)',
  'tailwind line': '-  px-4 py-2 bg-red-500\n+  px-8 hidden bg-blue-500',
  'boolean props line': '+  priority fill',
  'continuation': '-  * 2\n+  * 3',
  'added code line': '+  <Banner />',
};
for (const [name, body] of Object.entries(visual)) {
  test(`bypass stays gated: ${name}`, () => assert.equal(isTextOnlyDiff(hunk(body)), false));
}
test('prose moved between blocks is still text-only', () => {
  assert.equal(isTextOnlyDiff(hunk('-  Old copy here.\n+  New copy here.')), true);
});

test('filterFiles keeps non-src and non-text-only files, drops copy-only ones', async () => {
  const { filterFiles } = createRequire(import.meta.url)('./visual-text-only-diff.js');
  const patches = {
    'src/a.tsx': hunk('-<p>Old words</p>\n+<p>New words here</p>'),
    'src/b.tsx': hunk('-<p className="a">Hi</p>\n+<p className="b">Hi</p>'),
  };
  const run = (_r, f) => { if (!patches[f]) throw new Error('boom'); return patches[f]; };
  assert.deepEqual(filterFiles('r', ['src/a.tsx', 'src/b.tsx', 'src/c.tsx', 'src/x.css'], run), ['src/b.tsx', 'src/c.tsx', 'src/x.css']);
});
