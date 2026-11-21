// BRO-7139 Step 3: acceptance judge reads only committed ledgers. require() the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ACC = require('../llm-triage-acceptance.js');
const AUD = require('./llm-triage-audit.js');

const WEEK = 7 * 86400000;
const MON = Date.parse('2026-11-09T02:15:00Z'); // a Monday
const snap = (w, stuck, ready = 12, extra = {}) => ({ v: 2, source: 'ci', ts: new Date(MON + w * WEEK).toISOString(), groups: { stuck }, ready, ...extra });

test('weeklySnapshots: newest clean CI v2 row per week; v1, local and error rows ignored', () => {
  const rows = [snap(0, 50), { ...snap(0, 40), ts: new Date(MON + 86400000).toISOString() }, snap(1, 30, 12, { source: 'local' }), snap(1, 30, 12, { v: 1 }), snap(1, 30, 12, { error: 'down' })];
  const s = ACC.weeklySnapshots(rows);
  assert.equal(s.length, 1);
  assert.equal(s[0].stuck, 40);
});

test('stuckShrinks: 4 consecutive weeks each strictly lower; flat, rising or a gap week fails', () => {
  const ok = ACC.weeklySnapshots([snap(0, 60), snap(1, 50), snap(2, 40), snap(3, 30)]);
  assert.equal(ACC.stuckShrinks(ok).pass, true);
  assert.equal(ACC.stuckShrinks(ACC.weeklySnapshots([snap(0, 60), snap(1, 50), snap(2, 50), snap(3, 30)])).pass, false);
  assert.equal(ACC.stuckShrinks(ACC.weeklySnapshots([snap(0, 60), snap(1, 50), snap(3, 40), snap(4, 30)])).pass, false);
  assert.equal(ACC.stuckShrinks(ACC.weeklySnapshots([snap(0, 60), snap(1, 50), snap(2, 40)])).pass, false);
  assert.equal(ACC.stuckShrinks(ACC.weeklySnapshots([snap(0, 10), snap(1, 0), snap(2, 0), snap(3, 0)])).pass, true); // empty stays empty
});

const audit = (n, wrong) => [{ ts: new Date(MON).toISOString(), source: 'ci', items: Array.from({ length: n }, (_, i) => ({ id: `BRO-${i}`, nominatedTs: 't', verdict: 'keep', judgment: i < wrong ? 'wrong' : 'right' })) }];

test('judge: all four criteria must pass; thresholds are exclusive where the plan says so', () => {
  const good = { dispatchRows: [snap(0, 60), snap(1, 50), snap(2, 40), snap(3, 30, 10)], auditRows: audit(40, 1), coverageOk: true, now: MON + 3 * WEEK + 86400000 };
  assert.equal(ACC.judge(good).pass, true);
  assert.equal(ACC.judge({ ...good, auditRows: audit(29, 0) }).pass, false); // too few judged
  assert.equal(ACC.judge({ ...good, auditRows: audit(40, 2) }).pass, false); // 5.0% is not < 5%
  assert.equal(ACC.judge({ ...good, dispatchRows: [snap(0, 60), snap(1, 50), snap(2, 40), snap(3, 30, 9)] }).pass, false);
  assert.equal(ACC.judge({ ...good, coverageOk: false }).pass, false);
  assert.equal(ACC.judge({ dispatchRows: [], auditRows: [], coverageOk: true }).criteria[1].detail, 'no CI v2 snapshot yet');
});

test('judge: stale or stuck-less snapshots never pass the board criteria (review finding)', () => {
  const rows = [snap(0, 60), snap(1, 50), snap(2, 40), snap(3, 30, 10)];
  const base = { dispatchRows: rows, auditRows: audit(40, 1), coverageOk: true };
  // Dispatcher died: newest row is 3 weeks old.
  const stale = ACC.judge({ ...base, now: MON + 6 * WEEK });
  assert.equal(stale.pass, false);
  assert.equal(stale.criteria[0].pass, false);
  assert.equal(stale.criteria[1].pass, false);
  // A renamed or dropped stuck key must not read as "stuck 0".
  const noStuck = (w) => ({ ...snap(w, 0), groups: { other: 3 } });
  const dropped = ACC.judge({ ...base, dispatchRows: [snap(0, 10), noStuck(1), noStuck(2), noStuck(3)], now: MON + 3 * WEEK });
  assert.equal(dropped.criteria[0].pass, false);
  assert.equal(ACC.weeklySnapshots([{ ...snap(0, 0), groups: { stuck: null } }]).length, 0);
});

test('settledKeys: only CI audit rows settle a nomination (review finding)', () => {
  const item = { id: 'BRO-9', nominatedTs: 't1', judgment: 'right' };
  assert.equal(AUD.settledKeys([{ source: 'local', items: [item] }]).size, 0);
  assert.equal(AUD.settledKeys([{ source: 'ci', items: [item] }]).has('BRO-9|t1'), true);
});

test('main reads the committed ledger paths and exits 1 until the bar is met', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  fs.mkdirSync(path.join(root, 'data/audit'), { recursive: true });
  const lines = [];
  assert.equal(ACC.main({ root, runTests: () => true, log: (s) => lines.push(s) }), 1);
  fs.writeFileSync(path.join(root, 'data/audit/board-dispatch.jsonl'), [snap(0, 60), snap(1, 50), snap(2, 40), snap(3, 30)].map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(root, AUD.AUDIT_LEDGER_PATH), audit(30, 0).map((r) => JSON.stringify(r)).join('\n'));
  assert.equal(ACC.main({ root, runTests: () => true, log: () => {} }), 0);
  assert.ok(lines.some((l) => /^FAIL {2}ready/.test(l)), lines.join('\n'));
});
