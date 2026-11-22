// BRO-8054: shows-write-guard repairs title artifacts on the rows a save adds or changes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShowsWriteGuard } = require('./shows-write-guard.js');

const RAW = 'Engines and Instruments of Flight: A Fantasia in Three Acts by Calamity West';
const CLEAN = 'Engines and Instruments of Flight: A Fantasia in Three Acts';
const WRITER = { name: 'Calamity West', role: 'Playwright' };
// Filler keeps edits under atomicWriteJson's 5% shrink gate.
const FILLER = Array.from({ length: 40 }, (_, i) => ({ id: `filler-${i}`, title: `Filler Show ${i}`, status: 'open', tags: [] }));

let dir, file;
const seed = (shows) => fs.writeFileSync(file, JSON.stringify({ _meta: {}, shows: [...shows, ...FILLER] }, null, 2) + '\n');
const onDisk = (id) => JSON.parse(fs.readFileSync(file, 'utf8')).shows.find((s) => s.id === id);
const row = (over = {}) => ({ id: 'engines-regional-2026', slug: over.id || 'engines-regional-2026', title: RAW, status: 'open', type: 'play', category: 'regional', venue: 'Broadway Armory, Chicago, IL', openingDate: '2026-11-12', tags: [], ...over });

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-guard-title-')); file = path.join(dir, 'shows.json'); delete process.env.SHOWS_TITLE_HEAL_DISABLED; });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a NEW row whose byline the corpus can prove is stored without it, with provenance', () => {
  seed([{ id: 'other', title: 'Another Play', status: 'closed', creativeTeam: [WRITER] }]);
  const g = createShowsWriteGuard(file);
  const data = g.loadShows();
  data.shows.push(row());
  g.saveShows(data);
  const s = onDisk('engines-regional-2026');
  assert.equal(s.title, CLEAN);
  assert.equal(s.titleNormalizedFrom, RAW);
  assert.ok(s.akaTitles.includes(RAW));
  assert.equal(data.shows.find((x) => x.id === s.id).title, CLEAN, 'caller object synced');
});

test('RED-THEN-GREEN: the oracle arrives later (creativeTeam backfill) and the same save heals the title', () => {
  seed([row()]);
  const g = createShowsWriteGuard(file);
  const data = g.loadShows();
  data.shows.find((s) => s.id === 'engines-regional-2026').creativeTeam = [WRITER];
  g.saveShows(data);
  assert.equal(onDisk('engines-regional-2026').title, CLEAN);
});

test('a row this save did not touch keeps its title (an unrelated cron never re-titles a show)', () => {
  seed([row(), { id: 'other', title: 'Another Play', status: 'closed', creativeTeam: [WRITER] }]);
  const g = createShowsWriteGuard(file);
  const data = g.loadShows();
  data.shows.find((s) => s.id === 'other').status = 'open';
  g.saveShows(data);
  assert.equal(onDisk('engines-regional-2026').title, RAW);
});

test('an unprovable byline is never guessed at', () => {
  seed([]);
  const g = createShowsWriteGuard(file);
  const data = g.loadShows();
  data.shows.push(row({ id: 'killed-regional-2026', title: 'Killed by Grace Kelly' }), row({ id: 'sbs-regional-2026', title: 'Side by Side by Sondheim' }));
  g.saveShows(data);
  assert.equal(onDisk('killed-regional-2026').title, 'Killed by Grace Kelly');
  assert.equal(onDisk('sbs-regional-2026').title, 'Side by Side by Sondheim');
});

test('a venue-suffix tail on a new row is repaired by the same call', () => {
  seed([]);
  const g = createShowsWriteGuard(file);
  const data = g.loadShows();
  data.shows.push(row({ id: 'cherry-regional-2026', title: 'The Cherry Orchard (Broadway Armory)' }));
  g.saveShows(data);
  assert.equal(onDisk('cherry-regional-2026').title, 'The Cherry Orchard');
});

test('a shouted title is never rewritten', () => {
  seed([]);
  const g = createShowsWriteGuard(file);
  const data = g.loadShows();
  data.shows.push(row({ id: 'shout-regional-2026', title: 'AMERICA, WHO HURT YOU?' }));
  g.saveShows(data);
  assert.equal(onDisk('shout-regional-2026').title, 'AMERICA, WHO HURT YOU?');
});

test('a heal that would create a duplicate is undone instead of failing an unrelated save', () => {
  seed([{ id: 'tender-existing', slug: 'tender-existing', title: 'Tender', status: 'open', type: 'play', category: 'regional', venue: 'Broadway Armory, Chicago, IL', openingDate: '2026-11-12', creativeTeam: [{ name: 'Jane Roe', role: 'Author' }] }]);
  const g = createShowsWriteGuard(file);
  const data = g.loadShows();
  data.shows.push(row({ id: 'tender-by-jane-roe-regional-2026', title: 'Tender by Jane Roe', openingDate: '2026-11-13' }));
  g.saveShows(data, { allowDuplicates: false });
  assert.equal(onDisk('tender-by-jane-roe-regional-2026').title, 'Tender by Jane Roe', 'left as written');
  assert.equal(onDisk('tender-by-jane-roe-regional-2026').titleNormalizedFrom, undefined, 'no half-applied provenance');
});

test('dry run reports the heals without mutating the caller rows', () => {
  seed([{ id: 'other', title: 'Another Play', status: 'closed', creativeTeam: [WRITER] }]);
  const g = createShowsWriteGuard(file, { dryRun: true });
  const data = g.loadShows();
  data.shows.push(row());
  const res = g.saveShows(data, { reason: 'test' });
  assert.equal(res.titleHeals.length, 1);
  assert.equal(res.titleHeals[0].to, CLEAN);
  assert.equal(data.shows.find((s) => s.id === 'engines-regional-2026').title, RAW);
  assert.equal(onDisk('engines-regional-2026'), undefined, 'nothing written');
});

test('kill switch SHOWS_TITLE_HEAL_DISABLED=true leaves titles alone', () => {
  process.env.SHOWS_TITLE_HEAL_DISABLED = 'true';
  seed([{ id: 'other', title: 'Another Play', status: 'closed', creativeTeam: [WRITER] }]);
  const g = createShowsWriteGuard(file);
  const data = g.loadShows();
  data.shows.push(row());
  g.saveShows(data);
  assert.equal(onDisk('engines-regional-2026').title, RAW);
});
