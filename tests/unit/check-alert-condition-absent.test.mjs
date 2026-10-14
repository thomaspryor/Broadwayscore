// BRO-3889: scripts/check-alert-condition-absent.js exit contract — 0 not
// firing, 1 firing, 2 usage, 3 cannot tell (never a vacuous pass). Runs the
// REAL script as a child process against throwaway ledgers via
// ALERT_LEDGER_PATH (the router's own override), so the tracked
// data/audit/alert-ledger.json is never read or touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realNowMs } from '../helpers/clock-shift.mjs';

const require = createRequire(import.meta.url);
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'check-alert-condition-absent.js');
const { alertAbsentCheckCmd } = require('../../scripts/lib/health-row-check-cmd.js');
const { QUIET_WINDOW_H } = require('../../scripts/check-alert-condition-absent.js');

const H = 36e5;
// Stamps are read by a child process that runs on the REAL clock (the clock-shift
// preload is not inherited), so stamp from the real clock too or a +Nd audit shift
// makes every ledger entry look future-dated.
const iso = (hoursAgo) => new Date(realNowMs() - hoursAgo * H).toISOString();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-absent-'));

function writeLedger(name, conditions) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof conditions === 'string' ? conditions : JSON.stringify({ conditions }));
  return p;
}

// Run exactly the command the router writes into the card.
function run(ledgerPath, conditionKey) {
  const argv = alertAbsentCheckCmd(conditionKey).split(' ').slice(2);
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    env: { ...process.env, ALERT_LEDGER_PATH: ledgerPath }, encoding: 'utf8',
  });
}

const FRESH = { 'heartbeat:x': { status: 'open', lastSeen: iso(1) } };
const ledger = writeLedger('ledger.json', {
  ...FRESH,
  'cron-health-chronic:Firing Cron': { status: 'open', lastSeen: iso(5) },
  'gap:resolved-show/nytimes--a.json': { status: 'resolved', lastSeen: iso(400), resolvedAt: iso(300) },
  'backstop:quiet': { status: 'open', lastSeen: iso(QUIET_WINDOW_H + 24) },
  'land:refired-after-resolve': { status: 'resolved', lastSeen: iso(2), resolvedAt: iso(10) },
  'odd:status': { status: 'snoozed', lastSeen: iso(2) },
  [`long:${'é'.repeat(150)}`]: { status: 'open', lastSeen: iso(3) },
});

test('exit 1 while the condition is open and fired inside the quiet window', () => {
  const r = run(ledger, 'cron-health-chronic:Firing Cron');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /still firing/);
});

test('exit 0 once resolveCondition marked it resolved', () => {
  const r = run(ledger, 'gap:resolved-show/nytimes--a.json');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PASS/);
});

test('exit 3 (not a pass) for an open condition that merely went quiet', () => {
  assert.equal(run(ledger, 'backstop:quiet').status, 3);
});

test('a long multi-byte key still matches its full ledger entry through the clamp', () => {
  assert.equal(run(ledger, `long:${'é'.repeat(150)}`).status, 1);
});

test('exit 3, never a vacuous pass, when it cannot tell', () => {
  assert.equal(run(ledger, 'gap:not-in-ledger.json').status, 3, 'unknown key');
  assert.equal(run(ledger, 'land:refired-after-resolve').status, 3, 'seen after resolvedAt');
  assert.equal(run(ledger, 'odd:status').status, 3, 'unrecognised status');
  assert.equal(run(path.join(dir, 'missing.json'), 'backstop:quiet').status, 3, 'missing ledger');
  assert.equal(run(writeLedger('bad.json', '{not json'), 'backstop:quiet').status, 3, 'unreadable ledger');
  const stale = writeLedger('stale.json', { 'gap:old.json': { status: 'resolved', lastSeen: iso(100), resolvedAt: iso(90) } });
  assert.equal(run(stale, 'gap:old.json').status, 3, 'ledger with no write in 48h');
});

test('exit 2 on usage errors', () => {
  const env = { ...process.env, ALERT_LEDGER_PATH: ledger };
  assert.equal(spawnSync(process.execPath, [SCRIPT], { env }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--key-b64', 'not/valid'], { env }).status, 2);
});

test('read-only: the ledger is byte-identical after a run', () => {
  const before = fs.readFileSync(ledger, 'utf8');
  run(ledger, 'cron-health-chronic:Firing Cron');
  assert.equal(fs.readFileSync(ledger, 'utf8'), before);
});
