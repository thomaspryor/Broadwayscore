// BRO-6941: a stale writer's rewrite of a file another writer deleted must not
// resurrect it. Requires the real resolver (scripts/lib/resolve-modify-delete.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveModifyDelete } = require('../../scripts/lib/resolve-modify-delete.js');
const rev = (o) => JSON.stringify({ outlet: 'x', ...o });

test('stale rewrite with same fullText keeps the deletion', () => {
  const base = rev({ fullText: 'Long review body.', rejectedBy: null });
  const ours = rev({ fullText: 'Long review body.', rejectedBy: 'ensemble-scoreability-check' });
  assert.equal(resolveModifyDelete({ baseRaw: base, oursRaw: ours }), 'delete');
});

test('real fullText change keeps the workflow copy', () => {
  const base = rev({ fullText: 'short' });
  const ours = rev({ fullText: 'a much longer re-fetched body' });
  assert.equal(resolveModifyDelete({ baseRaw: base, oursRaw: ours }), 'keep');
});

test('empty or invalid workflow copy is deleted', () => {
  const base = rev({ fullText: 'body' });
  assert.equal(resolveModifyDelete({ baseRaw: base, oursRaw: rev({ fullText: '' }) }), 'delete');
  assert.equal(resolveModifyDelete({ baseRaw: base, oursRaw: '{not json' }), 'delete');
  assert.equal(resolveModifyDelete({ baseRaw: base, oursRaw: null }), 'delete');
});

test('missing base with real text keeps workflow copy', () => {
  assert.equal(resolveModifyDelete({ baseRaw: null, oursRaw: rev({ fullText: 'new' }) }), 'keep');
});

// ---- End-to-end: the real action script against a local bare origin ----
const yaml = require('js-yaml');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const action = yaml.load(fs.readFileSync(path.join(ROOT, '.github/actions/push-review-texts/action.yml'), 'utf8'));
const SCRIPT = action.runs.steps.find((s) => s.id === 'push').run.split('\n').filter((l) => !l.includes('opening-night-lease.js')).join('\n');
const TOKEN = 'test-token';
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX)$/.test(k)));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: CLEAN_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('e2e: stale writer rewriting a file upstream deleted does not resurrect it', { timeout: 180000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-rt-resolve-'));
  try {
    const origin = path.join(tmp, 'origin.git');
    const ws = path.join(tmp, 'ws');
    const rt = path.join(ws, 'data', 'review-texts');
    fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(ws, 'scripts'));
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(tmp, 'seed');
    git(tmp, 'clone', '-q', origin, seed);
    git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
    const dir = path.join(seed, 'show-a');
    fs.mkdirSync(dir);
    const body = (o) => JSON.stringify({ outlet: 'o', criticName: 'c', fullText: 'Same review body text.', ...o }, null, 2) + '\n';
    fs.writeFileSync(path.join(dir, 'doomed.json'), body({ rejectedBy: null }));
    fs.writeFileSync(path.join(dir, 'real-change.json'), body({}));
    fs.writeFileSync(path.join(dir, 'other.json'), body({ n: 1 }));
    git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'base'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
    git(tmp, 'clone', '-q', '--depth', '1', '--branch', 'main', `file://${origin}`, rt);
    git(rt, 'config', 'user.email', 't@t'); git(rt, 'config', 'user.name', 't');

    // Writer A (fix plan) deletes both files and pushes.
    git(seed, 'rm', '-q', 'show-a/doomed.json', 'show-a/real-change.json');
    git(seed, 'commit', '-qm', 'approved fix: delete'); git(seed, 'push', '-q', 'origin', 'HEAD:main');

    // Stale writer B rewrites them from its pre-delete checkout.
    const d = path.join(rt, 'show-a');
    fs.writeFileSync(path.join(d, 'doomed.json'), body({ rejectedBy: 'ensemble-scoreability-check' }));
    fs.writeFileSync(path.join(d, 'real-change.json'), body({ fullText: 'A genuinely re-fetched, different body.' }));
    fs.writeFileSync(path.join(d, 'other.json'), body({ n: 2 }));

    const out = path.join(tmp, 'gh-output');
    fs.writeFileSync(out, '');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', SCRIPT], {
      cwd: rt, encoding: 'utf8', timeout: 170000,
      env: {
        ...CLEAN_ENV, GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: out, REVIEW_TEXTS_TOKEN: TOKEN, COMMIT_MSG: 'data: stale rewrite',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
        GIT_CONFIG_VALUE_0: `https://x-access-token:${TOKEN}@github.com/thomaspryor/broadway-review-texts.git`,
      },
    });
    assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-3000));
    const tree = git(origin, 'ls-tree', '-r', '--name-only', 'main');
    assert.doesNotMatch(tree, /show-a\/doomed\.json/, 'stale rewrite must not resurrect the deleted file');
    assert.match(tree, /show-a\/real-change\.json/, 'a real content change is kept');
    assert.match(tree, /show-a\/other\.json/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
