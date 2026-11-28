import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseWorkspaceListing, resolveWorkspaceForTask } = require('./dispatched-workspace-lookup.js');

test('parseWorkspaceListing parses refs, titles, and the selected marker', () => {
  const text = [
    '  workspace:1  ✳ Write AI musical comedy for Edinburgh Fringe',
    '* workspace:463  ◑ Identify and prioritize P0 backlog items  [selected]',
    '  workspace:465  🤖⚡ Infra·P1: no way for a session to identify/message a dis',
    '',
    'not a workspace line',
  ].join('\n');
  const rows = parseWorkspaceListing(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { ref: 'workspace:1', title: '✳ Write AI musical comedy for Edinburgh Fringe', selected: false });
  assert.equal(rows[1].ref, 'workspace:463');
  assert.equal(rows[1].selected, true);
  assert.equal(rows[1].title, '◑ Identify and prioritize P0 backlog items');
});

test('resolveWorkspaceForTask: primary path finds the open ledger launch confirmed live', () => {
  const entries = [
    { event: 'launch', taskId: '1464', workspaceRef: 'workspace:461', subject: 'P0: Playbill Verdict category-page scraper only sees ~27 of 100+ articles' },
  ];
  const live = [
    { ref: 'workspace:461', title: '🤖⚡ Data·P0: Playbill Verdict category-page scraper only se' },
    { ref: 'workspace:463', title: 'unrelated' },
  ];
  const resolved = resolveWorkspaceForTask('1464', entries, live);
  assert.deepEqual(resolved, { ref: 'workspace:461', title: '🤖⚡ Data·P0: Playbill Verdict category-page scraper only se', source: 'ledger' });
});

test('resolveWorkspaceForTask: numeric taskId matches string ledger taskId', () => {
  const entries = [
    { event: 'launch', taskId: '1464', workspaceRef: 'workspace:461', subject: 'P0: Playbill Verdict category-page scraper only sees ~27 of 100+ articles' },
  ];
  const live = [{ ref: 'workspace:461', title: 'Data·P0: Playbill Verdict category-page scraper only se' }];
  assert.ok(resolveWorkspaceForTask(1464, entries, live));
});

test('resolveWorkspaceForTask: dead-workspace fallback matches on title when the ledger ref is gone', () => {
  const entries = [
    { event: 'launch', taskId: '1464', workspaceRef: 'workspace:461', subject: 'P0: Playbill Verdict category-page scraper only sees ~27 of 100+ articles' },
  ];
  // cmux restarted and renumbered workspace:461 -> workspace:900; the ref is
  // gone from the live listing but the title still carries the launch subject.
  const live = [
    { ref: 'workspace:900', title: '🤖⚡ Data·P0: Playbill Verdict category-page scraper only se' },
    { ref: 'workspace:463', title: 'unrelated' },
  ];
  const resolved = resolveWorkspaceForTask('1464', entries, live);
  assert.deepEqual(resolved, { ref: 'workspace:900', title: '🤖⚡ Data·P0: Playbill Verdict category-page scraper only se', source: 'title-fallback' });
});

test('resolveWorkspaceForTask: returns null when neither the ref nor a title match is live', () => {
  const entries = [
    { event: 'launch', taskId: '1464', workspaceRef: 'workspace:461', subject: 'P0: Playbill Verdict category-page scraper only sees ~27 of 100+ articles' },
  ];
  const live = [{ ref: 'workspace:463', title: 'totally unrelated tab' }];
  assert.equal(resolveWorkspaceForTask('1464', entries, live), null);
});

test('resolveWorkspaceForTask: returns null when the task has no open ledger launch at all', () => {
  const entries = [
    { event: 'launch', taskId: '1464', workspaceRef: 'workspace:461', subject: 'x', ts: '2026-08-14T00:00:00.000Z' },
    { event: 'dead', taskId: '1464', workspaceRef: 'workspace:461', ts: '2026-08-14T00:05:00.000Z' },
  ];
  const live = [{ ref: 'workspace:461', title: 'x' }];
  assert.equal(resolveWorkspaceForTask('1464', entries, live), null);
});

test('resolveWorkspaceForTask: returns null for an unknown taskId', () => {
  const entries = [{ event: 'launch', taskId: '1464', workspaceRef: 'workspace:461', subject: 'x' }];
  assert.equal(resolveWorkspaceForTask('9999', entries, []), null);
});
