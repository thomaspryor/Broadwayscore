import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const L = require('./routine-log-ledger.js');
const B = require('./board-numbers.js');

test('dated routine log titles match; real work titles do not', () => {
  for (const t of ['Opening-night watch 2026-10-22', 'Opening-night audit 2026-10-23', 'Week in Review, 2026-10-12 to 2026-10-19', 'Week in Review — 2026-10-12 to 2026-10-19']) assert.ok(L.isRoutineLogTitle(t), t);
  for (const t of ['Fix Opening-night watch 2026-10-23', 'Week in Review rendering is broken', 'Opening-night watch']) assert.equal(L.isRoutineLogTitle(t), false, t);
});

test('ledger append writes one JSON row per log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rll-'));
  const { file } = L.appendRoutineLog({ title: 'Opening-night watch 2026-10-22', notes: 'ok', root, now: new Date('2026-10-23T03:00:00Z') });
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Opening-night watch 2026-10-22');
});

test('every title the diverter takes is still a record in the digest if it reaches Linear', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const cards = ['Opening-night watch 2026-10-23', 'Opening-night audit 2026-10-23', 'Week in Review, 2026-10-12 to 2026-10-19'].map((title) => ({ title, description: '', createdAt: '2026-10-24T01:00:00Z' }));
  const r = B.summarizeBoardFlow(cards, { now, windowDays: 1 });
  assert.equal(r.created, 0);
  assert.equal(r.excluded.created.routineLog, 3);
});
