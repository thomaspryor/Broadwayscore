import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseManifest, stripSelfSkip, compareManifest, buildAlert } = require('./lib/cloud-parity.js');
const { run } = require('./check-cloud-parity.js');

const MANIFEST = { pairs: [
  { name: 'commands', repoDir: 'r/cmd', globalDir: 'cmd', pattern: '*.md', mode: 'exact' },
  { name: 'hooks', repoDir: 'r/hooks', globalDir: 'hooks', pattern: '*.sh', mode: 'strip-self-skip' },
] };

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

test('parseManifest validates shape', () => {
  assert.throws(() => parseManifest('nope'), /not valid JSON/);
  assert.throws(() => parseManifest('{"pairs":[]}'), /non-empty/);
  assert.throws(() => parseManifest('{"pairs":[{"name":"x","repoDir":"a","globalDir":"b","pattern":"md"}]}'), /pattern/);
  assert.throws(() => parseManifest('{"pairs":[{"name":"x","repoDir":"a","globalDir":"b","pattern":"*.md","mode":"zzz"}]}'), /mode/);
  assert.equal(parseManifest(JSON.stringify(MANIFEST)).pairs[0].mode, 'exact');
  const real = parseManifest(fs.readFileSync(new URL('../.claude/cloud-parity.json', import.meta.url), 'utf8'));
  assert.ok(real.pairs.length >= 2);
});

test('stripSelfSkip drops the guard block only', () => {
  assert.equal(stripSelfSkip('a\n# Self-skip x\nif y\nfi\nb'), 'a\nb');
  assert.equal(stripSelfSkip('a\nb'), 'a\nb');
});

test('compareManifest finds drift, tolerates self-skip, flags repo-only files as unverified', () => {
  const root = fixture({
    'r/cmd/same.md': 'x', 'r/cmd/diff.md': 'repo', 'r/cmd/only.md': 'o',
    'r/hooks/h.sh': 'a\n# Self-skip\nif z\nfi\nb',
    'h/cmd/same.md': 'x', 'h/cmd/diff.md': 'master', 'h/hooks/h.sh': 'a\nb',
  });
  const r = compareManifest(MANIFEST, { repoRoot: root, claudeHome: path.join(root, 'h') });
  assert.deepEqual(r.drifted, ['r/cmd/diff.md']);
  assert.deepEqual(r.missingGlobal, ['r/cmd/only.md']);
  assert.equal(r.compared, 3);
  assert.equal(r.checkable, true);
});

test('no masters (cloud) is not drift', () => {
  const root = fixture({ 'r/cmd/a.md': 'x' });
  const r = compareManifest(MANIFEST, { repoRoot: root, claudeHome: path.join(root, 'absent') });
  assert.equal(r.checkable, false);
  assert.deepEqual(r.drifted, []);
});

test('run routes one alert on drift and none when clean or quiet', async () => {
  const root = fixture({ 'r/cmd/d.md': 'repo', 'h/cmd/d.md': 'master', 'm.json': JSON.stringify(MANIFEST) });
  const alerts = [];
  const opts = { repoRoot: root, claudeHome: path.join(root, 'h'), manifestPath: path.join(root, 'm.json'), alert: async (a) => alerts.push(a), log: () => {} };
  assert.equal((await run(opts)).exitCode, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].conditionKey, 'cloud-parity-drift');
  assert.equal(alerts[0].disposition, 'digest');
  assert.match(alerts[0].description, /r\/cmd\/d\.md/);
  assert.equal((await run({ ...opts, quiet: true })).exitCode, 1);
  assert.equal(alerts.length, 1);
  fs.writeFileSync(path.join(root, 'h/cmd/d.md'), 'repo');
  assert.equal((await run(opts)).exitCode, 0);
  assert.equal(alerts.length, 1);
  const resolved = [];
  await run({ ...opts, resolve: async (k) => resolved.push(k) });
  assert.deepEqual(resolved, ['cloud-parity-drift']);
});

test('stripSelfSkip ignores mid-file comments and strips only the first block', () => {
  assert.equal(stripSelfSkip('a\n# see "# Self-skip" rule\nb\nfi\nc'), 'a\n# see "# Self-skip" rule\nb\nfi\nc');
  assert.equal(stripSelfSkip('# Self-skip\n  fi\nx\nfi\ny\n# Self-skip\nfi\nz'), 'y\n# Self-skip\nfi\nz');
  assert.equal(stripSelfSkip('a\n# Self-skip\nnever closed'), 'a');
});

test('buildAlert is accepted by the real router contract (required fields)', () => {
  const a = buildAlert({ drifted: ['x.md'] });
  assert.ok(a.conditionKey && a.title && ['auto', 'digest', 'human'].includes(a.disposition));
});
