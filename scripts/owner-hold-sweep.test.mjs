// BRO-6852: the sweep CLI against a fake Linear client. Real main(), real planner, nothing copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { main } = require('./owner-hold-sweep.js');
const bc = require('./lib/board-categories.js');

const NOW = new Date('2026-11-02T12:00:00Z');
const VERIFY = '## Acceptance criteria\nVERIFY: node --test scripts/lib/foo.test.mjs';
const mk = (n, parked, over = {}) => ({
  id: `uuid-${n}`, identifier: `BRO-${n}`, title: `Card ${n}`, priority: 3, url: `u${n}`,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  state: { name: 'Backlog', type: 'backlog' }, labels: { nodes: [] }, comments: { nodes: [] },
  description: `PARKED: ${parked}\n\n${VERIFY}`, ...over,
});

function fake(issues) {
  const log = { updates: [], comments: [] };
  const byId = new Map(issues.map((i) => [i.identifier, i]));
  return {
    log,
    graphql: async () => ({ issues: { nodes: issues, pageInfo: { hasNextPage: false } } }),
    getIssue: async (id) => byId.get(id),
    getTeam: async () => ({ states: { nodes: [{ id: 's-todo', name: 'Todo', type: 'unstarted' }] } }),
    updateIssue: async (id, input) => { log.updates.push({ id, input }); },
    createComment: async (id, body) => { log.comments.push({ id, body }); },
  };
}
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };

test('dry run writes nothing; apply releases, asks, and leaves the board rows empty', async () => {
  const q = 'DECISION NEEDED: Renew the cookie?\nWhy this is your call: only you have the login.\nOwner step 1: Log in.';
  const release = mk(1, 'needs owner judgment on the wording');
  const ask = mk(2, 'owner has to log in and renew the cookie');
  const issues = [release, ask];
  const dry = fake(issues);
  const d = await quiet(() => main(['--json'], { linear: dry, graphql: dry.graphql, now: NOW }));
  assert.equal(d.summary.release, 1);
  assert.equal(d.summary.needsQuestion, 1);
  assert.equal(dry.log.updates.length, 0);

  const fs = require('fs'); const os = require('os'); const path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-')), 'q.json');
  fs.writeFileSync(file, JSON.stringify({ 'BRO-2': q }));
  const live = fake(issues);
  const r = await quiet(() => main(['--apply', '--json', '--questions', file], { linear: live, graphql: live.graphql, now: NOW }));
  assert.deepEqual(r.summary.done.released, ['BRO-1']);
  assert.deepEqual(r.summary.done.asked, ['BRO-2']);
  const up = Object.fromEntries(live.log.updates.map((u) => [u.id, u.input]));
  assert.equal(up['uuid-1'].stateId, 's-todo');
  assert.ok(!/^\s*PARKED:/im.test(up['uuid-1'].description));
  assert.match(live.log.comments.find((c) => c.id === 'uuid-1').body, /^OWNER-CLEARED:/);
  assert.match(up['uuid-2'].description, /DECISION NEEDED: Renew the cookie/);

  // After the writes, neither card is in a hold row.
  const after = [{ ...release, description: up['uuid-1'].description, state: { name: 'Todo', type: 'unstarted' }, comments: { nodes: [{ body: live.log.comments[0].body, createdAt: NOW.toISOString() }] } },
    { ...ask, description: up['uuid-2'].description }];
  const rep = bc.categorizeBoard(after, { now: NOW });
  const row = (k) => rep.categories.find((c) => c.key === k).exclusive;
  assert.equal(row('parked-owner-wording') + row('owner-gated-no-question'), 0);
});

test('a card edited after the read is left alone', async () => {
  const c = mk(3, 'needs owner judgment on the wording');
  const f = fake([c]);
  const read = f.getIssue;
  f.getIssue = async (id) => ({ ...(await read(id)), description: `${c.description}\nedited` });
  const r = await quiet(() => main(['--apply', '--json'], { linear: f, graphql: f.graphql, now: NOW }));
  assert.deepEqual(r.summary.done.changed, ['BRO-3']);
  assert.equal(f.log.updates.length, 0);
});
