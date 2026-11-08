// BRO-7135: board closer. Uses the real pure functions, the real check-health-row-absent main(),
// and the real sweep main() with only Linear/spawn edges injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'board-closer-test-'));
process.env.HEALTH_SNAPSHOT_OVERRIDE = path.join(DIR, 'snap.json');
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* best-effort */ } });
fs.writeFileSync(process.env.HEALTH_SNAPSHOT_OVERRIDE, JSON.stringify({
  generatedAt: new Date().toISOString(),
  errors: [{ name: 'Still Red Row' }], warns: [], queued: [],
}));

const bc = require('./board-closer.js');
const { main } = require('../sweep-recovered-alert-cards.js');

const card = (identifier, title, description, type = 'started') => ({ identifier, title, description, state: { type } });
const RECOVERED = card('BRO-1', 'BSC Daily: Recovered Row', 'x\n[conditionKey:health-check:Recovered Row]\n');
const RED = card('BRO-2', 'BSC Daily: Still Red Row', 'x\n[conditionKey:health-check:Still Red Row]\n');
const NOKEY = card('BRO-3', 'BSC Daily: Something', 'no key here');

test('classifyAlertCard: recovered, red, no-key, non-alert, terminal, escaped brackets', () => {
  assert.equal(bc.classifyAlertCard(RECOVERED).row, 'Recovered Row');
  assert.equal(bc.classifyAlertCard(RED).kind, 'candidate');
  assert.equal(bc.classifyAlertCard(NOKEY).kind, 'no-condition-key');
  assert.equal(bc.classifyAlertCard(card('BRO-4', 'Other', '[conditionKey:health-check:A]')).kind, 'not-alert');
  assert.equal(bc.classifyAlertCard({ ...RED, state: { type: 'completed' } }).kind, 'terminal');
  assert.equal(bc.classifyAlertCard(card('BRO-5', 'BSC Daily: X', '\\[conditionKey:health-check:Esc Row\\]')).row, 'Esc Row');
});

test('decideRecovered maps check exit codes', () => {
  assert.equal(bc.decideRecovered(0).action, 'close');
  assert.equal(bc.decideRecovered(1).reason, 'still-red');
  assert.equal(bc.decideRecovered(3).reason, 'cannot-verify');
  assert.equal(bc.decideRecovered(2).reason, 'check-error');
});

const LEDGER = { conditions: {
  'health-check:Recovered Row': { status: 'resolved', linearIdentifier: 'BRO-1' },
  'health-check:Still Red Row': { status: 'open', linearIdentifier: 'BRO-2' },
  'health-check:Cooled Row': { status: 'open', linearIdentifier: 'BRO-7' },
} };

test('ledgerSaysRecovered: resolved only; open, missing, other card and rollup refuse', () => {
  assert.equal(bc.ledgerSaysRecovered(LEDGER, 'BRO-1', 'health-check:Recovered Row').ok, true);
  assert.equal(bc.ledgerSaysRecovered(LEDGER, 'BRO-2', 'health-check:Still Red Row').reason, 'ledger-open');
  assert.equal(bc.ledgerSaysRecovered(LEDGER, 'BRO-9', 'health-check:Nope').reason, 'not-in-ledger');
  const released = { conditions: { k: { status: 'resolved', linearIdentifier: null } } };
  assert.equal(bc.ledgerSaysRecovered(released, 'BRO-5', 'k').reason, 'ledger-no-pointer');
  assert.equal(bc.ledgerSaysRecovered(LEDGER, 'BRO-8', 'health-check:Recovered Row').reason, 'ledger-other-card');
  const rollup = { conditions: { a: { status: 'resolved', linearIdentifier: 'BRO-1' }, b: { status: 'open', linearIdentifier: 'BRO-1' } } };
  assert.equal(bc.ledgerSaysRecovered(rollup, 'BRO-1', 'a').reason, 'rollup-has-open-condition');
});

async function runSweep(argv, deps) {
  const log = console.log; const lines = [];
  console.log = (m) => lines.push(String(m));
  try { await main(argv, deps); } finally { console.log = log; }
  return lines;
}

