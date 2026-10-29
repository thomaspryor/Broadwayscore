// BRO-3073: every scripts/config/*.json must be reachable by test.yml's on.push.paths,
// otherwise a solo edit to it triggers zero CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readPushPathsFrom, isCovered } = require('../../scripts/lib/test-yml-push-paths.js');

const root = path.resolve(import.meta.dirname, '../..');
const files = fs.readdirSync(path.join(root, 'scripts/config')).filter((f) => f.endsWith('.json'));
const entries = readPushPathsFrom(path.join(root, '.github/workflows/test.yml'));

test('scripts/config has json files to check', () => {
  assert.ok(files.length > 0);
});

for (const f of files) {
  test(`test.yml push paths cover scripts/config/${f}`, () => {
    assert.equal(isCovered(`scripts/config/${f}`, entries), true);
  });
}
