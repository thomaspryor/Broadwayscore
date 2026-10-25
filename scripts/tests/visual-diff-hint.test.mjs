// BRO-5844: diff-aware pre-push visual gate. Requires the REAL functions
// (CLAUDE.md §15); parity test parses the Python regex out of verify-edits.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISUAL_DIFF_HINT_RE, patchTouchesVisualSurface, stripStringLiterals } from '../lib/ui-paths.mjs';
import { dropNonVisualFiles } from '../lib/review-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

test('JS VISUAL_DIFF_HINT_RE is a copy of the Python regex in verify-edits.sh', () => {
  const src = readFileSync(join(root, '.claude/hooks/verify-edits.sh'), 'utf8');
  const m = src.match(/VISUAL_DIFF_HINT_RE = _ui_re\.compile\(([\s\S]*?)\n\s*_ui_re\.IGNORECASE/);
  assert.ok(m, 'Python VISUAL_DIFF_HINT_RE not found');
  const pieces = [...m[1].matchAll(/r'((?:[^'\\]|\\.)*)'/g)].map(x => x[1]);
  const norm = s => s.replace(/\\\\/g, '\\').replace(/\\\//g, '/');
  assert.equal(norm(pieces.join('')), norm(VISUAL_DIFF_HINT_RE.source));
});

const hunk = (body, ctx = '') => `diff --git a/src/app/x/page.tsx b/src/app/x/page.tsx\n--- a/src/app/x/page.tsx\n+++ b/src/app/x/page.tsx\n@@ -1,5 +1,5 @@\n${ctx}${body}\n`;

test('metadata string edit is non-visual', () => {
  assert.equal(patchTouchesVisualSurface(hunk("-  description: 'Old copy',\n+  description: 'New copy',", " export const metadata = {\n")), false);
});
test('JSX / className edits are visual', () => {
  assert.equal(patchTouchesVisualSurface(hunk('-<div className="a">\n+<div className="b">')), true);
  assert.equal(patchTouchesVisualSurface(hunk('+<Foo x={1} />')), true);
});
test('multi-line className string (IngestForm style) stays visual', () => {
  const p = hunk("-    'px-3 py-1.5 rounded-md',\n+    'px-4 py-1.5 rounded-md',", " className={[\n");
  assert.equal(patchTouchesVisualSurface(p), true);
});
test('string containing JSX text does not trip the regex', () => {
  assert.equal(stripStringLiterals(`x: '<div className="a"/>'`).includes('className'), false);
  assert.equal(patchTouchesVisualSurface(hunk(`+  text: '<div className="a"/>',`, ' const d = {\n')), false);
});
test('new or deleted file is visual even with no JSX', () => {
  const add = `diff --git a/src/app/n/page.tsx b/src/app/n/page.tsx\nnew file mode 100644\n--- /dev/null\n+++ b/src/app/n/page.tsx\n@@ -0,0 +1 @@\n+export default 1\n`;
  assert.equal(patchTouchesVisualSurface(add), true);
  assert.equal(patchTouchesVisualSurface(add.replace('new file', 'deleted file')), true);
});

test('review repros (ship-check BRO-5844) all stay gated', () => {
  // apostrophes in JSX text must not pair across lines and hide a component
  assert.equal(patchTouchesVisualSurface(hunk("+  We can't wait\n+  <Badge tone=\"x\" />\n+  It's here")), true);
  assert.equal(patchTouchesVisualSurface(hunk("+  // don't\n+  <Badge />")), true);
  // Tailwind inside a multi-line template literal (changed line has no quote)
  assert.equal(patchTouchesVisualSurface(hunk("-  px-3 py-2\n+  px-4 py-2", " <div className={`\n")), true);
  assert.equal(patchTouchesVisualSurface(hunk("-px-3 py-2 rounded\n+px-6 py-4 rounded")), true);
  // class string in a helper const outside the context window
  assert.equal(patchTouchesVisualSurface(hunk("-const BTN = 'px-3 py-2 rounded';\n+const BTN = 'px-6 py-4 rounded';")), true);
  // render-logic edits
  assert.equal(patchTouchesVisualSurface(hunk('-  return content;\n+  return null;')), true);
  assert.equal(patchTouchesVisualSurface(hunk('-{items.map(i => i)}\n+{null}')), true);
});

test('plain copy edits still skip (owner decision)', () => {
  assert.equal(patchTouchesVisualSurface(hunk("-  title: 'Tony Nominations Center: Broadway Scorecard',\n+  title: 'Tony Nominations Center | Broadway Scorecard',")), false);
  assert.equal(patchTouchesVisualSurface(hunk('-  {AUTHOR.name} \u2013 {AUTHOR.jobTitle}\n+  {AUTHOR.name}, {AUTHOR.jobTitle}')), false);
  assert.equal(patchTouchesVisualSurface(hunk('-  I&apos;m Tom. I built it\n+  I&apos;m Tom, and I built it')), false);
});

test('fail-safe: empty / mode-only / non-string patches are visual', () => {
  assert.equal(patchTouchesVisualSurface(''), true);
  assert.equal(patchTouchesVisualSurface('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n'), true);
  assert.equal(patchTouchesVisualSurface(undefined), true);
});

function repoWith(files) {
  const d = mkdtempSync(join(tmpdir(), 'vdh-'));
  const run = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  for (const [p, c] of Object.entries(files.base)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); }
  run('add', '-A'); run('commit', '-qm', 'base');
  run('update-ref', 'refs/remotes/origin/main', 'HEAD');
  run('checkout', '-q', '-b', 'work');
  for (const [p, c] of Object.entries(files.head)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); }
  run('add', '-A'); run('commit', '-qm', 'head');
  return d;
}