test('sweep with the real health-row check on 3 cards: dry-run, then apply', async () => {
  const closed = []; const released = [];
  // Cooled Row: ledger open AND absent from the snapshot (cooldown), must NOT close.
  const COOLED = card('BRO-7', 'BSC Daily: Cooled Row', '[conditionKey:health-check:Cooled Row]\n');
  const linear = { listOpenIssuesWithDescriptions: async () => [RECOVERED, RED, NOKEY, COOLED] };
  const deps = { linear, ledger: LEDGER, close: (id, c) => { closed.push([id, c]); return true; }, releaseTracker: (k, id) => { released.push([k, id]); return true; } };
  let lines = await runSweep(['--dry-run'], deps);
  assert.ok(lines.some((l) => l.includes('would close BRO-1')));
  assert.ok(!lines.some((l) => /BRO-2|BRO-3|BRO-7/.test(l.replace(/^\[sweep.*/, ''))));
  assert.ok(lines.at(-1).includes('"ledger-open":2') && lines.at(-1).includes('"no-condition-key":1'));
  assert.deepEqual(closed, []);
  lines = await runSweep(['--apply'], deps);
  assert.deepEqual(closed.map((c) => c[0]), ['BRO-1']);
  assert.match(closed[0][1], /NO-ROOT-CAUSE:/);
  assert.deepEqual(released, [['health-check:Recovered Row', 'BRO-1']]);
});

test('sweep kill switch', async () => {
  process.env.BOARD_CLOSER_KILL_SWITCH = '1';
  try { assert.equal(await main(['--apply'], {}), 0); } finally { delete process.env.BOARD_CLOSER_KILL_SWITCH; }
});

test('sweep exits 3 when Linear cannot be read', async () => {
  const linear = { listOpenIssuesWithDescriptions: async () => { throw new Error('boom'); } };
  const err = console.error; console.error = () => {};
  try { assert.equal(await main([], { linear, ledger: LEDGER }), 3); } finally { console.error = err; }
});

test('landBranchFromComments uses only the latest comment', () => {
  assert.equal(bc.landBranchFromComments([{ body: 'Landed via land/bro-9-x.' }, { body: 'land/old' }]), 'land/bro-9-x');
  assert.equal(bc.landBranchFromComments([{ body: 'no branch' }, { body: 'land/old' }]), null);
  assert.equal(bc.landBranchFromComments([]), null);
});

test('decideLanded: live, not live, not landed, no branch', () => {
  const rows = [{ branch: 'land/a', sha: 'a'.repeat(40) }, { branch: 'land/a', sha: 'b'.repeat(40) }];
  const landing = bc.landingForBranch(rows, 'land/a');
  assert.equal(landing.sha, 'b'.repeat(40));
  const dated = [{ branch: 'land/a', sha: 'c'.repeat(40), ts: '2026-01-01T00:00:00Z' }];
  assert.equal(bc.landingForBranch(dated, 'land/a', Date.parse('2026-02-01T00:00:00Z')), null, 'much older landing is ignored');
  // land, then comment "landed via land/a" 2h later, then the session died: must still match
  const commentMs = Date.parse('2026-01-01T02:00:00Z');
  assert.equal(bc.landingForBranch(dated, 'land/a', commentMs - bc.LANDING_SLACK_MS).sha, 'c'.repeat(40));
  const i = card('BRO-6', 't', '');
  assert.equal(bc.decideLanded(i, { branch: 'land/a', landing, liveExit: 0 }).action, 'close');
  assert.equal(bc.decideLanded(i, { branch: 'land/a', landing, liveExit: 1 }).reason, 'landed-not-live');
  assert.equal(bc.decideLanded(i, { branch: 'land/z', landing: null, liveExit: null }).reason, 'not-landed');
  assert.equal(bc.decideLanded(i, { branch: null, landing: null, liveExit: null }).reason, 'no-land-branch');
  assert.match(bc.landedComment('land/a', landing.sha), /^PR-EVIDENCE: merged deployed checked \(https:\/\/github\.com\/thomaspryor\/Broadwayscore\/commit\/b{40}\)$/m);
});

test('sweep --landed dry-run with 3 cards (live, not live, no branch)', async () => {
  const sha = (c) => c.repeat(40);
  const open = [card('BRO-10', 't', ''), card('BRO-11', 't', ''), card('BRO-12', 't', '')];
  const comments = new Map([
    ['BRO-10', [{ body: 'land/live', createdAt: '2026-01-02T00:00:00Z' }]], ['BRO-11', [{ body: 'land/pending', createdAt: '2026-01-02T00:00:00Z' }]], ['BRO-12', [{ body: 'nothing' }]],
  ]);
  const linear = { listOpenIssuesWithDescriptions: async () => open, listIssueComments: async () => comments };
  const log = console.log; const lines = [];
  console.log = (m) => lines.push(String(m));
  try {
    await main(['--landed'], {
      linear, ledger: LEDGER,
      readLandings: () => [{ branch: 'land/live', sha: sha('1'), ts: '2026-01-03T00:00:00Z' }, { branch: 'land/pending', sha: sha('2'), ts: '2026-01-03T00:00:00Z' }],
      prodExit: (s) => (s === sha('1') ? 0 : 1),
    });
  } finally { console.log = log; }
  assert.ok(lines.some((l) => l.includes('would close BRO-10')));
  assert.ok(!lines.some((l) => l.includes('BRO-11') || l.includes('BRO-12')));
  assert.ok(lines.at(-1).includes('"landed:landed-not-live":1'));
});

test('sweep --landed with the REAL landings reader does not throw (regression: reader returns {available, rows})', async () => {
  const linear = {
    listOpenIssuesWithDescriptions: async () => [card('BRO-20', 't', '')],
    listIssueComments: async () => new Map([['BRO-20', [{ body: 'land/does-not-exist-xyz', createdAt: '2026-01-01T00:00:00Z' }]]]),
  };
  const lines = await runSweep(['--landed'], { linear, ledger: LEDGER });
  assert.ok(lines.at(-1).includes('"landed:not-landed":1'));
});
