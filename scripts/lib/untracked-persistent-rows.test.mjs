// BRO-5168: advisory tripwire for visitor-facing rows red for days with no open card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findUntrackedPersistentRows, untrackedPersistentRowsResult, issueTracksRow } = require('./untracked-persistent-rows.js');

const NOW = Date.parse('2026-10-12T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const cond = (over) => ({ status: 'open', firstSeen: ago(2000), incidentOpenedAt: ago(200), lastSeen: ago(3), ...over });

const ledger = {
  conditions: {
    'health-check:Quality: corpus drift': cond({ linearIdentifier: 'BRO-3081' }), // tracker closed
    'health-check:Sync: cast coverage': cond({ linearIdentifier: 'BRO-4171' }), // tracker open
    'health-check:Data: stale rows': cond({}), // folded card covers it
    'health-check:Data: young row': cond({ incidentOpenedAt: ago(50) }),
    'health-check:Data: gone quiet': cond({ lastSeen: ago(60) }),
    'health-check:Data: resolved': cond({ status: 'resolved' }),
    'health-check:Stuck work: paused P0/P1 cards': cond({}), // internal
    'health-check:Credits: ScrapingBee': cond({}), // owner money
    'test-yml:red:x': cond({}), // not a health row
    'health-check:Data: by body': cond({}),
  },
};
const open = [
  { identifier: 'BRO-4171', title: 'something else' },
  { identifier: 'BRO-7', title: 'BSC Daily: Data: stale (batch 2)' },
  { identifier: 'BRO-8', title: 'Fix: BSC Daily: Data: stale rows' },
  { identifier: 'BRO-9', title: 'Unrelated', description: 'condition: health-check:Data: by body' },
];

test('findUntrackedPersistentRows: only open, still-red, 96h+ visitor rows with no open tracker', () => {
  const got = findUntrackedPersistentRows(ledger, open, NOW);
  assert.deepEqual(got.map((r) => r.name), ['Quality: corpus drift']);
  assert.equal(got[0].staleIdentifier, 'BRO-3081');
});

test('issueTracksRow: folded "<condition>" card covers "<condition> on <show>"', () => {
  const issue = { identifier: 'BRO-1', title: 'BSC Daily: Data: missing poster' };
  assert.equal(issueTracksRow(issue, { name: 'Data: missing poster on Hamilton', conditionKey: 'k' }), true);
  assert.equal(issueTracksRow(issue, { name: 'Data: missing posterior', conditionKey: 'k' }), false);
});

test('untrackedPersistentRowsResult: warn with the list, pass when clean, warn unmeasurable when Linear fails', async () => {
  const warn = await untrackedPersistentRowsResult({ ledger, listOpenIssues: async () => open, nowMs: NOW });
  assert.equal(warn.status, 'warn');
  assert.match(warn.message, /Quality: corpus drift \(\d+d, BRO-3081 closed\)/);
  const pass = await untrackedPersistentRowsResult({ ledger: { conditions: {} }, listOpenIssues: async () => [], nowMs: NOW });
  assert.equal(pass.status, 'pass');
  const down = await untrackedPersistentRowsResult({ ledger, listOpenIssues: async () => { throw new Error('down'); }, nowMs: NOW });
  assert.equal(down.status, 'warn');
  assert.match(down.message, /^Unmeasurable/);
});

test('untrackedPersistentRowsResult: a tracker closed as a duplicate of an open card still counts as tracked', async () => {
  const issues = {
    'BRO-3081': { state: { type: 'duplicate' }, relations: { nodes: [{ type: 'duplicate', relatedIssue: { identifier: 'BRO-3065' } }] } },
    'BRO-3065': { state: { type: 'unstarted' } },
  };
  const r = await untrackedPersistentRowsResult({ ledger, listOpenIssues: async () => open, getIssue: async (id) => issues[id], nowMs: NOW });
  assert.equal(r.status, 'pass');
  issues['BRO-3065'] = { state: { type: 'completed' } };
  const r2 = await untrackedPersistentRowsResult({ ledger, listOpenIssues: async () => open, getIssue: async (id) => issues[id], nowMs: NOW });
  assert.equal(r2.status, 'warn');
});