test('dropNonVisualFiles end-to-end: keeps visual file even when listed last of six', () => {
  const base = {}, head = {};
  const names = ['a', 'b', 'c', 'd', 'e'].map(n => `src/app/${n}/page.tsx`);
  for (const n of names) { base[n] = "export const m = { description: 'one' };\n"; head[n] = "export const m = { description: 'two' };\n"; }
  base['src/app/z/page.tsx'] = 'export default () => <div className="a">x</div>;\n';
  head['src/app/z/page.tsx'] = 'export default () => <div className="b">x</div>;\n';
  base['src/app/c.css'] = 'a{}\n'; head['src/app/c.css'] = 'a{color:red}\n';
  base['src/lib/k.ts'] = '1\n'; head['src/lib/k.ts'] = '2\n';
  const d = repoWith({ base, head });
  const listed = [...names, 'src/app/z/page.tsx', 'src/app/c.css', 'src/lib/k.ts'];
  const kept = dropNonVisualFiles(d, 'origin/main', 'HEAD', listed);
  assert.deepEqual(kept, ['src/app/z/page.tsx', 'src/app/c.css', 'src/lib/k.ts']);
});

test('CLI --visual-only returns files and keeps all when git range fails', () => {
  const d = repoWith({ base: { 'src/app/p/page.tsx': "const a = 'x';\n" }, head: { 'src/app/p/page.tsx': "const a = 'y';\n" } });
  const out = JSON.parse(execFileSync('node', [join(root, 'scripts/lib/review-gate.mjs'), '--query=changed-files', `--repo=${d}`, '--ref=HEAD', '--pattern=^src/app/.*\\.tsx$', '--visual-only=1'], { encoding: 'utf8' }));
  assert.deepEqual(out.files, []);
  const out2 = JSON.parse(execFileSync('node', [join(root, 'scripts/lib/review-gate.mjs'), '--query=changed-files', `--repo=${d}`, '--ref=HEAD', '--pattern=^src/app/.*\\.tsx$'], { encoding: 'utf8' }));
  assert.deepEqual(out2.files, ['src/app/p/page.tsx']);
});
