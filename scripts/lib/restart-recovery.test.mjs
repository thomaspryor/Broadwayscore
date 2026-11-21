import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const rr = require('./restart-recovery.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
const env = { ...process.env, RESTART_RECOVERY_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sess-1' };
delete env.RESTART_RECOVERY_DISABLED;

test('record then clear leaves no pending wait', () => {
  const id = rr.record('node x.js', '/tmp', env);
  assert.ok(id);
  assert.equal(rr.readWaits(rr.waitsFile(env)).length, 1);
  rr.clear(id, env);
  assert.equal(rr.readWaits(rr.waitsFile(env)).length, 0);
});

test('a wait that was never cleared (killed by restart) is listed in the notice', () => {
  rr.record('node scripts/lib/wait-for-land.js land/foo 60 --prod', '/repo', env);
  const n = rr.resumeNotice(dir, env);
  assert.match(n, /wait-for-land\.js land\/foo/);
  assert.match(n, /REPORT-BACK/);
});

test('sessions do not see each other\'s waits', () => {
  const other = { ...env, CLAUDE_CODE_SESSION_ID: 'sess-2' };
  assert.equal(rr.readWaits(rr.waitsFile(other)).length, 0);
});

test('buildNotice names dirty worktrees and still tells the worker to continue', () => {
  const n = rr.buildNotice({ waits: [], worktrees: [{ path: '/w/a', dirty: 3, ahead: 2 }] });
  assert.match(n, /\/w\/a: 3 uncommitted file\(s\), 2 unpushed commit\(s\)/);
  assert.match(n, /continue it to the end/);
});

test('kill switch records nothing', () => {
  const off = { ...env, CLAUDE_CODE_SESSION_ID: 'sess-3', RESTART_RECOVERY_DISABLED: 'true' };
  assert.equal(rr.record('x', '/', off), null);
  assert.equal(rr.resumeNotice(dir, off), '');
});

test('class guard: every long wait script records itself, and session-start prints the notice on resume', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const wfl = fs.readFileSync(path.join(root, 'scripts/lib/wait-for-land.js'), 'utf8');
  assert.match(wfl, /restart-recovery\.js'\)\.record/);
  assert.match(wfl, /restart-recovery\.js'\)\.clear/);
  const hook = fs.readFileSync(path.join(root, '.claude/hooks/session-start.sh'), 'utf8');
  assert.match(hook, /SESSION_EVENT" = "resume".*restart-recovery\.js|restart-recovery\.js" resume/s);
});

test('CLI: hook form prints the notice for a stale wait', () => {
  const e = { ...env, CLAUDE_CODE_SESSION_ID: 'sess-cli' };
  rr.record('node scripts/lib/wait-for-land.js land/bar 60', '/repo', e);
  const out = execFileSync('node', [path.join(import.meta.dirname, 'restart-recovery.js'), 'resume', dir], { env: e, encoding: 'utf8' });
  assert.match(out, /land\/bar/);
});
