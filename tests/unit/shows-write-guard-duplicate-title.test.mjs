// BRO-6578: a census stub (tristan-yseult-royal-bath-regional-2026) duplicated an
// existing row (same title, same venue) and the prebuild gate blocked every Vercel
// build for 3h. The write path now refuses what the prebuild rule flags.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShowsWriteGuard } = require('../../scripts/lib/shows-write-guard');
const { findDuplicateShows, newDuplicateFindings } = require('../../scripts/lib/shows-duplicate-rule');
const { applyAddShow } = require('../../scripts/lib/add-show-action');
const { buildAction } = require('../../scripts/lib/uk-regional-add-plan');

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const row = (over) => ({
  title: 'Tristan & Yseult',
  venue: 'Theatre Royal, Bath',
  category: 'regional',
  type: 'play',
  market: 'regional',
  status: 'closed',
  openingDate: '2026-05-01',
  ...over,
});
const existing = row({ id: 'tristan-and-yseult-royal-bath-regional-2026', slug: 'tristan-and-yseult-royal-bath-regional-2026' });
const dupe = row({ id: 'tristan-yseult-royal-bath-regional-2026', slug: 'tristan-yseult-royal-bath-regional-2026' });
const distinct = row({ id: 'the-tempest-royal-bath-regional-2026', slug: 'the-tempest-royal-bath-regional-2026', title: 'The Tempest' });

