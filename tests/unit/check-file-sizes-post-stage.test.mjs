// BRO-5335: .github/actions/check-file-sizes read only `git diff --cached`,
// but 16 of its 18 call sites run before their commit step stages anything,
// so it always passed. scripts/lib/check-file-sizes.sh now looks at every
// data/ path that differs from HEAD plus untracked, non-ignored files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts/lib/check-file-sizes.sh');
const MB = 1024 * 1024;

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sizes-'));
  const git = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', ...a], { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'data', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'data/ignored-big.json\n');
  // Sparse files: a size without writing the bytes.
  const sized = (rel, bytes) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); fs.truncateSync(p, bytes); };
  sized('data/audit/big-ledger.jsonl', 13 * MB);   // known-large tracked ledger
  sized('data/audit/small.json', 1000);
  git('add', '-A');
  git('commit', '-qm', 'base');
  const run = (env = {}) => {
    const summary = path.join(dir, 'summary.md');
    const r = spawnSync('bash', [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary, CHECK_FILE_SIZES_ENFORCE_ALL: '', ...env } });
    return { ...r, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
  };
  return { dir, git, sized, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

test('an unstaged new 6MB data file is reported (it used to be invisible) without failing the job', () => {
  const r = makeRepo();
  try {
    r.sized('data/new thing.db', 6 * MB);
    const out = r.run();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /::warning::.*data\/new thing\.db: new file/);
    assert.match(out.summary, /data\/new thing\.db/);
  } finally { r.cleanup(); }
});

test('a staged new 6MB data file fails, as before', () => {
  const r = makeRepo();
  try {
    r.sized('data/cache.sqlite', 6 * MB);
    r.git('add', 'data/cache.sqlite');
    const out = r.run();
    assert.equal(out.status, 1);
    assert.match(out.stdout, /data\/cache\.sqlite: new file/);
  } finally { r.cleanup(); }
});

test('a known-large tracked ledger growing a little is fine, staged or not', () => {
  const r = makeRepo();
  try {
    fs.truncateSync(path.join(r.dir, 'data/audit/big-ledger.jsonl'), 14 * MB);
    assert.equal(r.run().status, 0);
    r.git('add', '-A');
    const out = r.run();
    assert.equal(out.status, 0, out.stdout);
    assert.doesNotMatch(out.stdout, /warning|error/);
  } finally { r.cleanup(); }
});

test('a small tracked file that crosses 5MB, or a big one that jumps by more than 5MB, is reported', () => {
  const r = makeRepo();
  try {
    fs.truncateSync(path.join(r.dir, 'data/audit/small.json'), 7 * MB);
    fs.truncateSync(path.join(r.dir, 'data/audit/big-ledger.jsonl'), 20 * MB);
    const out = r.run();
    assert.equal(out.status, 0);
    assert.match(out.stdout, /data\/audit\/small\.json: grew from 1000/);
    assert.match(out.stdout, /data\/audit\/big-ledger\.jsonl: grew from/);
    r.git('add', 'data/audit/small.json');
    assert.equal(r.run().status, 1, 'staged growth fails');
  } finally { r.cleanup(); }
});

test('allowlisted names and gitignored files are not reported', () => {
  const r = makeRepo();
  try {
    r.sized('data/reviews.json', 8 * MB);
    r.sized('data/ignored-big.json', 8 * MB);
    const out = r.run();
    assert.equal(out.status, 0);
    assert.doesNotMatch(out.stdout, /reviews\.json|ignored-big/);
  } finally { r.cleanup(); }
});

test('anything over the 90MiB hard cap is reported even when allowlisted, and fails when staged', () => {
  const r = makeRepo();
  try {
    r.sized('data/audit/stage-latency.jsonl', 91 * MB);
    const out = r.run();
    assert.match(out.stdout, /stage-latency\.jsonl: .*90MiB hard cap/);
    assert.equal(out.status, 0);
    assert.equal(r.run({ CHECK_FILE_SIZES_ENFORCE_ALL: '1' }).status, 1, 'the enforce switch makes unstaged findings fail');
  } finally { r.cleanup(); }
});

test('a clean tree passes and says how many files it checked', () => {
  const r = makeRepo();
  try {
    const out = r.run();
    assert.equal(out.status, 0);
    assert.match(out.stdout, /File size check passed \(0 changed or new/);
  } finally { r.cleanup(); }
});

test('the action only calls the tested script, and every workflow still uses the action', () => {
  const action = fs.readFileSync(path.join(ROOT, '.github/actions/check-file-sizes/action.yml'), 'utf8');
  assert.match(action, /run: bash scripts\/lib\/check-file-sizes\.sh/);
  assert.doesNotMatch(action, /git diff/, 'logic belongs in the script, where it is tested');
  const users = fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8').includes('./.github/actions/check-file-sizes'));
  assert.ok(users.length >= 15, `expected the action to stay in use, found ${users.length}`);
});
