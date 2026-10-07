// Retired person/place slug redirects (2026 data audit, S7-T3 follow-up).
//
// The S7-T3 diacritic fold moved every accented /creative, /theater,
// /west-end/theater, /off-broadway/theater and /cast URL with no redirect.
// scripts/lib/name-slug-redirects.js derives {old → new} per family from the
// data the pages are built from, replaying the page-order + collision rule
// (scripts/lib/page-name-sources.js + scripts/lib/url-slug.js) under both
// slug rules. Everything here requires the real modules (CLAUDE.md §15); the
// end-to-end cases run the real scripts/build-slug-redirects.js against temp
// inputs through its env overrides, so the tracked data/slug-redirects*.json
// files are never touched (asserted by hash). TS-side parity (the page
// builders assign the same slugs; the lookups fall back through the map) is
// tests/unit/name-slug-redirects.test.ts.
//
// Run: node --test tests/unit/name-slug-redirects.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../../scripts/lib/name-slug-redirects.js');
const { NAME_REDIRECT_PREFIXES, familyRedirects, buildNameSlugRedirects } = mod;
const sources = require('../../scripts/lib/page-name-sources.js');
const {
  HIDDEN_LONDON_IDS,
  broadwayShows,
  londonShows,
  offBroadwayShows,
  creativeNamesInPageOrder,
  broadwayTheaterNames,
  stubTheaterName,
  stubTheaterNames,
  actorIdentitiesInPageOrder,
} = sources;
const { slugify, legacySlugify, assignUniqueSlugs } = require('../../scripts/lib/url-slug.js');
const { CRITIC_REDIRECT_PREFIX } = require('../../scripts/lib/critic-slug-aliases.js');
const { getCategoriesForRole } = require('../../scripts/lib/creative-roles.js');

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'build-slug-redirects.js');
const TRACKED = ['slug-redirects.json', 'slug-redirects-compact.json'].map((f) => join(REPO_ROOT, 'data', f));

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'name-slug-redirects-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

const show = (id, category, venue, creativeTeam, extra = {}) => ({ id, slug: id, category, venue, creativeTeam, ...extra });

// Every family gets one accented name whose URL the fold moved, plus the
// exclusions each page builder applies (dev-only rows, other markets,
// non-creative roles, placeholder venues, orphan cast, other-market cast).
const FIXTURE_SHOWS = [
  // "Noel Coward" reaches noel-coward first; "Noël Coward" is the collision.
  show('private-lives-2011', 'broadway', 'Music Box Theatre', [
    { name: 'Noel Coward', role: 'Playwright' },
    { name: 'Richard Eyre', role: 'Director' },
  ]),
  show('blithe-spirit-2009', 'broadway', 'Shubert Theatre', [
    { name: 'Noël Coward', role: 'Playwright' },
    { name: 'Noël Coward', role: 'Music' }, // same person twice — one page
  ]),
  show('long-days-journey-1956', 'broadway', 'Helen Hayes Theatre', [
    { name: 'José Quintero', role: 'Director' },
    { name: 'Riccardo Hernández', role: 'Scenic Design' }, // no creative page → no redirect
  ]),
  // Under the old rule "José Ferrer" reached jos-ferrer first and "Jos Ferrer"
  // got jos-ferrer-2; now jose-ferrer / jos-ferrer. José's old URL is Jos's
  // live page (never emitted); Jos's old jos-ferrer-2 → jos-ferrer.
  show('cyrano-1946', 'broadway', 'Café Broadway Theatre', [
    { name: 'José Ferrer', role: 'Director & Choreographer' },
    { name: 'Jos Ferrer', role: 'Director' },
  ]),
  show('devonly-2026', 'broadway', 'Théâtre Dev', [{ name: 'Zoë Dev', role: 'Director' }], { _devOnly: true }),
  show('regional-2026', 'regional', 'Théâtre Régional', [{ name: 'André Regional', role: 'Director' }]),
  show('hamilton-2015', 'broadway', 'Richard Rodgers Theatre', [{ name: 'Lin-Manuel Miranda', role: 'Book, Music & Lyrics' }]),
  show('present-laughter-west-end-2024', 'west-end', 'Noël Coward Theatre', []),
  show('present-laughter-west-end-2019', 'west-end', '  Noël  Coward Theatre ', []), // same page after normalisation
  show('tba-west-end-2027', 'west-end', 'TBA', []),
  show('abba-voyage-off-west-end-2026', 'off-west-end', 'ABBA Arèna', []), // hidden London id → no venue page
  show('la-casa-off-broadway-2025', 'off-broadway', 'Repertorio Español / Spanish Theatre Repertory', []),
  show('atlantic-off-broadway-2025', 'off-broadway', 'Atlantic Stage 2', []),
  { id: 'hamilton-west-end-2017', slug: 'hamilton-west-end', category: 'west-end', venue: 'Victoria Palace Theatre' },
];

