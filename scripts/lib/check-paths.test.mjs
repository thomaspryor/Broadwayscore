import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

test('check-paths loads without filesystem reads or stats beyond loading its source', () => {
  const leaf = require.resolve('./check-paths.js');
  const result = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const read = fs.readFileSync;
    const leaf = ${JSON.stringify(leaf)};
    fs.readFileSync = function(file, ...args) {
      if (file !== leaf) throw new Error('Unexpected file read: ' + file);
      return read.call(this, file, ...args);
    };
    fs.statSync = () => { throw new Error('Unexpected filesystem stat'); };
    const { resolveCheckPaths } = require(leaf);
    if (typeof resolveCheckPaths !== 'function') throw new Error('Missing resolver');
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('triage keeps its compatibility exports pointing to the leaf implementation', () => {
  const leaf = require('./check-paths.js');
  const triage = require('./autonomous-triage-core.js');
  for (const name of Object.keys(leaf)) assert.equal(triage[name], leaf[name], name);
});

test('loading dispatch guards does not load autonomous triage', () => {
  const result = spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(require.resolve('./dispatch-guards.js'))});
    const triage = ${JSON.stringify(require.resolve('./autonomous-triage-core.js'))};
    if (require.cache[triage]) throw new Error('Dispatch loaded autonomous triage');
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

// BRO-5930
test('plain node --test on a .test.ts file stays refused (shape) but carries a verified tsx hint', () => {
  const { explainUnsafeCheckCommand } = require('./check-paths.js');
  const r = explainUnsafeCheckCommand('node --test --test-timeout 60 scripts/lib/x.test.ts');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'shape');
  assert.match(r.hint, /use: npx tsx --test --test-timeout 60 scripts\/lib\/x\.test\.ts$/);
  assert.equal(explainUnsafeCheckCommand('node --test scripts/lib/x.test.mjs').ok, true);
  assert.equal(explainUnsafeCheckCommand('node --test scripts/lib/x.test.ts.bak').hint, undefined);
});
