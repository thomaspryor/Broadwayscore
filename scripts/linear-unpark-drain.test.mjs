// BRO-5626: linear-unpark-drain.js moves only takeable parked cards, rewrites
// their PARKED lines, comments, honours --cap, and writes nothing on a dry run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { main } = require('./linear-unpark-drain.js');

const VERIFY = '\n\nVERIFY: `node --test scripts/lib/linear-drain-parked.test.mjs`\n';
const card = (n, description, extra = {}) => ({
  id: `uuid-${n}`, identifier: `BRO-${n}`, title: `t${n}`, priority: 3,
  state: { name: 'Backlog', type: 'backlog' }, description, updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

function fakeLinear(issues) {
  const writes = [];
  return {
    writes,
    listOpenIssuesWithDescriptions: async () => issues,
    getIssue: async (id) => {
      const i = issues.find((x) => x.identifier === id);
      return i && { ...i, comments: { nodes: i.commentNodes || [] } };
    },
    getTeam: async () => ({ states: { nodes: [{ id: 's-backlog', name: 'Backlog', type: 'backlog' }, { id: 's-todo', name: 'Todo', type: 'unstarted' }] } }),
    updateIssue: async (id, input) => { writes.push({ kind: 'update', id, input }); },
    createComment: async (id, body) => { writes.push({ kind: 'comment', id, body }); },
  };
}

const ISSUES = () => [
  card(1, `PARKED: triaged from retired Notion backlog (BRO-5297)${VERIFY}`),
  card(2, `PARKED: waiting on the owner's call${VERIFY}`),
  card(3, 'PARKED: needs its own session'),
  // VERIFY only in a comment: the list read can't see it, the full read can.
  card(4, 'PARKED: needs its own session', { priority: 2, commentNodes: [{ body: 'VERIFY: `npx tsc --noEmit`', createdAt: '2026-10-02T00:00:00Z' }] }),
  card(5, `no park line${VERIFY}`),
];

test('dry run selects takeable cards, highest priority first, and writes nothing', async () => {
  const linear = fakeLinear(ISSUES());
  const s = await main(['--json'], { linear });
  assert.equal(s.mode, 'dry-run');
  assert.equal(s.eligible, 2);
  assert.equal(s.parkedSeen, 4);
  assert.equal(s.skipped['real-park-reason'], 1);
  assert.equal(s.skipped['no-safe-verify'], 1);
  assert.deepEqual(linear.writes, []);
});

test('--apply moves to Todo, rewrites PARKED lines, comments, and honours --cap', async () => {
  const linear = fakeLinear(ISSUES());
  const s = await main(['--apply', '--cap', '1', '--json'], { linear });
  assert.equal(s.moved, 1);
  const [upd, comment] = linear.writes;
  assert.equal(upd.id, 'uuid-4');
  assert.equal(upd.input.stateId, 's-todo');
  assert.doesNotMatch(upd.input.description, /^\s*PARKED\s*:/im);
  assert.match(upd.input.description, /^UNPARKED \(BRO-5626 drain \d{4}-\d{2}-\d{2}\): needs its own session/m);
  assert.equal(comment.id, 'uuid-4');
  assert.match(comment.body, /> needs its own session/);
});

test('a parked Todo card keeps its state and only loses the PARKED line', async () => {
  const linear = fakeLinear([card(7, `PARKED: needs its own session${VERIFY}`, { state: { name: 'Todo', type: 'unstarted' } })]);
  await main(['--apply', '--json'], { linear });
  assert.equal(linear.writes[0].input.stateId, undefined);
});

test('kill switch does nothing', async () => {
  const linear = fakeLinear(ISSUES());
  for (const v of ['1', 'true', 'YES']) {
    process.env.LINEAR_UNPARK_DRAIN_DISABLED = v;
    try { assert.equal(await main(['--apply'], { linear }), null); } finally { delete process.env.LINEAR_UNPARK_DRAIN_DISABLED; }
  }
  assert.deepEqual(linear.writes, []);
});

test('a card changed between the read and the write is left alone', async () => {
  const issues = [card(8, `PARKED: needs its own session${VERIFY}`)];
  const linear = fakeLinear(issues);
  let reads = 0;
  const base = linear.getIssue;
  linear.getIssue = async (id) => {
    reads += 1;
    const i = await base(id);
    // Second read (just before writing): a session re-parked it with an owner hold.
    return reads > 1 ? { ...i, description: `PARKED: waiting on the owner${VERIFY}` } : i;
  };
  const s = await main(['--apply', '--json'], { linear });
  assert.equal(s.moved, 0);
  assert.equal(s.skipped['changed-since-read'], 1);
  assert.deepEqual(linear.writes, []);
});

test('--apply stops reading cards once it has --cap of them', async () => {
  const issues = [10, 11, 12, 13].map((n) => card(n, `PARKED: needs its own session${VERIFY}`));
  const linear = fakeLinear(issues);
  const seen = [];
  const base = linear.getIssue;
  linear.getIssue = async (id) => { seen.push(id); return base(id); };
  await main(['--apply', '--cap', '1', '--json'], { linear });
  // One selection read plus one re-read before the write.
  assert.deepEqual(seen, ['BRO-10', 'BRO-10']);
});

test('a moved card whose comment fails is reported as moved and failed', async () => {
  const linear = fakeLinear([card(9, `PARKED: needs its own session${VERIFY}`)]);
  linear.createComment = async () => { throw new Error('rate limited'); };
  const s = await main(['--apply', '--json'], { linear });
  assert.equal(s.moved, 1);
  assert.deepEqual(s.failed, ['BRO-9']);
  process.exitCode = 0;
});
