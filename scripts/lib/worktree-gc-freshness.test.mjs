import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { lastTimestampsByRepo, checkWorktreeGcFreshnessByRepo, evaluateRepos, checkWorktreeGcFreshness, lastTimestampFromLog } = require('./worktree-gc-freshness.js');

const NOW = Date.parse('2026-10-25T12:00:00Z');
const LOG = [
  '[2026-10-20 03:00:00] DIGEST[ios]: no stale-unmerged worktrees (>7d untouched)',
  '[2026-10-25 11:00:00] DIGEST[web]: no stale-unmerged worktrees (>7d untouched)',
  '[2026-10-25 11:00:05] WARN  [ios] x — leaving',
  '[2026-10-25 11:30:00] DIGEST[web]: 1 unmerged worktree(s) untouched >7d holding stranded work: a',
].join('\n');

test('newest DIGEST timestamp per repo', () => {
  assert.deepEqual(lastTimestampsByRepo(LOG), { ios: '2026-10-20 03:00:00', web: '2026-10-25 11:30:00' });
});

test('fresh web plus stale ios in one log: only ios fires (overall check stays quiet)', () => {
  assert.equal(checkWorktreeGcFreshness(lastTimestampFromLog(LOG), NOW), null);
  const r = checkWorktreeGcFreshnessByRepo(LOG, NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].repo, 'ios');
  assert.equal(r[0].severity, 'error');
  const p = evaluateRepos(LOG, NOW, ['web', 'ios']);
  assert.deepEqual(p.map((x) => x.conditionKey), ['worktree-gc:stale:ios']);
});

test('expected repo with no heartbeat at all is an error', () => {
  const r = checkWorktreeGcFreshnessByRepo('[2026-10-25 11:30:00] DIGEST[web]: ok', NOW, ['web', 'ios']);
  assert.deepEqual(r, [{ repo: 'ios', hoursStale: null, severity: 'error' }]);
});

test('all repos fresh, empty log, older log format, missing log: nothing fires', () => {
  assert.deepEqual(checkWorktreeGcFreshnessByRepo('[2026-10-25 11:30:00] DIGEST[web]: ok\n[2026-10-25 11:31:00] DIGEST[ios]: ok', NOW, ['web', 'ios']), []);
  assert.deepEqual(checkWorktreeGcFreshnessByRepo('', NOW), []);
  assert.deepEqual(checkWorktreeGcFreshnessByRepo('[2026-10-01 00:00:00] some old line', NOW), []);
  assert.deepEqual(evaluateRepos(null, NOW, ['web']), []);
});

test('warn between 6h and 24h', () => {
  const r = checkWorktreeGcFreshnessByRepo('[2026-10-25 03:00:00] DIGEST[ios]: ok', NOW);
  assert.equal(r[0].severity, 'warn');
});

test('expected list restricts the check: a stale name no longer configured is ignored', () => {
  const log = '[2026-10-01 00:00:00] DIGEST[old]: ok\n[2026-10-25 11:30:00] DIGEST[web]: ok';
  assert.deepEqual(checkWorktreeGcFreshnessByRepo(log, NOW, ['web']), []);
});

test('lastTimestampsByRepo sees a skipped-repo heartbeat', () => {
  assert.deepEqual(lastTimestampsByRepo('[2026-10-25 11:30:00] DIGEST[ios]: 0 removed, 0 kept'), { ios: '2026-10-25 11:30:00' });
});
