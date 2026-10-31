/**
 * Retired person/place slug redirects — the TS side (2026 data audit, S7-T3
 * follow-up). Two things the JS-only test (tests/unit/name-slug-redirects.test.mjs)
 * cannot prove:
 *
 *   1. PARITY on the real data: the page builders (src/lib/data-creative.ts,
 *      data-core.ts, data-actors.ts) assign exactly the slugs the shared
 *      helpers (scripts/lib/page-name-sources.js + url-slug.js
 *      assignUniqueSlugs) produce when replayed over the raw shows.json /
 *      cast manifest — which is what scripts/build-slug-redirects.js replays.
 *      If either side drifts, a retired slug could land on the wrong person.
 *   2. The lookups fall back through the map: getUnifiedCreativeProfile,
 *      getTheaterBySlug, getLondonTheaterBySlug, getOffBroadwayTheaterBySlug,
 *      getActorBySlug resolve a retired slug to the live page (and only via
 *      the map), fed by the real build script run against the real data into
 *      a temp dir (the tracked data/slug-redirects*.json are never touched).
 *
 * Run: npx tsx --test tests/unit/name-slug-redirects.test.ts
 */
// TESTS-VS-DERIVED-DATA-EXEMPT: structural — replays whatever data/shows.json holds through the JS
// and TS slug rules and asserts they agree and that retired slugs resolve only via the map; no show,
// person or venue fact is pinned (the one named case, Noël/Noel Coward, skips itself when absent).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAllUnifiedCreativeProfiles, getUnifiedCreativeProfile, getCategoriesForRole } from '../../src/lib/data-creative';
import {
  getAllTheaters,
  getTheaterBySlug,
  getAllLondonTheaters,
  getLondonTheaterBySlug,
  getAllOffBroadwayTheaters,
  getOffBroadwayTheaterBySlug,
} from '../../src/lib/data-core';
// src/lib/data-actors statically imports the gitignored data/cast-manifest.json,
// so it is loaded lazily (below) rather than at module top — see castEntries.
import { NAME_REDIRECT_PREFIXES, type NameRedirectFamily, type SlugRedirectMap } from '../../src/lib/slug-redirects';

const require = createRequire(import.meta.url);

type RawShow = { id: string; category?: string; venue?: string; _devOnly?: boolean; creativeTeam?: { name: string; role: string }[] };
type CastEntry = { showId: string; castType: string; name: string; ibdbPersonId?: string };

const sources = require('../../scripts/lib/page-name-sources.js') as {
  broadwayShows: (s: RawShow[]) => RawShow[];
  londonShows: (s: RawShow[]) => RawShow[];
  offBroadwayShows: (s: RawShow[]) => RawShow[];
  creativeNamesInPageOrder: (s: RawShow[]) => string[];
  broadwayTheaterNames: (s: RawShow[]) => string[];
  stubTheaterNames: (s: RawShow[]) => string[];
  actorIdentitiesInPageOrder: (e: CastEntry[], ids: Set<string>) => { ibdbPersonId: string; name: string }[];
};
const urlSlug = require('../../scripts/lib/url-slug.js') as {
  slugify: (s: string) => string;
  legacySlugify: (s: string) => string;
  assignUniqueSlugs: (names: string[], fn?: (s: string) => string) => string[];
};
const jsRoles = require('../../scripts/lib/creative-roles.js') as { getCategoriesForRole: (r: string) => string[] };
const jsEmitter = require('../../scripts/lib/name-slug-redirects.js') as { NAME_REDIRECT_PREFIXES: Record<string, string> };

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-slug-redirects.js');
const shows = (require('../../data/shows.json') as { shows: RawShow[] }).shows;
// data/cast-manifest.json is gitignored and built by scripts/build-cast-manifest.js
// (prebuild, the TypeScript Check job and land.yml's gauntlet). test.yml's
// Unit Tests job never builds it, so a hard require failed the whole file there
// (main red after batch 4, 2026-09-29). A missing manifest is the same case as
// the empty cloud stub: the cast test below skips, everything else still runs.
const castEntries = ((): CastEntry[] => {
  try {
    return (require('../../data/cast-manifest.json') as { entries: CastEntry[] }).entries;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return [];
    throw err;
  }
})();
type ActorsModule = typeof import('../../src/lib/data-actors');
let actorsModule: ActorsModule | null = null;
const actors = (): ActorsModule => {
  if (!actorsModule) actorsModule = require('../../src/lib/data-actors') as ActorsModule;
  return actorsModule;
};
const trackedCompact = require('../../data/slug-redirects-compact.json') as Record<string, string>;

// Array.from() throughout — downlevelIteration is off in tsconfig (same as src/).
const setEq = (a: string[], b: string[], label: string) => {
  const A = new Set(a);
  const B = new Set(b);
  const onlyA = Array.from(A).filter((x) => !B.has(x));
  const onlyB = Array.from(B).filter((x) => !A.has(x));
  assert.deepEqual({ onlyJs: onlyA, onlyTs: onlyB }, { onlyJs: [], onlyTs: [] }, label);
};

