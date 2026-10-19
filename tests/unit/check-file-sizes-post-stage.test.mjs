// TESTS-VS-DERIVED-DATA-EXEMPT: data/*.json paths here are sparse fixture files inside a throwaway git repo, never the real derived data
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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts/lib/check-file-sizes.sh');
const MB = 1024 * 1024;

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sizes-'));
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', ...a], { cwd: dir, stdio: 'pipe', env: gitEnv });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'data', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'data/ignored-big.json\n');
  // Sparse files: a size without writing the bytes.
  const sized = (rel, bytes) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); fs.truncateSync(p, bytes); };
  sized('data/audit/big-ledger.jsonl', 13 * MB);   // known-large tracked ledger
  sized('data/audit/small.json', 1000);
  sized('data/audit/mid.json', 4 * MB);
  git('add', '-A');
  git('commit', '-qm', 'base');
  const run = (env = {}, args = []) => {
    const summary = path.join(dir, 'summary.md');
    // Inherited GIT_* (e.g. inside a hook or land gate) would point git at the real repo.
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const r = spawnSync('bash', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...clean, GITHUB_STEP_SUMMARY: summary, CHECK_FILE_SIZES_ENFORCE_ALL: '', ...env } });
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

test('crossing 5MB with a small step (4MB -> 6MB) is reported: the crossing rule, not the growth rule', () => {
  const r = makeRepo();
  try {
    fs.truncateSync(path.join(r.dir, 'data/audit/mid.json'), 6 * MB);
    const out = r.run();
    assert.match(out.stdout, /data\/audit\/mid\.json: grew from 4194304/);
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
    r.git('add', 'data/audit/stage-latency.jsonl');
    assert.equal(r.run().status, 1, 'staged over the hard cap fails');
  } finally { r.cleanup(); }
});

