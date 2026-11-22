// BRO-8054: the Chicago staging path must not store a "Title by Playwright" listing name.
// Real case: theatreinchicago.com lists "Engines and Instruments of Flight: A Fantasia in
// Three Acts by Calamity West" (id 13622); the row's 334px card blocked a newsletter draft.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const stage = require('./tic-stage.js');
const { evaluate, runDaily } = require('./tic-daily.js');

const RAW = 'Engines and Instruments of Flight: A Fantasia in Three Acts by Calamity West';
const CLEAN = 'Engines and Instruments of Flight: A Fantasia in Three Acts';
// First sentence of the live page's description (the only place the site credits the writer).
const DESC = "Calamity West is conjuring a fantasia: It's 1986 New York and Tony is a playwright who isn't writing.";

const page = (title = RAW) => ({
  id: 13622, slug: 'engines', empty: false, title, venue: 'Broadway Armory', closingDate: '2026-12-19', poster: null,
  reviews: ['A', 'B', 'C'].map((o, i) => ({ outlet: `Outlet ${o}`, critic: 'X', verdict: 'recommended', url: `https://example.com/${i}` })),
});
const detail = (description) => ({ empty: false, title: RAW, venue: 'Broadway Armory', address: '5838 N Broadway, Chicago, IL', showType: 'Comedy/Drama', description, closingDate: '2026-12-19' });
const build = (p, d, extra = {}) => stage.buildShowEntry({ page: p, detail: d, dates: { openingDate: '2026-11-12' }, discoveredAt: '2026-11-22', ...extra });

test('RED-THEN-GREEN: the real listing is stored without the playwright, id included', () => {
  const e = build(page(), detail(DESC));
  assert.equal(e.title, CLEAN);
  assert.equal(e.id, 'engines-and-instruments-of-flight-a-fantasia-in-three-acts-regional-2026');
  assert.equal(e.titleNormalizedFrom, RAW);
  assert.deepEqual(e.akaTitles, [RAW], 'the printed title stays searchable');
});

test('with no independent credit the title is left as listed (never guessed)', () => {
  const e = build(page(), detail('A new play.'));
  assert.equal(e.title, RAW);
  assert.equal(e.titleNormalizedFrom, undefined);
});

test('a corpus-known writer strips it even when the description is silent', () => {
  const knownWriters = new Set(['calamity west']);
  assert.equal(build(page(), detail('A new play.'), { knownWriters }).title, CLEAN);
});

test('real "by" titles survive, even when the description repeats the name', () => {
  for (const [title, d] of [
    ['Killed by Grace Kelly', 'A comedy about being Killed by Grace Kelly.'],
    ['Side by Side by Sondheim', 'Songs by Stephen Sondheim.'],
    ['Stand by Your Man', 'The Your Man story.'],
    ['Damned by Despair', 'Despair, damned.'],
  ]) assert.equal(build(page(title), detail(d)).title, title, title);
});

test('the daily run (evaluate) stages the clean title end to end', async () => {
  const io = { page: async () => page(), detail: async () => detail(DESC), dates: async () => ({ openingDate: '2026-11-12' }) };
  const res = await evaluate({ id: 13622 }, { shows: [], today: '2026-11-22', knownWriters: new Set() }, io);
  assert.equal(res.status, 'accepted');
  assert.equal(res.show.title, CLEAN);
});

// The reviewer's blocker (BRO-8054): the normalized entry carries provenance fields, and
// add-show refuses fields outside its allowlist. A refusal is stored retry:false, so
// the very listing this fix targets would have been skipped forever. Drive the whole
// run through the real applyAddShow.
test('RED-THEN-GREEN: runDaily ADDS the normalized listing (add-show accepts the provenance fields)', async () => {
  // applyAddShow consults the retired-id registry, a live data file; pin it so this test reads no live data.
  const registry = require('./retired-show-ids.js');
  const realIsRetired = registry.isRetiredId;
  registry.isRetiredId = () => false;
  try {
  const io = { page: async () => page(), detail: async () => detail(DESC), dates: async () => ({ openingDate: '2026-11-12' }) };
  const shows = [];
  const out = await runDaily({ today: '2026-11-22', listing: [{ id: 13622, reviewCount: 3 }], shows, seen: {}, io });
  assert.equal(out.added.length, 1, JSON.stringify(out.seen));
  const row = shows.find((s) => s.title === CLEAN);
  assert.ok(row, 'row stored under the clean title');
  assert.equal(row.titleNormalizedFrom, RAW);
  assert.deepEqual(row.akaTitles, [RAW]);
  assert.match(row.titleNormalizedAt, /^\d{4}-\d{2}-\d{2}T/, 'full ISO, same shape applyNormalizedTitle writes');
  } finally { registry.isRetiredId = realIsRetired; }
});

// Class guard: a TIC caller that forgets to pass the corpus oracle, or a writer that
// goes around the shows write guard, silently brings the bug back.
test('class guard: every TIC buildShowEntry caller passes knownWriters; tic-daily writes through the guard', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  for (const rel of ['./tic-daily.js', '../tic-stage-shows.js']) {
    const calls = read(rel).match(/stage\.buildShowEntry\(\{[^}]*\}\)/g) || [];
    assert.ok(calls.length > 0, `${rel} should call stage.buildShowEntry`);
    for (const c of calls) assert.match(c, /knownWriters/, `${rel}: ${c}`);
  }
  const daily = read('../tic-daily.js');
  assert.doesNotMatch(daily, /writeFileSync\(\s*SHOWS\b/, 'tic-daily must not write shows.json directly');
  assert.match(daily, /saveShows\(/);
});
