import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { findFlatGitAdds } = require('../../scripts/audit-flat-git-add.js');

test('flags flat multi-path, ignores single path, flags, comments', () => {
  const y = [
    '  git add a.json b.json',
    '  git add a.json',
    '  git add -f a.json',
    '  # git add x y',
    '  git add c.json d.json 2>/dev/null || true',
    '  git add e.json \\',
    '    f.json',
    '  git add data/ && git add g.json',
  ].join('\n');
  const r = findFlatGitAdds(y);
  assert.deepEqual(r.map(x => x.line), [1, 5, 6]);
  assert.equal(r[1].masked, true);
  assert.deepEqual(r[2].paths, ['e.json', 'f.json']);
});

test('CLI exits 0 on the real workflows (advisory)', () => {
  const r = spawnSync('node', [new URL('../../scripts/audit-flat-git-add.js', import.meta.url).pathname], { encoding: 'utf8', cwd: new URL('../..', import.meta.url).pathname });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[advisory\]/);
});

test('redirect targets are not paths', () => {
  assert.equal(findFlatGitAdds('git add a.json 2> /dev/null').length, 0);
});
