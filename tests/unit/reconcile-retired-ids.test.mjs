// Reconcile honours retired ids (2026 data audit, S0-T4).
//
// push-core-data's post-rebase reconciliation re-adds a show that is on
// remote but not local when the base snapshot also lacks it ("a concurrent
// job added it"). Once a deleting run has pushed, EVERY later job's base
// lacks the id too, so a stale writer still carrying the row would read as a
// genuine add and resurrect it. The retired registry closes that hole.
//
// Requires the real module (CLAUDE.md §15) and asserts the action.yml passes
// the retired list through — a module that honours the list is useless if
// the action never hands it one.
//
// Run: node --test tests/unit/reconcile-retired-ids.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const { reconcileShowsJson } = require(join(ROOT, 'scripts/lib/reconcile-shows-fields.js'));

const S = (id, extra = {}) => ({ id, title: id, ...extra });
const X = 'tabdates-off-west-end-2026';

test('remote has X, base lacks it, X retired: NOT re-added, counted as retiredSkipped', () => {
  const local = { shows: [S('hamilton')] };
  const remote = { shows: [S('hamilton'), S(X)] };
  const base = { shows: [S('hamilton')] };

  const r = reconcileShowsJson(local, remote, base, undefined, new Set([X]));

  assert.deepEqual(local.shows.map((s) => s.id), ['hamilton'], 'retired id must stay gone');
  assert.equal(r.readded, 0);
  assert.equal(r.retiredSkipped, 1);
  assert.equal(r.baseAvailable, true);
});

test('same shape without retirement: re-added (existing concurrent-add behaviour is untouched)', () => {
  const local = { shows: [S('hamilton')] };
  const remote = { shows: [S('hamilton'), S(X)] };
  const base = { shows: [S('hamilton')] };

  const r = reconcileShowsJson(local, remote, base, undefined, new Set());

  assert.deepEqual(local.shows.map((s) => s.id), ['hamilton', X]);
  assert.equal(r.readded, 1);
  assert.equal(r.retiredSkipped, 0);
});

test('local delete with base having the id: stays deleted (and is not counted as retired)', () => {
  const local = { shows: [S('hamilton')] };
  const remote = { shows: [S('hamilton'), S('bad-dupe')] };
  const base = { shows: [S('hamilton'), S('bad-dupe')] };

  const r = reconcileShowsJson(local, remote, base, undefined, new Set([X]));

  assert.deepEqual(local.shows.map((s) => s.id), ['hamilton']);
  assert.equal(r.readded, 0);
  assert.equal(r.retiredSkipped, 0);
});

test('retiredIds accepts an array as well as a Set; a retired id is refused even with NO base', () => {
  const local = { shows: [S('hamilton')] };
  const remote = { shows: [S('hamilton'), S(X), S('mystery')] };

  const r = reconcileShowsJson(local, remote, null, undefined, [X]);

  assert.deepEqual(local.shows.map((s) => s.id), ['hamilton']);
  assert.equal(r.retiredSkipped, 1, 'the retired one is counted');
  assert.equal(r.readded, 0, 'no base: the unknown one is conservatively not re-added (unchanged)');
  assert.equal(r.baseAvailable, false);
});

test('a retired id that IS present locally is left alone here (field reconcile still runs) — resurrection warnings are validate-data\'s job', () => {
  const local = { shows: [S(X, { venue: null })] };
  const remote = { shows: [S(X, { venue: 'Southwark Playhouse' })] };
  const base = { shows: [S(X, { venue: null })] };

  const r = reconcileShowsJson(local, remote, base, undefined, new Set([X]));

  assert.equal(local.shows.length, 1);
  assert.equal(local.shows[0].venue, 'Southwark Playhouse');
  assert.equal(r.recovered, 1);
  assert.equal(r.retiredSkipped, 0);
});

test('reconciliation requires an injected registry and fails before mutating local when it is omitted', () => {
  const local = {};
  for (const retiredIds of [undefined, null]) {
    assert.throws(() => reconcileShowsJson(local, { shows: [S(X)] }, { shows: [] }, undefined, retiredIds),
      /retiredIds must be a Set or an array/);
    assert.deepEqual(local, {}, 'invalid registry input must not mutate local');
  }
});

test('injected reconciliation never reads the filesystem', t => {
  const read = t.mock.method(require('node:fs'), 'readFileSync', () => {
    throw new Error('reconciliation must not read disk');
  });
  const local = { shows: [] };
  const result = reconcileShowsJson(local, { shows: [S(X), S('genuine-add')] }, { shows: [] }, undefined, [X]);
  assert.equal(result.retiredSkipped, 1);
  assert.equal(result.readded, 1);
  assert.equal(read.mock.callCount(), 0);
});

test('a bad retiredIds type is a loud TypeError, not a silent empty set', () => {
  assert.throws(() => reconcileShowsJson({ shows: [] }, { shows: [] }, null, undefined, 'not-a-set'), TypeError);
});

