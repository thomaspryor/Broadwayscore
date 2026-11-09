// BRO-7017: the pager's cron starts 2-7h late, so it also wakes on finished Test Suite / Deploy to
// Vercel runs, gated to 11:45 ET and once per ET day. Pins the wake list, the gate and the marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { decidePagerWake } = require('../../scripts/lib/digest-pager-gate.js');
const WF = read('.github/workflows/check-morning-digest-sent.yml');

test('pager wake list is exactly Test Suite + Deploy to Vercel on main, and each name exists once', () => {
  const m = WF.match(/^ {2}workflow_run:\n {4}workflows: \[([^\]]*)\]\n {4}types: \[completed\]\n {4}branches: \[main\]/m);
  assert.ok(m, 'workflow_run block not found');
  const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.equal(m[1].split(',').length, names.length, 'entries must be single-quoted strings');
  assert.deepEqual(names, ['Test Suite', 'Deploy to Vercel']);
  const dir = path.join(ROOT, '.github/workflows');
  const top = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => {
    const line = read(`.github/workflows/${f}`).split('\n').find((l) => /^name:/.test(l)) || '';
    return line.replace(/\s+#.*$/, '').replace(/^name:\s*['"]?/, '').replace(/['"]?\s*$/, '');
  });
  for (const n of names) assert.equal(top.filter((x) => x === n).length, 1, `"${n}" must name exactly one workflow`);
  assert.match(WF, /min_consecutive_failures: '1'/, 'green gated-out wakes break any longer failure streak');
  assert.match(WF, /^ {4}- cron: '45 16 \* \* \*'$/m, 'the cron stays as a second path');
});

test('pager: gate step, once-per-day marker, and every check/commit step conditioned on the decision', () => {
  assert.match(WF, /id: gate\n\s+run: node scripts\/lib\/digest-pager-gate\.js/);
  assert.match(WF, /id: ran\n[\s\S]*?actions\/cache\/restore@[\s\S]*?key: digest-pager-ran-\$\{\{ steps\.gate\.outputs\.day \}\}\n\s+lookup-only: true/);
  assert.match(WF, /actions\/cache\/save@[\s\S]*?key: digest-pager-ran-\$\{\{ steps\.gate\.outputs\.day \}\}/);
  const steps = WF.split(/\n {6}- (?:name|uses):/).slice(1);
  for (const label of ['Check the morning digest was sent', 'Check the Mac heartbeat', 'Commit alert ledger', 'Mark today as checked', 'Save the once-per-day marker']) {
    const s = steps.find((x) => x.trimStart().startsWith(label));
    assert.ok(s, `step "${label}" missing`);
    assert.match(s, /steps\.decide\.outputs\.run == 'true'/, `"${label}" must be gated by the decision`);
  }
  // marker saved after failed attempts too: Deploy to Vercel wakes every ~5 min, retrying would re-page and re-commit the ledger
  const mark = steps.find((x) => x.trimStart().startsWith('Mark today as checked'));
  const save = steps.find((x) => x.trimStart().startsWith('Save the once-per-day marker'));
  const cond = (x) => x.match(/if: (.*)/)[1];
  assert.match(cond(save), /^always\(\)/);
  assert.equal(cond(mark), cond(save));
});

test('pager starts after the catch-up sender can no longer send', () => {
  const { SEND_UNTIL_MINUTES_ET } = require('../../scripts/lib/digest-enable-gate.js');
  const { CHECK_FROM_MINUTES_ET } = require('../../scripts/lib/digest-pager-gate.js');
  assert.ok(CHECK_FROM_MINUTES_ET >= SEND_UNTIL_MINUTES_ET + 10, 'needs a buffer past the sender\'s last send minute');
});

test('decidePagerWake: event wakes wait for 11:45 ET, run once a day; only dispatch is not time-gated', () => {
  const at = (iso) => new Date(iso);
  // EST (Nov): 11:44 ET = 16:44Z, 11:45 ET = 16:45Z
  assert.equal(decidePagerWake({ now: at('2026-11-05T16:44:00Z'), event: 'workflow_run' }).go, false);
  assert.equal(decidePagerWake({ now: at('2026-11-05T16:45:00Z'), event: 'workflow_run' }).go, true);
  // EDT (Jul): 11:45 ET = 15:45Z
  assert.equal(decidePagerWake({ now: at('2026-07-15T15:44:00Z'), event: 'workflow_run' }).go, false);
  assert.equal(decidePagerWake({ now: at('2026-07-15T15:45:00Z'), event: 'workflow_run' }).go, true);
  assert.equal(decidePagerWake({ now: at('2026-11-05T22:00:00Z'), event: 'workflow_run', alreadyRan: true }).go, false);
  assert.equal(decidePagerWake({ now: at('2026-11-05T22:00:00Z'), event: 'schedule', alreadyRan: true }).go, false);
  assert.equal(decidePagerWake({ now: at('2026-11-05T16:45:00Z'), event: 'schedule' }).go, true);
  assert.equal(decidePagerWake({ now: at('2026-11-06T05:10:00Z'), event: 'schedule' }).go, false, 'a cron delayed past midnight ET must not consume the new day');
  assert.equal(decidePagerWake({ now: at('2026-11-05T12:00:00Z'), event: 'workflow_dispatch', alreadyRan: true }).go, true);
  assert.equal(decidePagerWake({ now: at('2026-11-06T03:00:00Z'), event: 'workflow_run' }).day, '2026-11-05', 'ET day, not UTC');
});
