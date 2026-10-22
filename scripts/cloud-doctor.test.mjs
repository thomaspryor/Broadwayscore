// BRO-5892: cloud-doctor.js decides pass/warn/fail and which repairs to run from gathered facts.
// require()s the real evaluate()/plannedFixes() (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluate, plannedFixes, snapshotChanges, STALE_FAIL_HOURS } = require('./cloud-doctor.js');

const NOW = Date.parse('2026-10-22T04:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3.6e6).toISOString();
const clone = (over = {}) => ({ dir: '/c', head: 'a'.repeat(40), remoteHead: 'a'.repeat(40), date: hoursAgo(0.2), ...over });

function healthy(over = {}) {
  return {
    cloud: true, root: '/w', main: '/m',
    coreClone: clone(), reviewClone: clone({ head: 'b'.repeat(40), remoteHead: 'b'.repeat(40) }),
    showsJson: true, coreSymlink: false, coreCopySha: 'a'.repeat(40),
    reviewCopySha: 'b'.repeat(40), reviewCopyIsCheckout: false, resolvedReviewTexts: '/w/data/review-texts',
    deps: { 'next/package.json': true, cheerio: true, 'typescript/package.json': true },
    ghPush: true, fixWorkflowState: 'active', secretsOk: true, hooks: { ok: true, detail: 'OK' },
    ...over,
  };
}
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));

test('a healthy session passes every check and plans no repairs', () => {
  const rs = evaluate(healthy(), { now: NOW });
  assert.deepEqual(rs.filter((r) => r.level !== 'ok'), []);
  assert.deepEqual(plannedFixes(rs), []);
});

test('a clone a little behind origin warns; one older than the limit fails', () => {
  const behind = byId(evaluate(healthy({ coreClone: clone({ remoteHead: 'c'.repeat(40) }) }), { now: NOW }));
  assert.equal(behind['core-clone'].level, 'warn');
  const old = byId(evaluate(healthy({ coreClone: clone({ remoteHead: 'c'.repeat(40), date: hoursAgo(STALE_FAIL_HOURS + 1) }) }), { now: NOW }));
  assert.equal(old['core-clone'].level, 'fail');
  assert.equal(old['core-clone'].fix, 'refresh-clones');
});

test('copies behind their clone warn and plan clone refresh before the copy', () => {
  const rs = evaluate(healthy({
    coreClone: clone({ remoteHead: 'c'.repeat(40) }),
    coreCopySha: 'd'.repeat(40), reviewCopySha: 'e'.repeat(40),
  }), { now: NOW });
  const r = byId(rs);
  assert.equal(r['core-copy'].level, 'warn');
  assert.equal(r['review-copy'].level, 'warn');
  assert.deepEqual(plannedFixes(rs), ['refresh-clones', 'copy-data', 'copy-review-texts']);
});

test('missing data, unresolvable review texts, a partial install and no push access fail', () => {
  const r = byId(evaluate(healthy({
    showsJson: false, reviewCopySha: null, resolvedReviewTexts: null,
    deps: { 'next/package.json': false, cheerio: true, 'typescript/package.json': true }, ghPush: false,
  }), { now: NOW }));
  for (const id of ['core-copy', 'review-copy', 'review-resolver', 'node-modules', 'github']) assert.equal(r[id].level, 'fail', id);
  assert.match(r['node-modules'].detail, /next/);
  assert.equal(r['node-modules'].fix, 'npm-ci');
});

test('a git checkout or symlinked core data counts as current', () => {
  const r = byId(evaluate(healthy({ coreSymlink: true, coreCopySha: null, reviewCopyIsCheckout: true, reviewCopySha: null }), { now: NOW }));
  assert.equal(r['core-copy'].level, 'ok');
  assert.equal(r['review-copy'].level, 'ok');
});

test('an audit that dirties the tree fails; the check is absent under --quick', () => {
  assert.equal(byId(evaluate(healthy(), { now: NOW }))['audit-tree-clean'], undefined);
  const r = byId(evaluate(healthy({ auditTreeClean: { clean: false, changed: [' M data/audit/x.json'], exit: 0 } }), { now: NOW }));
  assert.equal(r['audit-tree-clean'].level, 'fail');
  assert.match(r['audit-tree-clean'].detail, /data\/audit\/x\.json/);
});

test('outside cloud a missing clone only warns', () => {
  const r = byId(evaluate(healthy({ cloud: false, reviewClone: null }), { now: NOW }));
  assert.equal(r['review-clone'].level, 'warn');
});

test('a clone refresh also redoes both copies, since it moves the clones', () => {
  const rs = evaluate(healthy({ reviewClone: clone({ head: 'b'.repeat(40), remoteHead: 'f'.repeat(40) }) }), { now: NOW });
  assert.deepEqual(plannedFixes(rs), ['refresh-clones', 'copy-data', 'copy-review-texts']);
});

test('snapshotChanges reports rewritten, added and removed data files (gitignored core copies included)', () => {
  const before = new Map([['data/shows.json', '10:1'], ['data/x.json', '5:1'], ['data/gone.json', '1:1']]);
  const after = new Map([['data/shows.json', '10:2'], ['data/x.json', '5:1'], ['data/new.json', '1:1']]);
  assert.deepEqual(snapshotChanges(before, after), ['data/gone.json', 'data/new.json', 'data/shows.json']);
  assert.deepEqual(snapshotChanges(before, new Map(before)), []);
});
