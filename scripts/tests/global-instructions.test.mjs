// BRO-4237: cloud sessions get the owner's global instructions, fetched from
// the private claude-config repo and installed as ~/.claude/CLAUDE.md by the
// cloud session-start hook. Real functions via require() (CLAUDE.md §15); the
// fetcher is injected so no test touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { installForCloud, renderInstalled, MARKER, GLOBAL_FILES } = require('../lib/global-instructions.js');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `bro-4237-${tag}-`));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const fakeFetch = (files) => async (name) => (name in files ? { text: files[name], reason: null } : { text: null, reason: 'HTTP 404' });
const SOURCE = { 'CLAUDE.md': '# Global Rules\n## Cloud sessions\n- owner not technical\n', 'anti-slop-rules.md': '# no em dashes\n' };

test('installForCloud: installs every source file with the GENERATED marker', async (t) => {
  const home = tmp('home'); t.after(() => rm(home));
  const r = await installForCloud({ homeDir: home, fetchFn: fakeFetch(SOURCE) });
  assert.deepEqual(r.installed, GLOBAL_FILES);
  for (const name of GLOBAL_FILES) {
    const body = fs.readFileSync(path.join(home, '.claude', name), 'utf8');
    assert.equal(body, renderInstalled(name, SOURCE[name]));
    assert.ok(body.includes(MARKER));
  }
});

test('installForCloud: a second run is a no-op; a changed source is rewritten', async (t) => {
  const home = tmp('home'); t.after(() => rm(home));
  await installForCloud({ homeDir: home, fetchFn: fakeFetch(SOURCE) });
  assert.deepEqual((await installForCloud({ homeDir: home, fetchFn: fakeFetch(SOURCE) })).unchanged, GLOBAL_FILES);
  const r = await installForCloud({ homeDir: home, fetchFn: fakeFetch({ ...SOURCE, 'CLAUDE.md': '# edited on the Mac\n' }) });
  assert.deepEqual(r.installed, ['CLAUDE.md']);
  assert.match(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), /edited on the Mac/);
});

test('installForCloud: never overwrites a hand-written ~/.claude file (a real Mac config)', async (t) => {
  const home = tmp('home'); t.after(() => rm(home));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'the real Mac rules\n');
  const r = await installForCloud({ homeDir: home, fetchFn: fakeFetch(SOURCE) });
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), 'the real Mac rules\n');
  assert.match(r.skipped.find((s) => s.name === 'CLAUDE.md').reason, /hand-written/);
  assert.deepEqual(r.installed, ['anti-slop-rules.md']);
});

test('installForCloud: a failed fetch installs nothing and says why (fail open)', async (t) => {
  const home = tmp('home'); t.after(() => rm(home));
  const r = await installForCloud({ homeDir: home, fetchFn: fakeFetch({}) });
  assert.deepEqual(r.installed, []);
  assert.equal(r.skipped.length, GLOBAL_FILES.length);
  assert.match(r.skipped[0].reason, /fetch failed: HTTP 404/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')), false);
});

function runHook(env) {
  const home = tmp('hookhome');
  const project = tmp('proj');
  const src = tmp('src');
  for (const [n, c] of Object.entries(SOURCE)) fs.writeFileSync(path.join(src, n), c);
  try {
    const full = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: REPO_ROOT, CODE_SYNC_DISABLED: '1', GLOBAL_INSTRUCTIONS_FROM_DIR: src, ...env };
    for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k];
    const out = execFileSync('bash', [path.join(REPO_ROOT, '.claude', 'hooks', 'session-start.sh')], {
      cwd: project, input: '{"source":"startup"}', encoding: 'utf8', timeout: 120000, env: full, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const installed = fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')) ? fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8') : null;
    return { out, installed };
  } finally {
    rm(home); rm(project); rm(src);
  }
}

test('session-start.sh (real hook): a cloud session gets ~/.claude/CLAUDE.md installed', () => {
  const { installed } = runHook({ CLAUDE_CODE_REMOTE: 'true' });
  assert.ok(installed, 'cloud session must get the global instructions');
  assert.match(installed, /## Cloud sessions/);
  assert.ok(installed.includes(MARKER));
});

test('session-start.sh (real hook): no install outside cloud, and the kill switch works', () => {
  assert.equal(runHook({ CLAUDE_CODE_REMOTE: undefined }).installed, null);
  assert.equal(runHook({ CLAUDE_CODE_REMOTE: 'true', CLOUD_GLOBAL_RULES_DISABLED: '1' }).installed, null);
});

test('session-start.sh (real hook): the owner profile is no longer printed when the install works (single source is the installed file)', () => {
  const { out } = runHook({ CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_ENTRYPOINT: 'remote_mobile' });
  assert.doesNotMatch(out, /ABOUT THE OWNER|not installed/);
  assert.match(out, /CRITICAL SESSION RULES/);
});

test('session-start.sh (real hook): a failed install is never silent — it prints the owner fallback and the reason', () => {
  const { out, installed } = runHook({ CLAUDE_CODE_REMOTE: 'true', GLOBAL_INSTRUCTIONS_FROM_DIR: '/nonexistent-bro-4237' });
  assert.equal(installed, null);
  assert.match(out, /global instructions not installed \(.*fetch failed/);
  assert.match(out, /not technical/);
  assert.match(out, /never reviews or merges PRs/);
});