describe('parity: the JS page-name sources reproduce the TS page builders on the real data', () => {
  test('creative: creativeNamesInPageOrder + assignUniqueSlugs == getAllUnifiedCreativeProfiles() name → slug', () => {
    const names = sources.creativeNamesInPageOrder(sources.broadwayShows(shows));
    const slugs = urlSlug.assignUniqueSlugs(names);
    const js = new Map(names.map((n, i) => [n, slugs[i]]));
    const ts = new Map(getAllUnifiedCreativeProfiles().map((p) => [p.name, p.slug]));
    assert.ok(ts.size > 0);
    assert.equal(js.size, ts.size);
    for (const [name, slug] of Array.from(ts.entries())) assert.equal(js.get(name), slug, `${name}: page slug`);
    // The collision suffix is real on this data set whenever two spellings meet.
    const numbered = Array.from(ts.values()).filter((s) => /-\d+$/.test(s) && !js.has(s));
    for (const s of numbered) assert.ok(slugs.includes(s), `numbered slug ${s} comes from the shared rule`);
  });

  test('Broadway theaters: broadwayTheaterNames == getAllTheaters() names, slugs == slugify(name)', () => {
    const names = sources.broadwayTheaterNames(sources.broadwayShows(shows));
    const ts = getAllTheaters();
    setEq(names, ts.map((t) => t.name), 'theater names');
    setEq(names.map(urlSlug.slugify), ts.map((t) => t.slug), 'theater slugs');
  });

  test('West End venues: stubTheaterNames(londonShows) slugs == getAllLondonTheaters() slugs', () => {
    const names = sources.stubTheaterNames(sources.londonShows(shows));
    setEq(names.map(urlSlug.slugify), getAllLondonTheaters().map((t) => t.slug), 'london slugs');
  });

  test('Off-Broadway venues: stubTheaterNames(offBroadwayShows) slugs == getAllOffBroadwayTheaters() slugs', () => {
    const names = sources.stubTheaterNames(sources.offBroadwayShows(shows));
    setEq(names.map(urlSlug.slugify), getAllOffBroadwayTheaters().map((t) => t.slug), 'off-broadway slugs');
  });

  test(
    'cast: actorIdentitiesInPageOrder + assignUniqueSlugs == getAllActorProfiles() id → { name, slug }',
    { skip: castEntries.length === 0 ? 'data/cast-manifest.json is empty (cloud stub) — run scripts/build-cast-manifest.js' : false },
    () => {
      const ids = new Set(sources.broadwayShows(shows).map((s) => s.id));
      const identities = sources.actorIdentitiesInPageOrder(castEntries, ids);
      const slugs = urlSlug.assignUniqueSlugs(identities.map((a) => a.name));
      const js = new Map(identities.map((a, i) => [a.ibdbPersonId, { name: a.name, slug: slugs[i] }]));
      const ts = actors().getAllActorProfiles();
      assert.ok(ts.length > 0);
      assert.equal(js.size, ts.length);
      for (const p of ts) assert.deepEqual(js.get(p.ibdbPersonId), { name: p.name, slug: p.slug }, `${p.name} (${p.ibdbPersonId})`);
    }
  );

  test('getCategoriesForRole: the TS export is the shared scripts/lib/creative-roles.js table', () => {
    for (const role of ['Director', 'book writer', 'Music & Lyrics', 'Director & Choreographer', 'Music Supervisor & Director', 'Scenic Design', 'Book, Music, and Lyrics', 'Composer/Lyricist', 'associate director', '']) {
      assert.deepEqual(getCategoriesForRole(role), jsRoles.getCategoriesForRole(role), role);
    }
  });

  test('prefix parity with the emitter', () => {
    assert.deepEqual({ ...NAME_REDIRECT_PREFIXES }, jsEmitter.NAME_REDIRECT_PREFIXES);
  });
});

// ── the lookups, fed by the real build script over the real data ─────────────

