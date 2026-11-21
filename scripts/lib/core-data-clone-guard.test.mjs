// BRO-3337: setup-local-data.sh / cloud-bootstrap-data.sh must never
// `reset --hard` the shared core-data clone over another session's work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'core-data-clone-guard.sh');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });

function check(dir) {
  try {
    const out = execFileSync('bash', ['-c', `source "${GUARD}"; core_clone_local_work "$1"`, '_', dir], { encoding: 'utf8' });
    return { work: true, why: out.trim() };
  } catch (e) {
    return { work: false, why: String(e.stdout || '').trim() };
  }
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'cdcg-'));
  const src = path.join(root, 'src');
  execFileSync('git', ['init', '-q', '-b', 'main', src]);
  writeFileSync(path.join(src, 'shows.json'), '[]\n');
  git(src, 'add', '.'); git(src, 'commit', '-qm', 'one');
  writeFileSync(path.join(src, 'shows.json'), '[1]\n');
  git(src, 'commit', '-qam', 'two');
  const clone = path.join(root, 'clone');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${src}`, clone]);
  return { root, src, clone };
}

test('clean depth-1 clone on main: safe to reset', () => {
  const { root, clone } = setup();
  try { assert.equal(check(clone).work, false); } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('clean clone after upstream moved and fetched: still safe', () => {
  const { root, src, clone } = setup();
  try {
    writeFileSync(path.join(src, 'shows.json'), '[2]\n'); git(src, 'commit', '-qam', 'three');
    git(clone, 'fetch', '-q', '--depth', '1', 'origin', 'main');
    assert.equal(check(clone).work, false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('untracked file only: safe (reset keeps it)', () => {
  const { root, clone } = setup();
  try { writeFileSync(path.join(clone, 'scratch.txt'), 'x'); assert.equal(check(clone).work, false); } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('uncommitted tracked edit: refuse', () => {
  const { root, clone } = setup();
  try {
    writeFileSync(path.join(clone, 'shows.json'), '[9]\n');
    const r = check(clone);
    assert.equal(r.work, true); assert.match(r.why, /uncommitted/);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('committed but unpushed: refuse (the case the old guard missed)', () => {
  const { root, clone } = setup();
  try {
    writeFileSync(path.join(clone, 'shows.json'), '[9]\n'); git(clone, 'commit', '-qam', 'local');
    const r = check(clone);
    assert.equal(r.work, true); assert.match(r.why, /unpushed/);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('off main: refuse', () => {
  const { root, clone } = setup();
  try {
    git(clone, 'checkout', '-qb', 'feature');
    assert.match(check(clone).why, /not on main/);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('local commit on top of an old shallow tip after upstream moved: refuse', () => {
  const { root, src, clone } = setup();
  try {
    writeFileSync(path.join(clone, 'shows.json'), '[9]\n'); git(clone, 'commit', '-qam', 'local');
    writeFileSync(path.join(src, 'shows.json'), '[2]\n'); git(src, 'commit', '-qam', 'three');
    git(clone, 'fetch', '-q', '--depth', '1', 'origin', 'main');
    assert.match(check(clone).why, /1 local commit/);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('full (non-shallow) clone behind origin: safe', () => {
  const { root, src } = setup();
  const full = path.join(root, 'full');
  try {
    execFileSync('git', ['clone', '-q', `file://${src}`, full]);
    writeFileSync(path.join(src, 'shows.json'), '[2]\n'); git(src, 'commit', '-qam', 'three');
    git(full, 'fetch', '-q', 'origin', 'main');
    assert.equal(check(full).work, false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('every shell script that resets the shared clone sources this guard', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); } else if (n.endsWith('.sh')) files.push(p); } };
  walk(path.join(repo, 'scripts'));
  const offenders = files.filter((f) => {
    if (f === GUARD) return false;
    const s = readFileSync(f, 'utf8');
    const code = s.split('\n').filter((l) => !/^\s*#/.test(l) && !/\becho\b/.test(l)).join('\n');
    return /broadway-scorecard-data/.test(s) && /git\b.*\breset\s+(-q\s+)?--hard/.test(code) && !/core-data-clone-guard\.sh/.test(s);
  }).map((f) => path.relative(repo, f));
  assert.deepEqual(offenders, [], 'reset the shared core-data clone only after core_clone_local_work says it is safe');
  assert.ok(files.some((f) => f.endsWith('setup-local-data.sh')), 'scan found setup-local-data.sh');
});
