// Runs the REAL audit script against a throwaway tree (script resolves its
// repo root from __dirname) so detection, the per-occurrence marker, the
// baseline diff and --strict exit codes are exercised end to end (BRO-2183).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = 'audit-broadway-category-predicate.js';

function makeTree(files, baselineHits = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bcp-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'audit'), { recursive: true });
  for (const f of [SCRIPT, 'lib/cli-help.js', 'lib/broadway-category-predicate-baseline.js']) {
    fs.copyFileSync(path.join(HERE, f), path.join(root, 'scripts', f));
  }
  fs.writeFileSync(
    path.join(root, 'data/audit/broadway-category-predicate-baseline.json'),
    JSON.stringify({ hits: baselineHits }),
  );
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const run = (root, ...a) => spawnSync('node', [path.join(root, 'scripts', SCRIPT), ...a], { encoding: 'utf8' });

test('new raw literal fails --strict, default mode stays advisory', () => {
  const root = makeTree({ 'scripts/foo.js': "const b = shows.filter(s => s.category === 'broadway');\n" });
  assert.equal(run(root, '--strict').status, 1);
  assert.equal(run(root).status, 0);
});

test('reversed operand order is caught', () => {
  const root = makeTree({ 'scripts/foo.js': "if ('broadway' == show.category) x();\n" });
  assert.equal(run(root, '--strict').status, 1);
});

test('baselined hit passes --strict; a different hit in same file fails', () => {
  const line = "const b = s.category === 'broadway';";
  const base = [{ file: 'scripts/foo.js', snippet: line }];
  assert.equal(run(makeTree({ 'scripts/foo.js': line + '\n' }, base), '--strict').status, 0);
  const swapped = makeTree({ 'scripts/foo.js': "const c = t.category === 'broadway';\n" }, base);
  assert.equal(run(swapped, '--strict').status, 1);
});

test('marker exempts only its own occurrence; comments and allowlist ignored', () => {
  const ok = makeTree({
    'scripts/a.js': "// Intentionally NOT isBroadwayCategory: strict form needed\nconst x = s.category === 'broadway';\n",
    'scripts/b.js': "// category === 'broadway' mentioned in prose\n * category === 'broadway'\n",
    'scripts/lib/venue-classification.js': "return category === 'broadway';\n",
  });
  assert.equal(run(ok, '--strict').status, 0);
  const far = "// Intentionally NOT isBroadwayCategory\n" + '\n'.repeat(10) + "const y = s.category === 'broadway';\n";
  assert.equal(run(makeTree({ 'scripts/a.js': far }), '--strict').status, 1);
});

test('real repo: no new un-baselined violations', () => {
  const r = spawnSync('node', [path.join(HERE, SCRIPT), '--strict'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
});