function buildRealCompact(): SlugRedirectMap {
  const dir = mkdtempSync(join(tmpdir(), 'name-slug-redirects-ts-'));
  try {
    // Defaults for every input (data/shows.json, data/cast-manifest.json,
    // data/venue-complexes*.json, the critic registry if present) — only the
    // OUTPUT is redirected, so the tracked maps stay untouched.
    const res = spawnSync(process.execPath, [BUILD_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, SLUG_REDIRECTS_OUT_DIR: dir },
    });
    assert.equal(res.status, 0, `build-slug-redirects.js failed:\n${res.stdout}\n${res.stderr}`);
    return JSON.parse(readFileSync(join(dir, 'slug-redirects-compact.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const compact = buildRealCompact();
const keysOf = (map: SlugRedirectMap, family: NameRedirectFamily) =>
  Object.keys(map).filter((k) => k.startsWith(NAME_REDIRECT_PREFIXES[family]));
const oldSlugOf = (key: string, family: NameRedirectFamily) => key.slice(NAME_REDIRECT_PREFIXES[family].length);

type Lookup = (slug: string, redirects?: SlugRedirectMap) => { slug: string; name: string } | undefined;
const LOOKUPS: Record<NameRedirectFamily, Lookup> = {
  creative: getUnifiedCreativeProfile,
  theater: getTheaterBySlug,
  westEndTheater: getLondonTheaterBySlug,
  offBroadwayTheater: getOffBroadwayTheaterBySlug,
  cast: (slug, redirects) => actors().getActorBySlug(slug, redirects),
};

function assertFamilyResolves(map: SlugRedirectMap, family: NameRedirectFamily, viaDefault: boolean) {
  const lookup = LOOKUPS[family];
  for (const key of keysOf(map, family)) {
    const oldSlug = oldSlugOf(key, family);
    const live = map[key];
    const target = lookup(live);
    assert.ok(target, `${family}: ${oldSlug} → ${live}: the live slug must be a page`);
    assert.equal(target.slug, live);
    const viaAlias = viaDefault ? lookup(oldSlug) : lookup(oldSlug, map);
    assert.equal(viaAlias, target, `${family}: retired slug ${oldSlug} must resolve to the live page`);
    assert.equal(lookup(oldSlug, {}), undefined, `${family}: ${oldSlug} is not a live page — it resolves only through the map`);
    assert.equal(urlSlug.slugify(target.name) === oldSlug, false, `${family}: ${oldSlug} is not the folded slug of "${target.name}"`);
  }
}

describe('lookups fall back through the map (real data through the real build script)', () => {
  for (const family of Object.keys(NAME_REDIRECT_PREFIXES) as NameRedirectFamily[]) {
    const keys = keysOf(compact, family);
    test(
      `${NAME_REDIRECT_PREFIXES[family]} every retired slug resolves to its live page, and only via the map (${keys.length} entries)`,
      { skip: keys.length === 0 ? `no ${NAME_REDIRECT_PREFIXES[family]} entries on this data set (no accented name in the family)` : false },
      () => assertFamilyResolves(compact, family, false)
    );
  }

  const noel = getAllUnifiedCreativeProfiles().find((p) => p.name === 'Noël Coward');
  const noelAscii = getAllUnifiedCreativeProfiles().find((p) => p.name === 'Noel Coward');
  test(
    'Noël Coward: the retired no-l-coward lands on the page data-creative.ts assigns to "Noël Coward", never on "Noel Coward"',
    { skip: !noel || !noelAscii ? 'both spellings are not in this shows.json' : false },
    () => {
      assert.ok(noel && noelAscii);
      const oldSlug = urlSlug.legacySlugify('Noël Coward');
      assert.equal(oldSlug, 'no-l-coward');
      assert.notEqual(noel.slug, noelAscii.slug, 'two people, two pages');
      assert.equal(compact[NAME_REDIRECT_PREFIXES.creative + oldSlug], noel.slug, 'the redirect target is the collision handler\'s output for "Noël Coward"');
      assert.equal(getUnifiedCreativeProfile(oldSlug, compact)?.name, 'Noël Coward');
      assert.notEqual(getUnifiedCreativeProfile(oldSlug, compact), noelAscii);
      // Whoever reached noel-coward first keeps it; the other carries the suffix.
      const bare = urlSlug.slugify('Noël Coward');
      assert.ok([noel.slug, noelAscii.slug].includes(bare));
      assert.ok([noel.slug, noelAscii.slug].some((s) => s !== bare && s.startsWith(`${bare}-`)));
    }
  );

  test('the tracked data/slug-redirects-compact.json resolves through the default parameter (if it carries name entries)', () => {
    let any = false;
    for (const family of Object.keys(NAME_REDIRECT_PREFIXES) as NameRedirectFamily[]) {
      if (keysOf(trackedCompact, family).length === 0) continue;
      // The tracked map can carry cast entries (prebuild ran with the manifest)
      // while this job has none — the cast lookup needs src/lib/data-actors and
      // the gitignored manifest, so it is covered where the manifest exists
      // (land gauntlet, TypeScript Check), not loaded blind here.
      if (family === 'cast' && castEntries.length === 0) continue;
      any = true;
      assertFamilyResolves(trackedCompact, family, true);
    }
    if (!any) {
      // Prebuild regenerates the tracked map; a checkout whose last prebuild
      // predates this family set simply has nothing to check here.
      assert.ok(true, 'no name entries in the tracked map yet');
    }
  });

  test('an unknown slug is still undefined for every lookup', () => {
    for (const family of Object.keys(LOOKUPS) as NameRedirectFamily[]) {
      // The cast lookup loads src/lib/data-actors, which needs the gitignored
      // cast manifest; without it (Unit Tests job, cloud stub) the family is
      // covered by the cast test's skip above, not by a load failure here.
      if (family === 'cast' && castEntries.length === 0) continue;
      assert.equal(LOOKUPS[family]('no-such-page-xyz-123'), undefined, family);
      assert.equal(LOOKUPS[family]('no-such-page-xyz-123', compact), undefined, family);
    }
  });
});