const FIXTURE_CAST = {
  entries: [
    { showId: 'hamilton-2015', castType: 'obc', name: 'Rene Ceballos', ibdbPersonId: '1' }, // ASCII twin owns rene-ceballos
    { showId: 'hamilton-2015', castType: 'obc', name: 'René Ceballos', ibdbPersonId: '2' }, // → rene-ceballos-2
    { showId: 'hamilton-2015', castType: 'current', name: 'Renée Klapmeyer', ibdbPersonId: '3' },
    { showId: 'hamilton-2015', castType: 'obc', name: 'Orphan Actör' }, // no IBDB id → no page
    { showId: 'regional-2026', castType: 'obc', name: 'Zoë Outside', ibdbPersonId: '4' }, // not a Broadway show → no page
    { showId: 'hamilton-2015', castType: 'obc', name: 'Jose Llana', ibdbPersonId: '5' },
    { showId: 'hamilton-2015', castType: 'current', name: 'José Llana', ibdbPersonId: '5' }, // current spelling names the page
  ],
};

const FIXTURE_COMPLEXES = {
  'venue-complexes.json': { complexes: { 'atlantic-theater-company': { name: 'Atlantic Theater Company', subVenueSlugs: ['atlantic-stage-2'] } } },
  'venue-complexes-west-end.json': { complexes: { 'national-theatre': { name: 'National Theatre', subVenueSlugs: [] } } },
};

// ── contract ────────────────────────────────────────────────────────────────

describe('contract', () => {
  test('exports and prefixes: one namespaced prefix per route family, disjoint from the critic prefix', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['NAME_REDIRECT_PREFIXES', 'buildNameSlugRedirects', 'familyRedirects']);
    assert.deepEqual(NAME_REDIRECT_PREFIXES, {
      creative: 'creative:',
      theater: 'theater:',
      westEndTheater: 'west-end-theater:',
      offBroadwayTheater: 'off-broadway-theater:',
      cast: 'cast:',
    });
    assert.ok(Object.isFrozen(NAME_REDIRECT_PREFIXES));
    for (const p of Object.values(NAME_REDIRECT_PREFIXES)) {
      assert.match(p, /^[a-z-]+:$/, p);
      assert.notEqual(p, CRITIC_REDIRECT_PREFIX);
      assert.equal(slugify(p).includes(':'), false, 'slugify never emits ":" so no show slug can collide with a prefixed key');
    }
    assert.equal(new Set(Object.values(NAME_REDIRECT_PREFIXES)).size, 5);
  });
});

// ── page-name-sources: the walk each page builder does ──────────────────────