test('a repo with no HEAD commit still reports new big files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sizes-nohead-'));
  try {
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv });
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data/a.db'), 'x'); fs.truncateSync(path.join(dir, 'data/a.db'), 6 * MB);
    const r = spawnSync('bash', [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...gitEnv, GITHUB_STEP_SUMMARY: '/dev/null' } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no HEAD commit/);
    assert.match(r.stdout, /data\/a\.db: new file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('a clean tree passes and says how many files it checked', () => {
  const r = makeRepo();
  try {
    const out = r.run();
    assert.equal(out.status, 0);
    assert.match(out.stdout, /File size check passed \(0 changed or new/);
  } finally { r.cleanup(); }
});

test('--advisory: a staged new 6MB file is a warning and exit 0, never an ::error::', () => {
  const r = makeRepo();
  try {
    r.sized('data/cache.sqlite', 6 * MB);
    r.git('add', 'data/cache.sqlite');
    const out = r.run({}, ['--advisory']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /::warning::Large staged data file \(advisory.*data\/cache\.sqlite: new file/);
    assert.doesNotMatch(out.stdout, /::error::/);
    assert.match(out.summary, /Large staged data files \(advisory\)/);
  } finally { r.cleanup(); }
});

test('--advisory exits 0 even when the script itself fails; a bad argument fails without it', () => {
  const r = makeRepo();
  try {
    const adv = r.run({}, ['--advisory', '--bogus']);
    assert.equal(adv.status, 0, adv.stdout + adv.stderr);
    assert.match(adv.stderr, /unknown argument\(s\): --bogus/);
    assert.match(adv.stdout, /exited 2 \(advisory mode/);
    assert.equal(r.run({}, ['--bogus']).status, 2);
  } finally { r.cleanup(); }
});

test('post-stage: allowlisted staged file passes, a gitignored file passes, a staged non-allowlisted 6MB file fails', () => {
  const r = makeRepo();
  try {
    r.sized('data/shows.json', 8 * MB);          // ALLOW_LARGE
    r.sized('data/ignored-big.json', 8 * MB);    // gitignored, `git add -A` skips it
    r.git('add', '-A');
    const ok = r.run();
    assert.equal(ok.status, 0, ok.stdout);
    assert.doesNotMatch(ok.stdout, /shows\.json|ignored-big/);
    r.sized('data/audit/new-dump.json', 6 * MB);
    r.git('add', '-A');
    const bad = r.run();
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /data\/audit\/new-dump\.json: new file/);
  } finally { r.cleanup(); }
});

// The tracked files already over 5MB when BRO-5335 was filed. Decision: not
// allowlisted; being in HEAD, routine growth passes (only the crossing and
// >5MB-jump rules apply). Real paths, real sizes.
const KNOWN_LARGE = {
  'data/audit/scraper-spend-ledger.jsonl': 20.5 * MB,
  'data/audit/show-review-gap.json': 9.5 * MB,
  'data/audit/aggregator-coverage.json': 5.2 * MB,
  'data/archive/notion-card-history.jsonl': 7.2 * MB,
  'data/audit/shows-pre-backfill-2026-04-29.json': 6.5 * MB,
  'data/audit/shows-pre-ob-backfill-v2-2026-04-29.json': 6.5 * MB,
};

test('the six already-large tracked files pass when they grow a little and are staged', () => {
  const r = makeRepo();
  try {
    for (const [p, n] of Object.entries(KNOWN_LARGE)) r.sized(p, Math.round(n));
    r.git('add', '-A');
    r.git('commit', '-qm', 'known large');
    for (const [p, n] of Object.entries(KNOWN_LARGE)) fs.truncateSync(path.join(r.dir, p), Math.round(n) + 64 * 1024);
    r.git('add', '-A');
    const out = r.run();
    assert.equal(out.status, 0, out.stdout);
    assert.doesNotMatch(out.stdout, /warning|error/);
  } finally { r.cleanup(); }
});

// Structural: a size check that runs before `git add` sees nothing staged and
// always passes (the BRO-5335 bug). Every call must sit in a step that has
// already staged (or after a step that did) and before the commit.
const WF_DIR = path.join(ROOT, '.github/workflows');
const CALL = 'scripts/lib/check-file-sizes.sh';
const STAGE = /\bgit add\b|git-add-existing\.sh/;
const COMMIT = /\bgit commit\b|rebuild-fast-stage-commit\.sh/;

function callSites() {
  const sites = [];
  for (const file of fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(WF_DIR, file), 'utf8');
    if (!text.includes('check-file-sizes')) continue;
    const doc = yaml.load(text) || {};
    for (const [jobId, job] of Object.entries(doc.jobs || {})) {
      const steps = job.steps || [];
      steps.forEach((step, idx) => {
        const uses = String(step.uses || '');
        const run = String(step.run || '');
        if (uses.includes('check-file-sizes')) sites.push({ file, jobId, idx, kind: 'uses', steps });
        else if (run.includes(CALL)) sites.push({ file, jobId, idx, kind: 'run', steps });
      });
    }
  }
  return sites;
}

test('every workflow size-check call runs after its commit step stages files and before it commits', () => {
  const sites = callSites();
  assert.ok(sites.length >= 18, `expected the check to stay wired in, found ${sites.length} call sites`);
  const bad = [];
  for (const { file, jobId, idx, kind, steps } of sites) {
    const where = `${file} job ${jobId} step ${idx} (${steps[idx].name || 'unnamed'})`;
    if (kind === 'uses') { bad.push(`${where}: separate action step, runs before the commit step stages`); continue; }
    const lines = String(steps[idx].run).split('\n');
    const at = lines.findIndex((l) => l.includes(CALL));
    const before = lines.slice(0, at).join('\n');
    const after = lines.slice(at + 1).join('\n');
    const stagedEarlier = STAGE.test(before) || steps.slice(0, idx).some((s) => STAGE.test(String(s.run || '')));
    const commitsLater = COMMIT.test(after) || steps.slice(idx + 1).some((s) => COMMIT.test(String(s.run || '')));
    if (!stagedEarlier) bad.push(`${where}: no git add before the check`);
    if (!commitsLater) bad.push(`${where}: no git commit after the check`);
    // Advisory until armed (CLAUDE.md section 19); arming is a deliberate edit of this test.
    if (!/check-file-sizes\.sh --advisory\b/.test(lines[at])) bad.push(`${where}: missing --advisory`);
    if (/check-file-sizes\.sh[^\n#]*\|\|/.test(lines[at])) bad.push(`${where}: '||' would also swallow the armed check`);
  }
  assert.deepEqual(bad, []);
});

test('the old pre-stage composite action is gone', () => {
  assert.equal(fs.existsSync(path.join(ROOT, '.github/actions/check-file-sizes')), false);
});
