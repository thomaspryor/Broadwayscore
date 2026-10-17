import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findLongLines, MAX_LINE_LENGTH } = require('../../scripts/lib/workflow-line-length.js');

const workflowsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.github',
  'workflows'
);

test(`no .github/workflows/*.yml line exceeds ${MAX_LINE_LENGTH} chars`, () => {
  const violations = findLongLines(workflowsDir);
  assert.deepEqual(
    violations,
    [],
    `Long lines found (task #763 class — append-growing space-separated lists guarantee merge conflicts; ` +
      `use a manifest file + xargs instead, or add "# workflow-line-length-ok: <reason>" if this is a genuine ` +
      `one-off long line): ${JSON.stringify(violations)}`
  );
});