let tmpDir;
let showsPath;
const seed = (shows) => fs.writeFileSync(showsPath, JSON.stringify({ _meta: {}, shows }, null, 2) + '\n');
const onDiskIds = () => JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows.map((s) => s.id);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-dup-title-'));
  showsPath = path.join(tmpDir, 'shows.json');
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('saveShows refuses an added duplicate title+venue row', () => {
  test('the incident pair is refused and nothing is written', () => {
    seed([existing]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows.push({ ...dupe });
    assert.throws(() => guard.saveShows(data), /refusing to write 1 new duplicate.*tristan-yseult-royal-bath-regional-2026.*tristan-and-yseult-royal-bath-regional-2026/s);
    assert.deepEqual(onDiskIds(), [existing.id]);
    // The lock was released: a later good save goes through.
    const again = guard.loadShows();
    again.shows.push({ ...distinct });
    guard.saveShows(again);
    assert.deepEqual(onDiskIds(), [existing.id, distinct.id]);
  });

  test('a distinct row at the same venue is accepted', () => {
    seed([existing]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows.push({ ...distinct });
    guard.saveShows(data);
    assert.deepEqual(onDiskIds(), [existing.id, distinct.id]);
  });

  test('a save that does not add a pair still writes when an old pair exists', () => {
    seed([existing, dupe]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows.find((s) => s.id === existing.id).status = 'open';
    guard.saveShows(data);
    assert.equal(JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows[0].status, 'open');
  });

  test('renaming one row of an old pair is not a new duplicate', () => {
    seed([existing, dupe]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    Object.assign(data.shows.find((s) => s.id === dupe.id), { id: 'tristan-yseult-bath-regional-2026' });
    guard.saveShows(data);
    assert.ok(onDiskIds().includes('tristan-yseult-bath-regional-2026'));
  });

  test('retitling an existing row into a duplicate is refused', () => {
    seed([existing, distinct]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows.find((s) => s.id === distinct.id).title = 'Tristan & Yseult';
    assert.throws(() => guard.saveShows(data), /new duplicate/);
  });

  test('deleting one row of an old pair does not let a third row retitle into it', () => {
    seed([existing, dupe, distinct]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows = data.shows.filter((s) => s.id !== dupe.id);
    data.shows.find((s) => s.id === distinct.id).title = 'Tristan & Yseult';
    assert.throws(() => guard.saveShows(data), /new duplicate/);
  });

  test('SHOWS_DUP_GUARD_DISABLED=true turns the refusal off', () => {
    seed([existing]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows.push({ ...dupe });
    process.env.SHOWS_DUP_GUARD_DISABLED = 'true';
    try { guard.saveShows(data); } finally { delete process.env.SHOWS_DUP_GUARD_DISABLED; }
    assert.equal(onDiskIds().length, 2);
  });

  test('allowDuplicates lets a deliberate save through', () => {
    seed([existing]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows.push({ ...dupe });
    guard.saveShows(data, { allowDuplicates: true });
    assert.equal(onDiskIds().length, 2);
  });

  test('title-less rows never make the rule throw', () => {
    seed([{ id: 'a', status: 'open' }, { id: 'b', status: 'open' }]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    data.shows.push({ id: 'c' });
    guard.saveShows(data);
    assert.deepEqual(onDiskIds(), ['a', 'b', 'c']);
    assert.deepEqual(findDuplicateShows([{ id: 'x', title: null }, existing]), []);
  });
});

describe('the rule matches the prebuild gate', () => {
  test('express-test clones are exempt, the incident pair is flagged', () => {
    assert.deepEqual(findDuplicateShows([existing, { ...existing, id: 'tristan-express-test-2026', slug: 'tristan-express-test-2026' }]), []);
    const [f] = newDuplicateFindings([existing], [existing, dupe]);
    assert.equal(f.show.id, dupe.id);
    assert.equal(f.existing.id, existing.id);
  });

  test('validate-shows-prebuild.js fails on the pair and passes the distinct row', () => {
    const run = (shows) => {
      const file = path.join(tmpDir, `fixture-${shows.length}.json`);
      fs.writeFileSync(file, JSON.stringify({ shows }));
      return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-shows-prebuild.js')], {
        env: { ...process.env, SHOWS_FILE_OVERRIDE: file }, encoding: 'utf8',
      });
    };
    const bad = run([existing, dupe]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /"Tristan & Yseult" \(tristan-yseult-royal-bath-regional-2026\) duplicates "Tristan & Yseult" \(tristan-and-yseult-royal-bath-regional-2026\)/);
    const good = run([existing, distinct, row({ id: 'x-1', slug: 'x-1', title: null })]);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /Prebuild check: 2 shows, no duplicates/);
  });
});

describe('add-show and the regional planners find the existing row', () => {
  const addShow = (show, extra = {}) => applyAddShow([{ ...existing }], { type: 'add-show', show: { ...show, discoverySource: 'uk-regional-guardian-backfill' }, ...extra });

  test('applyAddShow refuses the duplicate and accepts the distinct row', () => {
    const refused = addShow(dupe);
    assert.equal(refused.ok, false);
    assert.equal(refused.duplicateOf, existing.id);
    assert.match(refused.reason, /duplicates existing "tristan-and-yseult-royal-bath-regional-2026"/);
    assert.equal(addShow(distinct).ok, true, addShow(distinct).reason);
  });

  test('distinctFrom lets a declared separate production through, and the save', () => {
    const r = addShow(dupe, { distinctFrom: [existing.id] });
    assert.equal(r.ok, true, r.reason);
    // The declaration lands on the row, so saveShows and the prebuild accept it.
    seed([existing]);
    const guard = createShowsWriteGuard(showsPath);
    const data = guard.loadShows();
    assert.equal(applyAddShow(data.shows, { type: 'add-show', show: { ...dupe, discoverySource: 'x' }, distinctFrom: [existing.id] }).ok, true);
    guard.saveShows(data);
    assert.deepEqual(onDiskIds(), [existing.id, dupe.id]);
    assert.deepEqual(findDuplicateShows(JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows), []);
  });

  test('buildAction (Guardian and census backfills) skips with "exists as" the existing id', () => {
    const shows = [row({ id: 'king-lear-sheffield-crucible-regional-2026', slug: 'king-lear-sheffield-crucible-regional-2026', title: 'King Lear', venue: 'Crucible Theatre, Sheffield', openingDate: null })];
    const r = buildAction({ title: 'King Lear', venue: 'Crucible theatre, Sheffield', hub: 'yorkshire', date: '2026-09-06', guardianUrl: 'https://www.theguardian.com/stage/2026/sep/06/king-lear-review-sheffield-crucible' }, shows);
    assert.equal(r.skip, 'exists as king-lear-sheffield-crucible-regional-2026');
  });
});
