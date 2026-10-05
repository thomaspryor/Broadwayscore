import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lib = require('./audit-blanket-sweep-audit-writes.js');

const wf = (extra = '') => `
name: t
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Poll
        continue-on-error: true
        run: |
          node scripts/fake-writer.js
          ${extra}
      - name: Commit
        run: |
          bash scripts/lib/stage-data-changes.sh
          bash scripts/lib/push-with-retry.sh
`;
const SRC = `const P = path.join(__dirname, '..', 'data', 'audit', 'totally-unregistered-xyz.json');
fs.writeFileSync(P, '{}');
const D = path.join(__dirname, '../data/audit');
fs.writeFileSync(path.join(D, 'also-unregistered-xyz.json'), '{}');
fs.writeFileSync('data/audit/health-digest-snapshot.json', '{}');
console.log('see data/audit/mention-only-xyz.json');`;
const opts = { readSrc: () => SRC, isIgnored: () => false };

test('flags unregistered audit writes from an invoked script before a blanket sweep (BRO-2795 shape)', () => {
  const f = lib.auditBlanketSweeps(wf(), 'x.yml', opts);
  assert.deepEqual(f.map((x) => x.path).sort(), ['data/audit/also-unregistered-xyz.json', 'data/audit/totally-unregistered-xyz.json']);
  assert.ok(f.every((x) => x.continueOnError));
});

test('mention-only paths and registered apiFallbackSafe paths are not flagged', () => {
  const paths = lib.auditBlanketSweeps(wf(), 'x.yml', opts).map((x) => x.path);
  assert.ok(!paths.includes('data/audit/mention-only-xyz.json'));
  assert.ok(!paths.includes('data/audit/health-digest-snapshot.json'));
});

test('inline redirect writes are flagged; exemption comment and gitignore suppress', () => {
  const inline = wf('echo {} > data/audit/inline-unreg-xyz.json');
  assert.ok(lib.auditBlanketSweeps(inline, 'x.yml', opts).some((x) => x.path === 'data/audit/inline-unreg-xyz.json'));
  const ex = wf('# blanket-sweep-audit-ok: data/audit/inline-unreg-xyz.json scratch\n          echo {} > data/audit/inline-unreg-xyz.json');
  assert.ok(!lib.auditBlanketSweeps(ex, 'x.yml', opts).some((x) => x.path === 'data/audit/inline-unreg-xyz.json'));
  assert.deepEqual(lib.auditBlanketSweeps(wf(), 'x.yml', { ...opts, isIgnored: () => true }), []);
});

test('no blanket sweep (explicit paths) => nothing flagged', () => {
  const t = wf().replace('stage-data-changes.sh\n', 'stage-data-changes.sh data/audit/foo.json\n');
  assert.deepEqual(lib.auditBlanketSweeps(t, 'x.yml', opts), []);
});

test('live repo: no finding outside the shrink-only baseline, no stale baseline entry', () => {
  const found = lib.auditAllWorkflows().map((f) => `${f.file}|${f.path}`);
  assert.deepEqual(found.filter((k) => !lib.BASELINE.has(k)), []);
  assert.deepEqual([...lib.BASELINE].filter((k) => !found.includes(k)), []);
});
