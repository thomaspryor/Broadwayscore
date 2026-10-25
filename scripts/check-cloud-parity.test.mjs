import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { GUARD_RE, parseManifest, stripSelfSkip, compareManifest, buildAlert } = require('./lib/cloud-parity.js');
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

const GUARD = 'if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then';

test('stripSelfSkip drops the guard block only', () => {
  assert.equal(stripSelfSkip(`a\n# Self-skip x\n${GUARD}\n  exit 0\nfi\nb`), 'a\nb');
  assert.equal(stripSelfSkip('a\nb'), 'a\nb');
});

test('compareManifest finds drift, tolerates self-skip, flags repo-only files as unverified', () => {
  const root = fixture({
    'r/cmd/same.md': 'x', 'r/cmd/diff.md': 'repo', 'r/cmd/only.md': 'o',
    'r/hooks/h.sh': `a\n# Self-skip\n${GUARD}\n  exit 0\nfi\nb`,
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

test('stripSelfSkip is anchored on the guard, not on the comment', () => {
  // A comment mentioning the marker, with no guard, is left alone.
  assert.equal(stripSelfSkip('a\n# see "# Self-skip" rule\nb\nfi\nc'), 'a\n# see "# Self-skip" rule\nb\nfi\nc');
  // One-line guard: nothing after it is eaten.
  assert.equal(stripSelfSkip(`# Self-skip\n${GUARD} exit 0; fi\nreal\nfi\nz`), 'real\nfi\nz');
  // Guard with no comment.
  assert.equal(stripSelfSkip(`a\n${GUARD}\n  exit 0\nfi\nb`), 'a\nb');
  // BASH_SOURCE form, named by file.
  const named = 'if [ -f "$HOME/.claude/hooks/x.sh" ] && \\\n   [ "${BASH_SOURCE[0]}" != "$HOME/.claude/hooks/x.sh" ]; then\n  exit 0\nfi';
  assert.equal(stripSelfSkip(`# Self-skip preamble\n${named}\nb`), 'b');
  // Code between the comment and the guard is kept (notion-create-block.sh).
  assert.equal(stripSelfSkip(`# Self-skip note\nhatch\n# end\n\n${GUARD}\n  exit 0\nfi\nb`), '# Self-skip note\nhatch\n# end\n\nb');
  // Unterminated guard and other hooks/ paths are not stripped.
  assert.equal(stripSelfSkip(`a\n${GUARD}\n  exit 0`), `a\n${GUARD}\n  exit 0`);
  const lib = 'if [ -f "$HOME/.claude/hooks/lib/x.js" ]; then\n  node x\nfi';
  assert.equal(stripSelfSkip(lib), lib);
});

// Every shipped hook: the guard is gone after normalizing, and every line
// removed is part of the guard or a comment/blank line. That second check is
// what catches a rule that quietly swallows real code.
test('every shipped hook loses its guard and nothing but its guard', () => {
  const dir = new URL('../.claude/hooks/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sh'));
  let guarded = 0;
  for (const f of files) {
    const text = fs.readFileSync(new URL(f, dir), 'utf8');
    const out = stripSelfSkip(text);
    assert.ok(!out.split('\n').some((l) => GUARD_RE.test(l)), `${f}: guard survived`);
    if (out === text) continue;
    guarded++;
    const kept = out.split('\n');
    const lines = text.split('\n');
    // The removal is one contiguous slice; find where it starts.
    let p = 0;
    while (p < kept.length && kept[p] === lines[p]) p++;
    const removed = lines.slice(p, p + (lines.length - kept.length));
    assert.deepEqual([...lines.slice(0, p), ...lines.slice(p + removed.length)], kept, `${f}: removal is not one slice`);
    for (const l of removed) {
      assert.match(l, /^(\s*(#.*)?|if \[ -f "\$HOME.*|\s+\[ "\$\{BASH_SOURCE.*|\s*exit 0|fi\s*)$/, `${f}: dropped a real line: ${l}`);
    }
  }
  assert.ok(guarded >= 14, `expected the guarded hooks, saw ${guarded}`);
});

test('buildAlert is accepted by the real router contract (required fields)', () => {
  const a = buildAlert({ drifted: ['x.md'] });
  assert.ok(a.conditionKey && a.title && ['auto', 'digest', 'human'].includes(a.disposition));
});