describe('page-name-sources', () => {
  test('show-set filters mirror getBroadwayShows / getAllLondonShows / getOffBroadwayShows', () => {
    assert.deepEqual(broadwayShows(FIXTURE_SHOWS).map((s) => s.id), [
      'private-lives-2011', 'blithe-spirit-2009', 'long-days-journey-1956', 'cyrano-1946', 'hamilton-2015',
    ], '_devOnly and non-broadway rows drop');
    assert.deepEqual(londonShows(FIXTURE_SHOWS).map((s) => s.id), [
      'present-laughter-west-end-2024', 'present-laughter-west-end-2019', 'tba-west-end-2027', 'hamilton-west-end-2017',
    ], 'west-end + off-west-end minus HIDDEN_LONDON_IDS');
    assert.ok(HIDDEN_LONDON_IDS.has('abba-voyage-off-west-end-2026'));
    assert.deepEqual(offBroadwayShows(FIXTURE_SHOWS).map((s) => s.id), ['la-casa-off-broadway-2025', 'atlantic-off-broadway-2025']);
    assert.deepEqual(broadwayShows([null, undefined, { id: 'x', category: 'broadway' }]).map((s) => s.id), ['x']);
  });

  test('creativeNamesInPageOrder: first-encounter order, exact-string identity, only roles with a creative category', () => {
    const names = creativeNamesInPageOrder(broadwayShows(FIXTURE_SHOWS));
    assert.deepEqual(names, ['Noel Coward', 'Richard Eyre', 'Noël Coward', 'José Quintero', 'José Ferrer', 'Jos Ferrer', 'Lin-Manuel Miranda']);
    assert.ok(!names.includes('Riccardo Hernández'), 'Scenic Design maps to no category');
    assert.deepEqual(getCategoriesForRole('Scenic Design'), []);
    assert.deepEqual(getCategoriesForRole('Director & Choreographer'), ['director']);
    assert.deepEqual(creativeNamesInPageOrder([{ id: 'a' }, { id: 'b', creativeTeam: [] }, { id: 'c', creativeTeam: [null, { name: 'X', role: undefined }] }]), []);
  });

  test('broadwayTheaterNames: raw venue strings, first-encounter order, "_"-prefixed and empty skipped, no normalisation', () => {
    assert.deepEqual(broadwayTheaterNames(broadwayShows(FIXTURE_SHOWS)), [
      'Music Box Theatre', 'Shubert Theatre', 'Helen Hayes Theatre', 'Café Broadway Theatre', 'Richard Rodgers Theatre',
    ]);
    assert.deepEqual(broadwayTheaterNames([{ venue: '_internal' }, { venue: '' }, {}, { venue: ' Raw ' }, { venue: ' Raw ' }]), [' Raw ']);
  });

  test('stubTheaterName / stubTheaterNames: trim + collapse whitespace; "_", placeholders and non-strings get no page; every distinct spelling is kept', () => {
    assert.equal(stubTheaterName('  Noël  Coward Theatre '), 'Noël Coward Theatre');
    for (const v of ['TBA', 'tbd', 'Unknown', '_hidden', '', '   ', null, undefined, 7]) assert.equal(stubTheaterName(v), null, String(v));
    assert.deepEqual(stubTheaterNames(londonShows(FIXTURE_SHOWS)), ['Noël Coward Theatre', 'Victoria Palace Theatre']);
    assert.deepEqual(stubTheaterNames([{ venue: 'Noel Coward Theatre' }, { venue: 'Noël Coward Theatre' }]), ['Noel Coward Theatre', 'Noël Coward Theatre'],
      'two spellings that share one live slug are two names — each had its own pre-fold URL');
  });

  test('actorIdentitiesInPageOrder: one identity per IBDB id in first-encounter order; orphans and other-market entries skipped; the current-cast spelling names the page', () => {
    const ids = actorIdentitiesInPageOrder(FIXTURE_CAST.entries, new Set(broadwayShows(FIXTURE_SHOWS).map((s) => s.id)));
    assert.deepEqual(ids, [
      { ibdbPersonId: '1', name: 'Rene Ceballos' },
      { ibdbPersonId: '2', name: 'René Ceballos' },
      { ibdbPersonId: '3', name: 'Renée Klapmeyer' },
      { ibdbPersonId: '5', name: 'José Llana' },
    ]);
    assert.deepEqual(actorIdentitiesInPageOrder([], new Set()), []);
  });
});

