/**
 * BRO-2719: high-frequency Mac-local audit logs must NOT be tracked, or they
 * dirty the shared main checkout and block `git pull --ff-only` for every
 * session. Fails if any of them is tracked again or loses its ignore rule.
 * Also fails if an ignored path is re-added to the index by accident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }); } catch (e) { return { status: e.status, out: e.stdout }; } };

const LOCAL_ONLY = [
  'data/audit/worktree-gc.log',
  'data/audit/worktree-gc.launchd.log',
  'data/audit/verify-merge-landed.log',
  'data/audit/untracked-sweep-state.json',
];

for (const f of LOCAL_ONLY) {
  test(`${f} is gitignored`, () => {
    const r = git('check-ignore', '-q', f);
    assert.equal(r, '', `${f} is not ignored (git check-ignore failed)`);
  });
  test(`${f} is not tracked`, () => {
    assert.equal(git('ls-files', '--', f).trim(), '', `${f} is tracked; run git rm --cached`);
  });
}

test('CI-shared ledgers stay tracked (other tooling reads them from git)', () => {
  for (const f of ['data/audit/stage-latency.jsonl', 'data/audit/scraper-spend-ledger.jsonl', 'data/audit/outlet-registry-gaps.json']) {
    assert.notEqual(git('ls-files', '--', f).trim(), '', `${f} must remain tracked`);
  }
});

// Guard: a CI-only reader of an ignored path silently no-ops (the BRO-2608
// freshness row did exactly that). health-check.js runs on GitHub runners.
import fs from 'node:fs';
import { createRequire } from 'node:module';
test('CI health-check.js does not read gitignored local-only logs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/health-check.js'), 'utf8');
  for (const f of LOCAL_ONLY) assert.ok(!new RegExp(`(readFileSync|existsSync|statSync)\\([^)]*${path.basename(f).replace(/\./g, '\\.')}`).test(src), `health-check.js reads ${f}`);
});

test('Mac-local worktree-gc freshness deadman: missing log is an error, fresh is healthy, stale alerts', () => {
  const { evaluate } = createRequire(import.meta.url)('../../scripts/check-worktree-gc-freshness.js');
  const now = Date.parse('2026-10-05T14:30:00Z');
  assert.equal(evaluate(null, now).conditionKey, 'worktree-gc:log-missing');
  assert.equal(evaluate('[2026-10-05 14:09:02] DONE', now), null);
  assert.equal(evaluate('[2026-10-01 14:09:02] DONE', now).severity, 'error');
});
