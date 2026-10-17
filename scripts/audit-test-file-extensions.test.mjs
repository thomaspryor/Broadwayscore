import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { auditTestFileExtensions } = require('./lib/audit-test-file-extensions.js');
const { MANIFESTS } = require('./lib/test-manifest.js');
const { collectNodeUnitTests } = require('./lib/unit-test-collection.js');
const { SAFE_CHECK_FORMS } = require('./lib/autonomous-triage-core.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t, entries) {
  const dir = fs.mkdtempSync(path.join(root, '.test-extensions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tests'));
  MANIFESTS.forEach((manifest, i) => {
    fs.writeFileSync(path.join(dir, manifest), `${entries[i] || '# empty fixture'}\n`);
  });
  return dir;
}

test('real manifests and active collector are covered by the real safe-command gate', () => {
  const result = auditTestFileExtensions(root);
  assert.equal(result.ok, true, JSON.stringify(result.unsupported, null, 2));
  assert.equal(result.sources.length, MANIFESTS.length + 1);
  assert.ok(result.sources.every(source => source.records > 0));
});

test('acceptance test is automatically collected by CI and land', () => {
  assert.ok(collectNodeUnitTests(root).includes('scripts/audit-test-file-extensions.test.mjs'));
});

test('CLI audits the real repo successfully', () => {
  const run = spawnSync(process.execPath, ['scripts/lib/audit-test-file-extensions.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /PASS: SAFE_CHECK_FORMS covers/);
});

test('covered conventions, whitespace, comments and duplicates', t => {
  const dir = fixture(t, [
    '# ignored.test.cjs\n  tests/unit/a.test.js  \n\ntests/unit/a.test.js',
    'tests/unit/b.test.ts',
    'tests/unit/c.test.mjs',
  ]);
  const result = auditTestFileExtensions(dir);
  assert.equal(result.ok, true);
  assert.deepEqual(result.extensions.map(item => item.extension), ['.js', '.mjs', '.ts']);
  assert.equal(result.extensions[0].examples.length, 1);
});

for (const [index, manifest] of MANIFESTS.entries()) {
  test(`an unsupported convention fails loudly in ${manifest}`, t => {
    const entries = MANIFESTS.map(() => 'tests/unit/covered.test.mjs');
    entries[index] = 'tests/unit/new-convention.test.cjs';
    const result = auditTestFileExtensions(fixture(t, entries));
    assert.equal(result.ok, false);
    assert.deepEqual(result.unsupported, [{
      extension: '.cjs', supported: false,
      examples: [{ source: manifest, file: 'tests/unit/new-convention.test.cjs' }],
    }]);
  });
}

test('collector conventions are audited even when absent from the retired manifest', t => {
  const dir = fixture(t, MANIFESTS.map(() => 'tests/unit/covered.test.mjs'));
  fs.mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts/lib/unit-test-collection.js'),
    "module.exports = { collectNodeUnitTests: () => ['tests/unit/new-convention.test.cjs'] };\n");
  const result = auditTestFileExtensions(dir);
  assert.equal(result.ok, false);
  assert.equal(result.unsupported[0].examples[0].source, 'collected node batch');
});

test('missing manifests fail closed', t => {
  const dir = fixture(t, []);
  fs.unlinkSync(path.join(dir, MANIFESTS[1]));
  assert.throws(() => auditTestFileExtensions(dir), { code: 'ENOENT' });
});

test('locally reverting BRO-2218 makes the audit fail on real TS manifest entries', () => {
  const form = SAFE_CHECK_FORMS.find(item => item.re.test('npx tsx --test tests/unit/example.test.ts'));
  assert.ok(form);
  const widened = form.re;
  try {
    // Mutate the exported real form, so the real isSafeCheckCommand sees the
    // pre-BRO-2218 policy. Restore it before any other test can run.
    form.re = new RegExp(widened.source.replace('(?:m?js|ts)', 'm?js'), widened.flags);
    const result = auditTestFileExtensions(root);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unsupported.map(item => item.extension), ['.ts']);
    assert.deepEqual(result.unsupported[0].examples.map(item => item.source), MANIFESTS.slice(1));
  } finally {
    form.re = widened;
  }
  assert.equal(auditTestFileExtensions(root).ok, true);
});
