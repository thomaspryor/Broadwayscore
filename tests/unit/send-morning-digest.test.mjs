import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { summarizeBoardGateFailopen, readBoardGateFailopen } = require('../../scripts/lib/summarize-board-gate-failopen.js');
const { buildHtml } = require('../../scripts/send-morning-digest.js');
const now = new Date('2026-10-18T02:00:00Z');
const event = (at, verdict, rc = 1) => `${at} session=fixture rc=${rc} verdict=${verdict} board=linear`;

test('broken probe escalates even without any unreachable/erroring events', () => {
  const summary = summarizeBoardGateFailopen(event('2026-10-17T14:32:12Z', 'broken', 127), { now });
  assert.deepEqual(summary.counts, { unreachable: 0, erroring: 0, broken: 1 });
  assert.equal(summary.failedOpen, 0);
  assert.match(summary.alert, /non-functional.*broken.*repair card/);
});

test('mixed verdicts are counted per event, including repeated sessions', () => {
  const summary = summarizeBoardGateFailopen([
    event('2026-10-17T00:00:00Z', 'unreachable', 124),
    event('2026-10-17T08:00:00Z', 'unreachable', 4),
    event('2026-10-17T14:00:00Z', 'erroring', 3),
    event('2026-10-17T23:59:59.999Z', 'broken', 127),
  ].join('\n'), { now });
  assert.deepEqual(summary.counts, { unreachable: 2, erroring: 1, broken: 1 });
  assert.equal(summary.line, 'board gate: 3 failed open (2 unreachable, 1 erroring), 1 broken');
});

test('UTC boundaries exclude older and current-day events, even across offsets', () => {
  const summary = summarizeBoardGateFailopen([
    event('2026-10-16T23:59:59Z', 'broken'),
    event('2026-10-18T00:00:00Z', 'broken'),
    event('2026-10-18T00:59:59+01:00', 'erroring'),
    event('2026-10-16T20:00:00-04:00', 'unreachable'),
  ].join('\r\n'), { now });
  assert.deepEqual(summary.counts, { unreachable: 1, erroring: 1, broken: 0 });
  assert.equal(summary.alert, null);
});

test('empty, stale, unknown, and malformed lines produce no output', () => {
  for (const log of ['', '\n', 'bad timestamp verdict=broken',
    event('2026-10-17T12:00:00', 'broken'),
    event('2026-10-17T12:00:00Z', 'broken-suffix'),
    event('2026-10-17T12:00:00Z', 'healthy', 0),
    event('2026-10-16T12:00:00Z', 'broken'),
  ]) assert.equal(summarizeBoardGateFailopen(log, { now }), null, log);
});

test('real digest assembly reads the override, escalates broken, and stays silent for empty/missing logs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-board-gate-'));
  const logPath = path.join(dir, 'failopen.log');
  const previous = process.env.BOARD_GATE_FAILOPEN_LOG;
  t.after(() => {
    if (previous === undefined) delete process.env.BOARD_GATE_FAILOPEN_LOG;
    else process.env.BOARD_GATE_FAILOPEN_LOG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.BOARD_GATE_FAILOPEN_LOG = logPath;
  const render = () => buildHtml({ now, loopDeadMsg: null });
  assert.equal(readBoardGateFailopen({ now }), null);
  assert.doesNotMatch(render(), /board gate:|Board gate is non-functional/);
  fs.writeFileSync(logPath, '');
  assert.equal(readBoardGateFailopen({ now }), null);
  assert.doesNotMatch(render(), /board gate:|Board gate is non-functional/);

  fs.writeFileSync(logPath, event('2026-10-17T12:00:00Z', 'erroring', 3));
  let html = render();
  assert.match(html, /board gate: 1 failed open \(0 unreachable, 1 erroring\), 0 broken/);
  assert.doesNotMatch(html, /Board gate is non-functional/);

  fs.appendFileSync(logPath, `\n${event('2026-10-17T13:00:00Z', 'broken', 127)}`);
  html = render();
  assert.match(html, /board gate: 1 failed open \(0 unreachable, 1 erroring\), 1 broken/);
  assert.match(html, /color:#b91c1c[^>]*>⚠️ Board gate is non-functional/);
});
