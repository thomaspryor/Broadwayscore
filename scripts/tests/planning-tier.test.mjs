// BRO-6249: three-tier planning rule. require()s the real decision functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pt = require('../lib/planning-tier.js');
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'planning-tier-hook.js');

const base = { isNewFile: true, dirIsNew: true, newFilesInDir: 1, content: '', knownSecrets: new Set() };

test('4th new file in a new directory is substantial; 2nd-3rd is moderate; 1st is simple', () => {
  assert.equal(pt.classify({ ...base, relPath: 'scripts/foo/a.js', newFilesInDir: 4 }).tier, 'substantial');
  assert.equal(pt.classify({ ...base, relPath: 'scripts/foo/a.js', newFilesInDir: 2 }).tier, 'moderate');
  assert.equal(pt.classify({ ...base, relPath: 'scripts/foo/a.js', newFilesInDir: 1 }).tier, 'simple');
});
test('existing directory, edits to existing files, tests, data and docs stay simple', () => {
  assert.equal(pt.classify({ ...base, relPath: 'scripts/foo/a.js', newFilesInDir: 9, dirIsNew: false }).tier, 'simple');
  assert.equal(pt.classify({ ...base, relPath: 'scripts/foo/a.js', newFilesInDir: 9, isNewFile: false }).tier, 'simple');
  assert.equal(pt.classify({ ...base, relPath: 'scripts/foo/a.test.mjs', newFilesInDir: 9 }).tier, 'simple');
  assert.equal(pt.classify({ ...base, relPath: 'data/x/a.json', newFilesInDir: 9 }).tier, 'simple');
  assert.equal(pt.classify({ ...base, relPath: 'docs/x/a.md', newFilesInDir: 9 }).tier, 'simple');
});
test('new workflow is substantial', () => {
  const r = pt.classify({ ...base, relPath: '.github/workflows/new.yml', dirIsNew: false });
  assert.equal(r.tier, 'substantial');
});
test('new secret is substantial; known secret and GITHUB_TOKEN are not', () => {
  const content = 'env:\n  K: ${{ secrets.BRAND_NEW_KEY }}\n  T: ${{ secrets.GITHUB_TOKEN }}';
  assert.equal(pt.classify({ ...base, relPath: 'scripts/a.js', dirIsNew: false, content }).tier, 'substantial');
  assert.equal(pt.classify({ ...base, relPath: 'scripts/a.js', dirIsNew: false, content, knownSecrets: new Set(['BRAND_NEW_KEY']) }).tier, 'simple');
});
test('decide: warns before the enforce date, blocks after, moderate never blocks', () => {
  const sub = { tier: 'substantial', triggers: ['x'] };
  const before = pt.ENFORCE_AFTER_MS - 1000, after = pt.ENFORCE_AFTER_MS + 1000;
  assert.equal(pt.decide({ ...sub, now: before }).action, 'warn');
  assert.equal(pt.decide({ ...sub, now: after }).action, 'block');
  assert.equal(pt.decide({ ...sub, now: after, approved: true }).action, 'allow');
  assert.equal(pt.decide({ ...sub, now: after, mode: 'off' }).action, 'allow');
  assert.equal(pt.decide({ tier: 'moderate', triggers: ['x'], now: after }).action, 'warn');
});
test('isApproved: fresh plan verdict for this session, or owner token; other session does not count', () => {
  const now = Date.now();
  const v = { phase: 'plan', result: 'pass', sessionId: 's1', ts: new Date(now - 1000).toISOString() };
  assert.equal(pt.isApproved({ verdicts: [v], sessionId: 's1', now }).ok, true);
  assert.equal(pt.isApproved({ verdicts: [v], sessionId: 's2', now }).ok, false);
  assert.equal(pt.isApproved({ transcriptText: 'OWNER-PLAN-APPROVED: "yes build it"' }).ok, true);
  assert.equal(pt.isApproved({ transcriptText: 'OWNER-PLAN-APPROVED:' }).ok, false);
});

test('hook driver end to end: 4th file in a new dir warns; garbage input fails open', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ptier-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'scripts/newsys'), { recursive: true });
  for (const f of ['a', 'b', 'c']) fs.writeFileSync(path.join(repo, `scripts/newsys/${f}.js`), '');
  const run = (stdin) => spawnSync('node', [HOOK], { input: stdin, cwd: repo, encoding: 'utf8', env: { ...process.env, PLANNING_TIER_MODE: 'warn' } });
  const r = run(JSON.stringify({ tool_name: 'Write', session_id: 'zz', tool_input: { file_path: path.join(repo, 'scripts/newsys/d.js'), content: 'x' } }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SUBSTANTIAL/);
  const second = run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(repo, 'scripts/newsys/a.js'), content: 'x' } }));
  assert.equal(second.stdout, '');
  assert.equal(run('not json').status, 0);
});

test('prevention: planning commands cite only CLAUDE.md sections that exist', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const md = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  const have = new Set([...md.matchAll(/^### (\d+)\./gm)].map((m) => m[1]));
  for (const f of ['right-problem.md', 'plan-review.md']) {
    const t = fs.readFileSync(path.join(root, '.claude/commands', f), 'utf8');
    for (const m of t.matchAll(/CLAUDE\.md §(\d+)/g)) assert.ok(have.has(m[1]), `${f} cites missing CLAUDE.md §${m[1]}`);
    assert.doesNotMatch(t, /CLAUDE\.md §10 >1 day/);
  }
  assert.ok(have.has('20'));
});
