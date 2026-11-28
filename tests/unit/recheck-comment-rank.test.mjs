import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectRecheckTargets } = require('../../scripts/lib/autonomous-recheck-core.js');
const { mapIssueToCard } = require('../../scripts/lib/linear-recheck-source.js');
const { extractVerifyCmd, rank } = require('../../scripts/lib/autonomous-verify-cmd.js');
const { isSafeCheckCommand } = require('../../scripts/lib/check-paths.js');

const A = 'tests/unit/a.test.mjs';
const B = 'tests/unit/b.test.mjs';
const C = 'tests/unit/c.test.mjs';
const audit = 'node scripts/audit-orphan-tests.js';
const dispatched = '2026-10-14T12:00:00Z';
const later = '2026-10-15T12:00:00Z';
const earlier = '2026-10-13T12:00:00Z';
const comment = (cmd, createdAt = later) => ({ body: `VERIFY: ${cmd}`, createdAt });

function recheck(snapshot, comments, launches = [{ ts: dispatched, verifyCmd: snapshot }]) {
  const card = mapIssueToCard({
    identifier: 'BRO-3461', title: 'Comment corrections', state: { type: 'completed' },
    completedAt: later, updatedAt: later, comments: { nodes: comments },
  });
  return selectRecheckTargets({
    doneCards: [card], now: Date.parse(later),
    launchEntries: launches.map(l => ({ event: 'launch', linearId: card.id, ...l })),
  })[0].verifyCmd;
}

test('a correction cannot drop or substitute files in a multi-file snapshot', () => {
  const snapshot = `node --test ${A} ${B}`;
  for (const cmd of [`node --test ${A}`, `node --test ${A} ${C}`, audit, `node --test ${A} ${A}`]) {
    assert.equal(recheck(snapshot, [comment(cmd)]), snapshot, cmd);
  }
});

test('a reordered superset and a tsx superset preserve coverage', () => {
  for (const cmd of [`node --test ${B} ${A} ${C}`, `npx tsx --test ${B} ${A} ${C}`]) {
    assert.equal(recheck(`node --test ${A} ${B}`, [comment(cmd)]), cmd);
  }
});

test('safe behavioral scripts outrank existence and generic checks in both callers', () => {
  for (const script of [audit, 'node scripts/check-coverage-probe-clean.js', 'node scripts/validate-data.js --strict']) {
    assert.ok(isSafeCheckCommand(script));
    assert.ok(rank(script) < rank('test -f scripts/audit-orphan-tests.js'));
    assert.equal(recheck(script, [comment('test -f scripts/audit-orphan-tests.js')]), script);
    assert.equal(extractVerifyCmd(`VERIFY: test -f scripts/audit-orphan-tests.js\nVERIFY: ${script}`, isSafeCheckCommand).cmd, script);
  }
});

test('within-document selection prefers broader test coverage regardless of order', () => {
  const broad = `node --test ${A} ${B}`;
  for (const commands of [[`node --test ${A}`, broad], [broad, `node --test ${A}`]]) {
    assert.equal(extractVerifyCmd(commands.map(c => `VERIFY: ${c}`).join('\n'), isSafeCheckCommand).cmd, broad);
    assert.equal(recheck(`node --test ${A}`, [{ body: commands.map(c => `VERIFY: ${c}`).join('\n'), createdAt: later }]), broad);
  }
});

test('corrections must be strictly after the winning redispatch', () => {
  const snapshot = `node --test ${A}`;
  for (const createdAt of [earlier, dispatched, undefined, 'invalid']) {
    assert.equal(recheck(snapshot, [{ body: `VERIFY: node --test ${B}`, createdAt }], [
      { ts: dispatched, verifyCmd: snapshot }, { ts: '2026-10-12T12:00:00Z', verifyCmd: `node --test ${C}` },
    ]), snapshot);
  }
  assert.equal(recheck(snapshot, [comment(`node --test ${B}`)]), `node --test ${B}`);
});

test('missing or invalid launch time cannot authorize a snapshot correction', () => {
  for (const ts of [undefined, 'invalid']) {
    assert.equal(recheck(audit, [comment(`node --test ${A}`)], [{ verifyCmd: audit, ts }]), audit);
  }
});

test('newest at the best specificity wins, independent of API order', () => {
  const oldest = comment(`node --test ${A}`, '2026-10-14T13:00:00Z');
  const newest = comment(`node --test ${B}`, '2026-10-14T14:00:00Z');
  for (const comments of [[newest, oldest, comment('test -f docs/check.md')], [oldest, newest]]) {
    assert.equal(recheck('npx tsc --noEmit', comments), `node --test ${B}`);
  }
});

test('unsafe corrections stay refused and an invalid newer candidate does not hide an older correction', () => {
  const snapshot = `node --test ${A} ${B}`;
  const broad = `node --test ${A} ${B} ${C}`;
  assert.equal(recheck(snapshot, [comment(broad, '2026-10-14T13:00:00Z'), comment(`node --test ${A}`)]), broad);
  assert.equal(recheck(snapshot, [comment('node scripts/rebuild-all-reviews.js')]), snapshot);
});

test('Linear mapping preserves timestamps without changing text-only comment consumers', () => {
  const nodes = [comment(audit), comment(`node --test ${A}`, earlier)];
  const card = mapIssueToCard({ identifier: 'BRO-3461', comments: { nodes } });
  assert.deepEqual(card.comments, [nodes[1].body, nodes[0].body]);
  assert.deepEqual(card.commentRecords, [nodes[1], nodes[0]]);
  assert.equal(nodes[0].createdAt, later, 'mapping does not mutate the API payload');
});

test('an explicit correction wins over quoted context before or after it', () => {
  const cmd = `node --test ${B}`;
  for (const lines of [
    [`VERIFY (correction): ${cmd}`, `Do not use the old command:\nVERIFY: node --test ${A}`],
    [`Old command:\nVERIFY: node --test ${A}`, `VERIFY (correction): ${cmd}`],
  ]) {
    const body = lines.join('\n');
    assert.equal(recheck(`node --test ${A}`, [{ body, createdAt: later }]), cmd);
    assert.equal(extractVerifyCmd(body, isSafeCheckCommand).cmd, cmd);
  }
});

test('an explicit correction cannot bypass safety, freshness, or coverage', () => {
  const snapshot = `node --test ${A} ${B}`;
  for (const [cmd, createdAt] of [
    ['node scripts/rebuild-all-reviews.js', later],
    [`node --test ${C}`, later],
    [`node --test ${A} ${B} ${C}`, earlier],
  ]) {
    assert.equal(recheck(snapshot, [{ body: `VERIFY (correction): ${cmd}`, createdAt }]), snapshot);
  }
});

test('legacy string comments with no timestamps cannot override a launch', () => {
  const result = selectRecheckTargets({
    doneCards: [{ id: 'BRO-3461', status: 'Done', ageDays: 0, comments: [`VERIFY: node --test ${B}`] }],
    launchEntries: [{ event: 'launch', linearId: 'BRO-3461', ts: dispatched, verifyCmd: `node --test ${A}` }],
  });
  assert.equal(result[0].verifyCmd, `node --test ${A}`);
});
