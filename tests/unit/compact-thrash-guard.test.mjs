// BRO-7397 class guard: a session whose compactions bunch up must be told so at
// the SessionStart:compact restore, even when no checkpoint file survived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// STATE_DIR is computed when the module loads, so point TMPDIR at a sandbox first.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'thrash-guard-'));
process.env.TMPDIR = sandbox;
const require = createRequire(import.meta.url);
const cs = require('../../scripts/lib/compact-state.js');
const root = fileURLToPath(new URL('../../', import.meta.url));
const MIN = 60 * 1000;

test('state dir lives in the sandbox', () => {
  assert.ok(cs.STATE_DIR.startsWith(sandbox), cs.STATE_DIR);
});

test('one compaction, or spread-out compactions, stay silent', () => {
  const now = 10_000_000;
  assert.equal(cs.getThrashWarning([], now), '');
  assert.equal(cs.getThrashWarning([now], now), '');
  assert.equal(cs.getThrashWarning([now - 60 * MIN, now], now), '');
  assert.equal(cs.getThrashWarning(undefined, now), '');
});

test('the second compaction inside 15 minutes warns', () => {
  const now = 10_000_000;
  const w = cs.getThrashWarning([now - 6 * MIN, now], now);
  assert.match(w, /^COMPACTION THRASH GUARD \(BRO-7397\)/);
  assert.match(w, /2 compactions in the last 15 minutes/);
  assert.match(w, /KEEP OPEN/);
});

test('eight compactions over a long time still warn (lifetime)', () => {
  const now = 100_000_000;
  const times = Array.from({ length: cs.THRASH_LIFETIME }, (_, i) => now - (i + 1) * 60 * MIN);
  assert.match(cs.getThrashWarning(times, now), /8 compactions in this session/);
  assert.equal(cs.getThrashWarning(times.slice(1), now), '');
});

test('recordCompaction persists, caps the log, and survives garbage', () => {
  const input = { session_id: 'sess-rec', transcript_path: '/x/sess-rec.jsonl' };
  const p = cs.compactLogPath(input.session_id, input.transcript_path);
  assert.deepEqual(cs.recordCompaction(input, 5), [5]);
  assert.deepEqual(cs.recordCompaction(input, 9), [5, 9]);
  fs.writeFileSync(p, '{not json');
  assert.deepEqual(cs.recordCompaction(input, 11), [11]);
  for (let i = 0; i < 60; i++) cs.recordCompaction(input, 100 + i);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).length, 40);
});

test('restore emits the guard with no checkpoint file, and does not consume the log', () => {
  const input = { session_id: 'sess-restore', transcript_path: '/x/sess-restore.jsonl' };
  const now = Date.now();
  cs.recordCompaction(input, now - 2 * MIN);
  cs.recordCompaction(input, now - 1 * MIN);
  for (let i = 0; i < 2; i++) {
    const out = cs.restoreCheckpoint(input);
    assert.ok(out, 'guard must be injected');
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /COMPACTION THRASH GUARD/);
  }
});

test('restore puts the guard before the checkpoint text and consumes only the checkpoint', () => {
  const input = { session_id: 'sess-both', transcript_path: '/x/sess-both.jsonl' };
  const now = Date.now();
  cs.recordCompaction(input, now - 2 * MIN);
  cs.recordCompaction(input, now - 1 * MIN);
  fs.mkdirSync(cs.STATE_DIR, { recursive: true });
  fs.writeFileSync(cs.statePath(input.session_id, input.transcript_path), '# Compaction checkpoint\nbody');
  const ctx = cs.restoreCheckpoint(input).hookSpecificOutput.additionalContext;
  assert.ok(ctx.indexOf('COMPACTION THRASH GUARD') < ctx.indexOf('# Compaction checkpoint'));
  assert.equal(fs.existsSync(cs.statePath(input.session_id, input.transcript_path)), false);
  assert.ok(fs.existsSync(cs.compactLogPath(input.session_id, input.transcript_path)));
});

test('restore finds the log when its input omits transcript_path', () => {
  const written = { session_id: 'sess-nopath', transcript_path: '/x/sess-nopath.jsonl' };
  const now = Date.now();
  cs.recordCompaction(written, now - 2 * MIN);
  cs.recordCompaction(written, now - 1 * MIN);
  const out = cs.restoreCheckpoint({ session_id: 'sess-nopath' });
  assert.match(out.hookSpecificOutput.additionalContext, /COMPACTION THRASH GUARD/);
});

test('a healthy session with no checkpoint restores nothing', () => {
  assert.equal(cs.restoreCheckpoint({ session_id: 'sess-healthy', transcript_path: '/x/sess-healthy.jsonl' }), null);
});

test('the hook entry point records a compaction on PreCompact', async () => {
  const { execFileSync } = await import('node:child_process');
  const sid = 'sess-hook';
  const env = { ...process.env, TMPDIR: sandbox };
  const payload = JSON.stringify({ session_id: sid, transcript_path: `/x/${sid}.jsonl`, hook_event_name: 'PreCompact' });
  for (let i = 0; i < 2; i++) {
    execFileSync('node', [path.join(root, 'scripts/lib/compact-state.js'), 'write'], { input: payload, env });
  }
  const log = JSON.parse(fs.readFileSync(cs.compactLogPath(sid, `/x/${sid}.jsonl`), 'utf8'));
  assert.equal(log.length, 2);
  const out = execFileSync('node', [path.join(root, 'scripts/lib/compact-state.js'), 'restore'], {
    input: JSON.stringify({ session_id: sid, transcript_path: `/x/${sid}.jsonl`, hook_event_name: 'SessionStart', source: 'compact' }), env,
  }).toString();
  assert.match(out, /COMPACTION THRASH GUARD/);
});

test('settings.json aligns worker compaction percent and the stale-env check watches it', () => {
  const env = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).env;
  assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '92');
  assert.match(cs.getStaleEnvWarning(env, { ...env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' }), /CLAUDE_AUTOCOMPACT_PCT_OVERRIDE/);
});