// ── familyRedirects: the per-family rule ────────────────────────────────────

describe('familyRedirects', () => {
  test('numbered family: the retired slug lands on the page the collision rule actually assigns — derived, not hardcoded', () => {
    const names = ['Noel Coward', 'Noël Coward'];
    const live = assignUniqueSlugs(names, slugify);
    const retired = assignUniqueSlugs(names, legacySlugify);
    assert.deepEqual(live, ['noel-coward', 'noel-coward-2']);
    assert.deepEqual(retired, ['noel-coward', 'no-l-coward']);
    const out = familyRedirects(names, { numbered: true });
    assert.deepEqual(out, { [retired[1]]: live[1] });
    assert.equal(out['no-l-coward'], 'noel-coward-2', 'Noël, not Noel');
    assert.ok(!('noel-coward' in out), 'the unaccented person keeps their URL: nothing to redirect');
  });

  test('numbered family, reversed order: the accented spelling owns the bare slug, and the other person\'s old slug is a live page so it is never emitted', () => {
    const names = ['Noël Coward', 'Noel Coward'];
    assert.deepEqual(assignUniqueSlugs(names, slugify), ['noel-coward', 'noel-coward-2']);
    assert.deepEqual(assignUniqueSlugs(names, legacySlugify), ['no-l-coward', 'noel-coward']);
    // "Noel Coward" moved from noel-coward to noel-coward-2, but noel-coward is
    // now Noël's live page — a redirect there would shadow it.
    assert.deepEqual(familyRedirects(names, { numbered: true }), { 'no-l-coward': 'noel-coward' });
  });

  test('unnumbered family (theatres): plain slugify; a live page (from the list or extraLive) is never shadowed; the first name to reach a slug wins', () => {
    assert.deepEqual(familyRedirects(['Noël Coward Theatre', 'Victoria Palace Theatre'], { numbered: false }), {
      'no-l-coward-theatre': 'noel-coward-theatre',
    });
    assert.deepEqual(
      familyRedirects(['Repertorio Español / Spanish Theatre Repertory'], { numbered: false, extraLive: ['repertorio-espa-ol-spanish-theatre-repertory'] }),
      {},
      'a curated complex slug equal to the old slug keeps its page'
    );
    assert.deepEqual(familyRedirects(['Noel Coward Theatre', 'Noël Coward Theatre'], { numbered: false }), {
      'no-l-coward-theatre': 'noel-coward-theatre',
    });
    // Two names with one old slug: the first (page owner under the old rule) wins.
    assert.deepEqual(familyRedirects(['Théâtre A', 'Theatre A', 'Thèâtre A'], { numbered: false }), { 'th-tre-a': 'theatre-a' });
    assert.deepEqual(familyRedirects([], { numbered: false }), {});
    assert.deepEqual(familyRedirects(['···', ''], { numbered: false }), {}, 'empty slugs are never keys');
  });
});

// ── buildNameSlugRedirects: all families from raw data ──────────────────────

