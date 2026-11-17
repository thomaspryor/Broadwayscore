// session-retro.js (BRO-7629 item 6): hard signals from a transcript; no false hits on prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const R = createRequire(import.meta.url)('./session-retro.js');

const ev = (o) => JSON.stringify({ sessionId: 's1', ...o });
const tool = (name, input, t) => ev({ type: 'assistant', timestamp: t, message: { content: [{ type: 'tool_use', name, input }] } });
const result = (text, t) => ev({ type: 'user', timestamp: t, message: { content: [{ type: 'tool_result', content: text }] } });

test('counts land refusals, hook blocks, bypasses, restarts, reruns, long waits, and flags the thresholds', () => {
  const lines = [
    ev({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'the land was REFUSED: land/x in the brief, plain prose' } }),
    tool('Edit', { file_path: 'a' }, '2026-01-01T00:01:00Z'),
    tool('Bash', { command: 'git push origin HEAD:refs/heads/land/x # NO-VERIFY: because' }, '2026-01-01T00:02:00Z'),
    tool('Bash', { command: 'grep NO-VERIFY: file' }, '2026-01-01T00:02:30Z'),
    result('12:00:00Z REFUSED: land/x unit-tests-node failed', '2026-01-01T00:40:00Z'),
    ev({ type: 'user', timestamp: '2026-01-01T00:41:00Z', message: { content: 'Stop hook feedback: [VE:CLEARCLOSE] x' } }),
    ev({ type: 'user', timestamp: '2026-01-01T00:42:00Z', message: { content: 'This session\'s worker process was restarted.' } }),
    ...[1, 2, 3].map((i) => tool('Bash', { command: 'npm run flaky-thing' }, `2026-01-01T03:0${i}:00Z`)),
  ];
  const r = R.analyze(lines);
  assert.equal(r.landRefusals.length, 1, 'tool output only, not the prose');
  assert.deepEqual(r.bypasses, { 'NO-VERIFY': 1 }, 'a push bypass counts, a grep does not');
  assert.equal(r.hookBlocks['[VE:CLEARCLOSE]'], 1);
  assert.equal(r.restarts, 1);
  assert.equal(r.repeats[0].times, 3);
  assert.ok(r.longWaits.length >= 1);
  assert.ok(r.hours > 2);
  assert.ok(r.triggers.length >= 3);
});

test('a clean short session crosses no threshold', () => {
  const r = R.analyze([tool('Edit', {}, '2026-01-01T00:00:00Z'), result('ok', '2026-01-01T00:05:00Z')]);
  assert.deepEqual(r.triggers, []);
});

test('weekly rollup counts repeated signals and runs once per week with --if-due', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'retro-'));
  const ledger = path.join(dir, 'l.jsonl');
  try {
    const now = new Date().toISOString();
    for (const id of ['a', 'b', 'c']) fs.appendFileSync(ledger, JSON.stringify({ sessionId: id, endAt: now, recordedAt: now, signals: ['hook:[VE:X]', id === 'a' ? 'restart' : 'hook:[VE:Y]'] }) + '\n');
    const out = [];
    const top = R.rollup(7, false, { ledger, ifDue: true, log: (m) => out.push(m) });
    assert.equal(top[0][0], 'hook:[VE:X]');
    assert.equal(top[0][1], 3);
    assert.equal(R.rollup(7, false, { ledger, ifDue: true, log: () => {} }), -1, 'second run in the week is skipped');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
