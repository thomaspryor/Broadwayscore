// BRO-2969: test.yml's on.push.paths covers every top-level colocated test
// with one 'scripts/*.test.mjs' glob. Before it, each top-level test needed its
// own hand-written entry and forgetting one meant a solo push touching that
// test triggered zero CI (#1737, #1745, BRO-2603, BRO-2647). This keeps the
// glob in place and stops new literal per-test entries.
//
// MAX_REDUNDANT_LITERALS was a ratchet while the ~180 literal entries that
// predated the glob were removed in region batches (one big deletion never
// rebased cleanly onto a busy test.yml). All are gone; it stays at 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { readPushPathsFrom, globToRegExp, isCovered } = require(join(ROOT, 'scripts/lib/test-yml-push-paths.js'));

const GLOB = 'scripts/*.test.mjs';
const MAX_REDUNDANT_LITERALS = 0;
const paths = readPushPathsFrom(join(ROOT, '.github/workflows/test.yml'));

test('on.push.paths carries the scripts/*.test.mjs glob', () => {
  assert.ok(paths.includes(GLOB), `'${GLOB}' is missing from test.yml on.push.paths`);
});

test('no NEW literal top-level scripts/<name>.test.mjs entry (the glob covers it)', () => {
  const re = globToRegExp(GLOB);
  const literals = [...new Set(paths.filter((p) => p !== GLOB && !p.includes('*') && re.test(p)))];
  assert.ok(
    literals.length <= MAX_REDUNDANT_LITERALS,
    `${literals.length} literal top-level test entries (cap ${MAX_REDUNDANT_LITERALS}). '${GLOB}' already ` +
      'covers them: do not add a scripts/<name>.test.mjs entry, only the sibling scripts/<name>.js one.',
  );
});

test('the glob triggers on top-level tests only', () => {
  assert.equal(isCovered('scripts/some-new-thing.test.mjs', paths), true);
  // '*' must not cross '/': scripts/tests/ has its own scripts/tests/** glob (BRO-5309).
  assert.equal(globToRegExp(GLOB).test('scripts/tests/some-new-thing.test.mjs'), false);
  // Top-level sources are not globbed and still need their own entries.
  assert.equal(globToRegExp(GLOB).test('scripts/some-new-thing.js'), false);
});
