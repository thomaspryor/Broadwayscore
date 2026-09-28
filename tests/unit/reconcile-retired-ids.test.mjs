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
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const { reconcileShowsJson } = require(join(ROOT, 'scripts/lib/reconcile-shows-fields.js'));
const { _resetCache } = require(join(ROOT, 'scripts/lib/retired-show-ids.js'));

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

test('default retiredIds reads the on-disk registry (RETIRED_IDS_PATH), so an omitted argument still refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-retired-'));
  const prev = process.env.RETIRED_IDS_PATH;
  process.env.RETIRED_IDS_PATH = join(dir, 'retired-show-ids.json');
  _resetCache();
  try {
    writeFileSync(process.env.RETIRED_IDS_PATH, JSON.stringify([{ id: X, reason: 'r', retiredAt: 'now' }]));
    const local = { shows: [S('hamilton')] };
    const remote = { shows: [S('hamilton'), S(X), S('genuine-add')] };
    const base = { shows: [S('hamilton')] };

    const r = reconcileShowsJson(local, remote, base);

    assert.deepEqual(local.shows.map((s) => s.id), ['hamilton', 'genuine-add']);
    assert.equal(r.retiredSkipped, 1);
    assert.equal(r.readded, 1);

    // Missing registry file: default is an empty set, never a throw.
    rmSync(process.env.RETIRED_IDS_PATH);
    const local2 = { shows: [S('hamilton')] };
    const r2 = reconcileShowsJson(local2, { shows: [S('hamilton'), S(X)] }, base);
    assert.equal(r2.readded, 1);
    assert.equal(r2.retiredSkipped, 0);
  } finally {
    if (prev === undefined) delete process.env.RETIRED_IDS_PATH; else process.env.RETIRED_IDS_PATH = prev;
    _resetCache();
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.ok(files.includes('deleted-shows-2026-09.json'), 'CORE_FILES must include deleted-shows-2026-09.json');

  // The inline `-e '...'` body is a bash single-quoted string: one apostrophe
  // in a comment would truncate it (audit-workflow-hygiene rule (j)).
  const start = yaml.indexOf('const { reconcileShowsJson } = require(');
  const end = yaml.indexOf("' 2>&1 || true", start);
  const body = yaml.slice(start, end);
  assert.ok(!body.includes("'"), 'inline node body must contain no single quote');
});

test('.gitignore keeps both registry files out of the public repo (core data, §11)', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('data/retired-show-ids.json'));
  assert.ok(ignore.includes('data/deleted-shows-2026-09.json'));
});
