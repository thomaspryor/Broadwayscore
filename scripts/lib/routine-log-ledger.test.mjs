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

test('ledger append writes one JSON row per log', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rll-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { file } = L.appendRoutineLog({ title: 'Opening-night watch 2026-10-22', notes: 'ok', root, now: new Date('2026-10-23T03:00:00Z') });
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Opening-night watch 2026-10-22');
});

test('diverted logs persist full records on the existing ledger card before returning its id', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rll-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const client = {
    async getIssue(identifier) {
      calls.push(['get', identifier]);
      return { id: 'ledger-uuid', identifier };
    },
    async createComment(id, body) {
      calls.push(['comment', id, body]);
      return { success: true };
    },
  };
  const titles = ['Opening-night watch 2026-10-22', 'Opening-night audit 2026-10-23', 'Week in Review, 2026-10-12 to 2026-10-19'];
  for (const title of titles) {
    const result = await L.recordRoutineLog({ title, notes: 'First line\nSecond line', source: 'routine:test', root, now: new Date('2026-10-23T03:00:00Z') }, client);
    assert.equal(result.identifier, 'BRO-6130');
    const [read, write] = calls.splice(0);
    assert.deepEqual(read, ['get', result.identifier]);
    assert.equal(write[1], 'ledger-uuid');
    for (const value of [title, 'First line\nSecond line', 'routine:test', '2026-10-23T03:00:00.000Z']) assert.ok(write[2].includes(value), value);
    assert.equal(fs.existsSync(result.file), true);
  }
  assert.equal(fs.readFileSync(path.join(root, L.LEDGER_REL), 'utf8').trim().split('\n').length, 3);
});

test('a missing ledger card or failed durable write rejects diversion so the caller can file a card', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rll-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { title: 'Opening-night watch 2026-10-22', root };
  await assert.rejects(() => L.recordRoutineLog(options, {
    getIssue: async () => null,
    createComment: async () => assert.fail('must not post without a ledger card'),
  }), /ledger card/);
  await assert.rejects(() => L.recordRoutineLog(options, {
    getIssue: async () => ({ id: 'ledger-uuid' }),
    createComment: async () => { throw new Error('Linear unavailable'); },
  }), /Linear unavailable/);
  await assert.rejects(() => L.recordRoutineLog(options, {
    getIssue: async () => ({ id: 'ledger-uuid' }),
    createComment: async () => ({ success: false }),
  }), /comment/);
});

test('every title the diverter takes is still a record in the digest if it reaches Linear', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const cards = ['Opening-night watch 2026-10-23', 'Opening-night audit 2026-10-23', 'Week in Review, 2026-10-12 to 2026-10-19'].map((title) => ({ title, description: '', createdAt: '2026-10-24T01:00:00Z' }));
  const r = B.summarizeBoardFlow(cards, { now, windowDays: 1 });
  assert.equal(r.created, 0);
  assert.equal(r.excluded.created.routineLog, 3);
});
