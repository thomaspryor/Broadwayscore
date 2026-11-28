// BRO-3148: a push that fails for good must name the files the job committed,
// not just say "All push attempts failed", because the runner throws those
// commits away at job end. Covers the EXIT-trap announcement (every nonzero
// exit path) and the optional ledger fields in buildFailureEntry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildFailureEntry } = require('./push-ledger.js');
const SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'push-with-retry.sh');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();

function fixture({ files }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwr-unpushed-'));
  const remote = path.join(tmp, 'remote.git');
  const work = path.join(tmp, 'work');
  sh(`git init -q --bare -b main ${remote}`, tmp);
  // Nulled global config: turn maintenance off in the bare repo itself.
  sh('git config gc.auto 0 && git config gc.autoDetach false && git config maintenance.auto false && git config receive.autogc false', remote);
  sh(`git clone -q ${remote} ${work}`, tmp);
  fs.writeFileSync(path.join(work, 'seed.txt'), 'seed\n');
  sh('git add seed.txt && git commit -qm seed && git push -q origin main', work);
  // Every later push is refused by the remote, so the script must give up.
  const hook = path.join(remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "refusing for test" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.writeFileSync(path.join(work, f), `${f}\n`);
  }
  sh('git add -A && git commit -qm work', work);
  return { tmp, work };
}

function runScript(work, tmp) {
  return spawnSync('bash', [SCRIPT, '1', 'main'], {
    cwd: work,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env, ...GIT_ENV,
      GITHUB_ACTIONS: '', CI: '',
      PUSH_FAILURE_LOG: path.join(tmp, 'failures.jsonl'),
      PUSH_SKIP_FAILURE_LEDGER: '1',
      PUSH_SKIP_LEDGER: '1',
      PUSH_API_FALLBACK_DISABLE: '1',
      PUSH_DEADLINE_SEC: '60',
    },
  });
}

test('a push that fails for good names the files it discarded', () => {
  const { tmp, work } = fixture({ files: ['data/a.json', 'data/b.json', 'notes/c.md'] });
  const r = runScript(work, tmp);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.notEqual(r.status, 0, 'push must fail against a refusing remote');
  const line = out.split('\n').find((l) => l.startsWith('::error title=push-with-retry discarded unpushed work::'));
  assert.ok(line, `expected the discarded-work annotation, got:\n${out.slice(-3000)}`);
  assert.match(line, /3 file\(s\) committed by this job did not reach main/);
  for (const f of ['data/a.json', 'data/b.json', 'notes/c.md']) assert.ok(line.includes(f), `${f} missing from ${line}`);
  assert.ok(!line.includes('seed.txt'), 'files already on the remote must not be listed');
});

test('more than 20 files are capped with a (+N more) tail', () => {
  const files = Array.from({ length: 23 }, (_, i) => `data/f${String(i).padStart(2, '0')}.json`);
  const { tmp, work } = fixture({ files });
  const r = runScript(work, tmp);
  const line = `${r.stdout}\n${r.stderr}`.split('\n').find((l) => l.includes('discarded unpushed work::'));
  assert.ok(line);
  assert.match(line, /23 file\(s\)/);
  assert.match(line, /\(\+3 more\)/);
});

test('buildFailureEntry adds unpushed fields only when the caller knew them', () => {
  const base = { reason: 'retries-exhausted', attempt: 3, maxRetries: 3 };
  const plain = JSON.parse(buildFailureEntry(base));
  assert.equal('unpushedCount' in plain, false, 'older callers keep the exact row shape');
  const withFiles = JSON.parse(buildFailureEntry({ ...base, unpushedCount: 25, unpushedFiles: Array.from({ length: 25 }, (_, i) => `f${i}`) }));
  assert.equal(withFiles.unpushedCount, 25);
  assert.equal(withFiles.unpushedFiles.length, 20);
});