describe('buildNameSlugRedirects', () => {
  const built = buildNameSlugRedirects({
    shows: FIXTURE_SHOWS,
    castEntries: FIXTURE_CAST.entries,
    complexSlugs: { offBroadway: ['atlantic-theater-company'], westEnd: ['national-theatre'] },
  });

  test('per family: exactly the moved URLs, each landing on its live page', () => {
    assert.deepEqual(built.families, {
      creative: {
        'no-l-coward': 'noel-coward-2',
        'jos-quintero': 'jose-quintero',
        // jos-ferrer is Jos Ferrer's live page → José Ferrer's old URL is NOT
        // redirected; Jos Ferrer's own old URL (numbered under the old rule) is.
        'jos-ferrer-2': 'jos-ferrer',
      },
      theater: { 'caf-broadway-theatre': 'cafe-broadway-theatre' },
      westEndTheater: { 'no-l-coward-theatre': 'noel-coward-theatre' },
      offBroadwayTheater: { 'repertorio-espa-ol-spanish-theatre-repertory': 'repertorio-espanol-spanish-theatre-repertory' },
      cast: {
        'ren-ceballos': 'rene-ceballos-2',
        'ren-e-klapmeyer': 'renee-klapmeyer',
        'jos-llana': 'jose-llana',
      },
    });
    assert.ok(!('jos-ferrer' in built.families.creative));
    assert.ok(!Object.keys(built.families.creative).some((k) => k.includes('dev') || k.includes('regional')), 'dev-only / other-market names never emit');
    assert.ok(!Object.keys(built.families.westEndTheater).some((k) => k.startsWith('abba')), 'hidden London show → no venue page → no redirect');
  });

  test('entries: every family key namespaced under its prefix, values never "~" (always 301)', () => {
    const expected = {};
    for (const [family, map] of Object.entries(built.families)) {
      for (const [o, n] of Object.entries(map)) expected[NAME_REDIRECT_PREFIXES[family] + o] = n;
    }
    assert.deepEqual(built.entries, expected);
    assert.equal(Object.keys(built.entries).length, 9);
    assert.ok(Object.values(built.entries).every((v) => !v.startsWith('~')));
    assert.ok(Object.keys(built.entries).every((k) => k.split(':').length === 2 && k === k.toLowerCase()));
  });

  test('missing optional inputs: no cast manifest / no complexes → that part is empty, nothing throws', () => {
    const b = buildNameSlugRedirects({ shows: FIXTURE_SHOWS });
    assert.deepEqual(b.families.cast, {});
    assert.deepEqual(b.families.creative, built.families.creative);
    const legacyFixture = buildNameSlugRedirects({ shows: [{ id: 'hamilton-2015', slug: 'hamilton-2015' }] });
    assert.deepEqual(legacyFixture.entries, {}, 'rows with no category/venue/creativeTeam (the S5-T9 test fixtures) emit nothing');
  });
});

// ── end to end: the real script against temp inputs ─────────────────────────

function runScript(dir, { shows = FIXTURE_SHOWS, cast = FIXTURE_CAST, complexes = FIXTURE_COMPLEXES } = {}) {
  writeFileSync(join(dir, 'shows.json'), JSON.stringify({ shows }));
  const complexesDir = join(dir, 'complexes');
  mkdirSync(complexesDir, { recursive: true });
  for (const [name, obj] of Object.entries(complexes)) writeFileSync(join(complexesDir, name), JSON.stringify(obj));
  const castPath = join(dir, 'cast-manifest.json');
  if (cast) writeFileSync(castPath, JSON.stringify(cast));
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SLUG_REDIRECTS_SHOWS_PATH: join(dir, 'shows.json'),
      SLUG_REDIRECTS_OUT_DIR: dir,
      SLUG_REDIRECTS_CAST_MANIFEST_PATH: castPath,
      SLUG_REDIRECTS_COMPLEXES_DIR: complexesDir,
      CRITIC_SLUG_ALIASES_PATH: join(dir, 'absent-critic-registry.json'),
    },
  });
  if (res.status !== 0) return res;
  return {
    ...res,
    compact: JSON.parse(readFileSync(join(dir, 'slug-redirects-compact.json'), 'utf8')),
    full: JSON.parse(readFileSync(join(dir, 'slug-redirects.json'), 'utf8')),
  };
}