test('push-core-data/action.yml hands the checkout\'s retired list to reconcileShowsJson and syncs both registry files', () => {
  const yaml = readFileSync(join(ROOT, '.github/actions/push-core-data/action.yml'), 'utf8');
  const code = yaml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  // The inline node block reads the registry from the post-rebase checkout
  // (cwd = /tmp/core-data-checkout) and passes it as the 5th argument.
  assert.match(code, /fs\.existsSync\("retired-show-ids\.json"\)/, 'must look for the registry in the checkout');
  assert.match(code, /reconcileShowsJson\(local, remote, base, undefined, retiredIds\)/, 'must pass the retired list through');
  assert.match(code, /retiredSkipped/, 'must surface the refused count');

  // Both registry files ride CORE_FILES so a CI retirement is pushed.
  const m = /CORE_FILES="([^"]+)"/.exec(code);
  assert.ok(m, 'CORE_FILES line present');
  const files = m[1].split(/\s+/);
  assert.ok(files.includes('retired-show-ids.json'), 'CORE_FILES must include retired-show-ids.json');
  assert.ok(files.includes('deleted-shows.json'), 'CORE_FILES must include deleted-shows.json');

  // The inline `-e '...'` body is a bash single-quoted string: one apostrophe
  // in a comment would truncate it (audit-workflow-hygiene rule (j)).
  const start = yaml.indexOf('const { reconcileShowsJson } = require(');
  const end = yaml.indexOf("' 2>&1 || true", start);
  const body = yaml.slice(start, end);
  assert.ok(!body.includes("'"), 'inline node body must contain no single quote');

  // An unreadable registry must hand the module an EMPTY ARRAY, never
  // undefined: undefined makes the module re-read its default path, throw on
  // the same corruption, and the outer catch then skips the ENTIRE reconcile.
  assert.ok(!/retiredIds = undefined/.test(body), 'the loader must never fall back to undefined');
  assert.match(body, /::warning::retired-show-ids\.json/, 'an unreadable registry must warn');
});

// The inline registry loader, run for real (extracted from the YAML, not
// copied — a copy passing would prove nothing about the action): the
// snippet from `let retiredIds = [];` up to the reconcileShowsJson call, with
// `fs` bound to a temp dir standing in for the core-data checkout cwd.
function extractRetiredLoader() {
  const yaml = readFileSync(join(ROOT, '.github/actions/push-core-data/action.yml'), 'utf8');
  const start = yaml.indexOf('let retiredIds = [];');
  const end = yaml.indexOf('const { recovered, readded, baseAvailable, retiredSkipped }', start);
  assert.ok(start > 0 && end > start, 'loader block present in the inline node body');
  const src = yaml.slice(start, end);
  return (dir) => {
    const logs = [];
    const fakeFs = {
      existsSync: (p) => existsSync(join(dir, p)),
      readFileSync: (p, enc) => readFileSync(join(dir, p), enc),
    };
    const fakeConsole = { log: (line) => logs.push(String(line)) };
    const retiredIds = new Function('fs', 'console', `${src}\nreturn retiredIds;`)(fakeFs, fakeConsole);
    return { retiredIds, logs };
  };
}

test('inline loader: missing, empty and valid registry files load silently; corrupt and non-array files give [] plus one ::warning::, never undefined', () => {
  const run = extractRetiredLoader();
  const dir = mkdtempSync(join(tmpdir(), 'inline-retired-'));
  try {
    const file = join(dir, 'retired-show-ids.json');
    let r = run(dir);
    assert.deepEqual(r, { retiredIds: [], logs: [] }, 'missing file: empty list, no warning');

    writeFileSync(file, '');
    r = run(dir);
    assert.deepEqual(r, { retiredIds: [], logs: [] }, 'empty file (a fresh touch / seed): empty list, no warning');

    writeFileSync(file, JSON.stringify([{ id: X, reason: 'r' }, { id: '' }, null, { reason: 'no id' }]));
    r = run(dir);
    assert.deepEqual(r, { retiredIds: [X], logs: [] }, 'valid registry: ids only, junk entries dropped');

    writeFileSync(file, '{ not json');
    r = run(dir);
    assert.deepEqual(r.retiredIds, [], 'corrupt file: an EMPTY ARRAY, never undefined');
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /^::warning::retired-show-ids\.json/);

    writeFileSync(file, '{"retired": []}');
    r = run(dir);
    assert.deepEqual(r.retiredIds, [], 'non-array: empty array plus a warning');
    assert.match(r.logs[0], /expected a JSON array/);

    // The empty array reaches the module as-is (no re-read of the default
    // path, no throw): field recovery and concurrent adds still run this
    // round — the documented trade-off the warning names.
    const local = { shows: [S('hamilton', { venue: null })] };
    const res = reconcileShowsJson(local, { shows: [S('hamilton', { venue: 'Booth' }), S(X)] }, { shows: [S('hamilton', { venue: null })] }, undefined, r.retiredIds);
    assert.equal(res.recovered, 1, 'field recovery still ran');
    assert.equal(res.readded, 1, 'with an empty list the remote-only row is re-added this round');
    assert.equal(res.retiredSkipped, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.gitignore keeps both registry files out of the public repo (core data, §11)', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('data/retired-show-ids.json'));
  assert.ok(ignore.includes('data/deleted-shows.json'));
});
