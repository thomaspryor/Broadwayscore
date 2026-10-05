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
fs.writeFileSync(P, '{}'); // test-data-write-guard-allow: fixture text for the auditor under test, never executed
const D = path.join(__dirname, '../data/audit');
fs.writeFileSync(path.join(D, 'also-unregistered-xyz.json'), '{}'); // test-data-write-guard-allow: fixture text for the auditor under test, never executed
fs.writeFileSync('data/audit/health-digest-snapshot.json', '{}'); // test-data-write-guard-allow: fixture text for the auditor under test, never executed
console.log('see data/audit/mention-only-xyz.json');`;
const opts = { readSrc: () => SRC, isIgnored: () => false };

test('flags unregistered audit writes from an invoked script before a blanket sweep (BRO-2795 shape)', () => {
  const f = lib.auditBlanketSweeps(wf(), 'x.yml', opts);
  assert.ok(['also-unregistered-xyz', 'totally-unregistered-xyz'].every((n) => f.some((x) => x.path === `data/audit/${n}.json`)));
  assert.ok(f.every((x) => x.continueOnError));
});

test('registered apiFallbackSafe paths are not flagged; scripts with no write primitive are skipped', () => {
  const paths = lib.auditBlanketSweeps(wf(), 'x.yml', opts).map((x) => x.path);
  assert.deepEqual(lib.auditFilesWrittenBy("console.log('data/audit/only-mention-xyz.json')"), []);
  assert.ok(!paths.includes('data/audit/health-digest-snapshot.json'));
});

test('inline redirect writes are flagged; exemption comment and gitignore suppress', () => {
  const inline = wf('echo {} > data/audit/inline-unreg-xyz.json');
  assert.ok(lib.auditBlanketSweeps(inline, 'x.yml', opts).some((x) => x.path === 'data/audit/inline-unreg-xyz.json'));
  const ex = wf('# blanket-sweep-audit-ok: data/audit/inline-unreg-xyz.json scratch\n          echo {} > data/audit/inline-unreg-xyz.json');
  assert.ok(!lib.auditBlanketSweeps(ex, 'x.yml', opts).some((x) => x.path === 'data/audit/inline-unreg-xyz.json'));
  assert.deepEqual(lib.auditBlanketSweeps(wf(), 'x.yml', { ...opts, isIgnored: () => true }), []);
});

test('`data/` with other args is still a blanket sweep (fetch-all-image-formats shape); trailing comment ok', () => {
  const t = wf().replace('stage-data-changes.sh\n', 'stage-data-changes.sh data/ public/images/shows/ # imgs\n');
  assert.ok(lib.auditBlanketSweeps(t, 'x.yml', opts).length > 0);
});

test('catches writes via audit-dir variable, template strings and required libs', () => {
  const src = "const AUDIT_DIR = path.join(DATA_DIR, 'audit');\nconst P = path.join(AUDIT_DIR, 'viadir-xyz.json');\nwriteAuditArtifact(P, {});\nfs.writeFileSync(`${AUDIT_DIR}/tpl-xyz.json`, '');";
  assert.deepEqual(lib.auditFilesWrittenBy(src).sort(), ['data/audit/tpl-xyz.json', 'data/audit/viadir-xyz.json']);
  const files = { 'scripts/a.js': "const l = require('./lib/b');", 'scripts/lib/b.js': "fs.appendFileSync('data/audit/inlib-xyz.jsonl', 'x');" }; // test-data-write-guard-allow: fixture text for the auditor under test, never executed
  assert.deepEqual(lib.auditFilesWrittenByWithLibs('scripts/a.js', (r) => files[r] ?? null), ['data/audit/inlib-xyz.jsonl']);
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