describe('scripts/build-slug-redirects.js', () => {
  test('emits every family into the compact map beside the show + critic entries; full output carries nameRedirects; tracked files untouched', () => {
    const before = TRACKED.map(sha);
    withTmp((dir) => {
      const res = runScript(dir);
      assert.equal(res.status, 0, `build-slug-redirects.js failed:\n${res.stdout}\n${res.stderr}`);
      const { compact, full, stdout } = res;

      // Show side unchanged by the name work.
      assert.equal(compact['hamilton-west-end-2017'], 'hamilton-west-end');
      assert.equal(compact['private-lives'], 'private-lives-2011');

      // Name families, namespaced.
      assert.equal(compact['creative:no-l-coward'], 'noel-coward-2');
      assert.equal(compact['creative:jos-quintero'], 'jose-quintero');
      assert.equal(compact['creative:jos-ferrer-2'], 'jos-ferrer');
      assert.ok(!('creative:jos-ferrer' in compact), 'a live page is never shadowed');
      assert.equal(compact['theater:caf-broadway-theatre'], 'cafe-broadway-theatre');
      assert.equal(compact['west-end-theater:no-l-coward-theatre'], 'noel-coward-theatre');
      assert.equal(compact['off-broadway-theater:repertorio-espa-ol-spanish-theatre-repertory'], 'repertorio-espanol-spanish-theatre-repertory');
      assert.equal(compact['cast:ren-ceballos'], 'rene-ceballos-2');
      assert.equal(compact['cast:jos-llana'], 'jose-llana');
      assert.equal(Object.keys(compact).filter((k) => k.includes(':')).length, 9, 'no critic entries (registry absent) + 9 name entries');
      assert.ok(!Object.keys(compact).some((k) => k.startsWith(CRITIC_REDIRECT_PREFIX)));

      // Full (inspection) output.
      assert.deepEqual(full.nameRedirects.creative, { 'no-l-coward': 'noel-coward-2', 'jos-quintero': 'jose-quintero', 'jos-ferrer-2': 'jos-ferrer' });
      assert.deepEqual(full.nameRedirects.cast, { 'ren-ceballos': 'rene-ceballos-2', 'ren-e-klapmeyer': 'renee-klapmeyer', 'jos-llana': 'jose-llana' });
      assert.equal(full._meta.totalNameRedirects, 9);
      assert.deepEqual(full._meta.nameRedirectCounts, { creative: 3, theater: 1, westEndTheater: 1, offBroadwayTheater: 1, cast: 3 });
      assert.equal(full._meta.totalCriticRedirects, 0);
      assert.ok(!Object.keys(full.redirects).some((k) => k.includes(':')), 'show map stays free of namespaced keys');
      assert.match(stdout, /0 critic aliases/);
      assert.match(stdout, /9 name-slug redirects \(3 creative:, 1 theater:, 1 west-end-theater:, 1 off-broadway-theater:, 3 cast:\)/);
    });
    assert.deepEqual(TRACKED.map(sha), before, 'the tracked data/slug-redirects*.json must never be rewritten by a test run');
  });

  test('a missing cast manifest is an empty cast family with a warning, never a failure', () => {
    withTmp((dir) => {
      const res = runScript(dir, { cast: null });
      assert.equal(res.status, 0, `build-slug-redirects.js failed:\n${res.stdout}\n${res.stderr}`);
      assert.ok(!Object.keys(res.compact).some((k) => k.startsWith(NAME_REDIRECT_PREFIXES.cast)));
      assert.equal(res.compact['creative:no-l-coward'], 'noel-coward-2', 'the other families are unaffected');
      assert.match(res.stderr, /cast manifest not found/);
      assert.match(res.stdout, /0 cast:/);
    });
  });

  test('the S5-T9 minimal fixture (rows with only id/slug) still builds and emits no name entries', () => {
    withTmp((dir) => {
      const res = runScript(dir, { shows: [{ id: 'hamilton-2015', slug: 'hamilton-2015' }], cast: { entries: [] }, complexes: {} });
      assert.equal(res.status, 0, `build-slug-redirects.js failed:\n${res.stdout}\n${res.stderr}`);
      assert.deepEqual(Object.keys(res.compact).filter((k) => k.includes(':')), []);
      assert.equal(res.compact.hamilton, 'hamilton-2015');
      assert.equal(res.full._meta.totalNameRedirects, 0);
    });
  });
});
