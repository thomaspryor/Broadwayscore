/**
 * src/lib/data-reviews.ts critic grouping (2026 data audit, S7-T2 + S7-T3).
 *
 * reviews.json carries the display name displayCriticName() emitted, or null
 * for a byline that is not a person. This side groups by the emitted name's
 * URL slug (diacritics folded), excludes null, and keeps no name map. The
 * pure rule (criticProfileKey / groupReviewsByCritic / pickCriticDisplayName)
 * is required, never re-implemented (CLAUDE.md §15); the typo case goes
 * through the REAL emitter helper so the test proves the end-to-end path,
 * not a fixture that happens to agree. The getCriticBySlug cases run against
 * the real reviews.json, with the seed alias registry fed through the real
 * scripts/build-slug-redirects.js the way tests/unit/critic-slug-aliases.test.mjs
 * does (temp dir; the tracked data/slug-redirects*.json are never touched).
 *
 * Run: npx tsx --test tests/unit/data-reviews-critic-grouping.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  criticProfileKey,
  groupReviewsByCritic,
  pickCriticDisplayName,
  getAllCritics,
  getCriticBySlug,
  getCriticSlugByName,
  getAllCriticSlugs,
} from '../../src/lib/data-reviews';
import { slugify as dataCoreSlugify } from '../../src/lib/data-core';
import { CRITIC_REDIRECT_PREFIX } from '../../src/lib/slug-redirects';

const require = createRequire(import.meta.url);
const { displayCriticName } = require('../../scripts/lib/critic-display-name.js') as {
  displayCriticName: (raw: unknown, outlet?: string) => string | null;
};
const urlSlug = require('../../scripts/lib/url-slug.js') as { slugify: (s: string) => string };

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SEED_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'critic-slug-aliases.seed.json');
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-slug-redirects.js');

type Row = { criticName: string | null; id: number };
const row = (criticName: string | null, id: number): Row => ({ criticName, id });

describe('S7-T3 parity: src/lib/data-core.ts slugify is the shared url-slug rule', () => {
  test('folds diacritics exactly like scripts/lib/url-slug.js', () => {
    for (const s of ['José Solís', 'Juan A. Ramírez', 'Nilgün Yusuf', 'Rafer Guzmán', "Holly O'Mahony", 'Holly O’Mahony', 'Time Out New York']) {
      assert.equal(dataCoreSlugify(s), urlSlug.slugify(s), s);
    }
    assert.equal(dataCoreSlugify('José Solís'), 'jose-solis');
    assert.equal(dataCoreSlugify('Juan A. Ramírez'), 'juan-a-ramirez');
    assert.equal(dataCoreSlugify('Nilgün Yusuf'), 'nilgun-yusuf');
  });
});

describe('criticProfileKey', () => {
  test('null, empty, whitespace and the legacy "Unknown" sentinel have no critic page', () => {
    for (const v of [null, undefined, '', '   ', 'Unknown']) assert.equal(criticProfileKey(v), null, JSON.stringify(v));
  });

  test('a byline keys on its folded slug', () => {
    assert.equal(criticProfileKey('José Solís'), 'jose-solis');
    assert.equal(criticProfileKey('  Jesse Green '), 'jesse-green');
    assert.equal(criticProfileKey('···'), null, 'a name with no slug has no page');
  });
});

describe('groupReviewsByCritic', () => {
  test('null critics are excluded; no group is ever keyed by an empty slug', () => {
    const groups = groupReviewsByCritic([
      row(null, 1), // "Archive" / "The Stage" / "Written by" arrive as null from the emitter
      row('Jesse Green', 2),
      row(null, 3),
      row('Unknown', 4),
      row('', 5),
      row('Jesse Green', 6),
    ]);
    assert.deepEqual(groups.map((g) => g.slug), ['jesse-green']);
    assert.deepEqual(groups[0].reviews.map((r) => r.id), [2, 6]);
    assert.equal(groups[0].name, 'Jesse Green');
  });

  test('a typo variant groups with its canonical — through the real emitter helper, not a local map', () => {
    const canonical = displayCriticName('Ben Brantley', 'The New York Times');
    const fromTypo = displayCriticName('Ben Brantly', 'The New York Times');
    const fromSuffixedTypo = displayCriticName('Ben Brantly, Chief Theatre Critic', 'The New York Times');
    assert.equal(canonical, 'Ben Brantley');
    assert.equal(fromTypo, 'Ben Brantley');
    assert.equal(fromSuffixedTypo, 'Ben Brantley');
    const groups = groupReviewsByCritic([row(canonical, 1), row(fromTypo, 2), row(fromSuffixedTypo, 3)]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].slug, 'ben-brantley');
    assert.deepEqual(groups[0].reviews.map((r) => r.id), [1, 2, 3]);
    // And a placeholder the helper nulls never becomes a page.
    assert.equal(displayCriticName('Archive', 'The Guardian'), null);
    assert.equal(groupReviewsByCritic([row(displayCriticName('Archive', 'The Guardian'), 9)]).length, 0);
  });

  test('diacritic and punctuation spellings of one critic share ONE page (the emitter keeps each spelling)', () => {
    const a = displayCriticName('Juan A. Ramírez', 'The New York Times');
    const b = displayCriticName('Juan A. Ramirez', 'The New York Times');
    assert.equal(a, 'Juan A. Ramírez', 'the helper keeps the accented spelling');
    assert.equal(b, 'Juan A. Ramirez', 'and the unaccented one');
    const groups = groupReviewsByCritic([row(b, 1), row(a, 2), row(b, 3), row('Juan A Ramirez', 4)]);
    assert.equal(groups.length, 1, 'one page, not a page plus a collision-suffixed twin');
    assert.equal(groups[0].slug, 'juan-a-ramirez');
    assert.equal(groups[0].name, 'Juan A. Ramirez', 'the page is titled with the spelling most reviews carry');
    assert.deepEqual(Array.from(groups[0].spellings.entries()), [['Juan A. Ramirez', 2], ['Juan A. Ramírez', 1], ['Juan A Ramirez', 1]]);
  });

  test('groups keep first-seen order and reviews keep input order', () => {
    const groups = groupReviewsByCritic([row('Helen Shaw', 1), row('Jesse Green', 2), row('Helen Shaw', 3)]);
    assert.deepEqual(groups.map((g) => g.slug), ['helen-shaw', 'jesse-green']);
    assert.deepEqual(groups[0].reviews.map((r) => r.id), [1, 3]);
  });
});

describe('pickCriticDisplayName', () => {
  test('most reviews wins; ties keep diacritics, then the longer spelling, then alphabetical', () => {
    assert.equal(pickCriticDisplayName(new Map([['Jose Solis', 12], ['Jose Solís', 1]])), 'Jose Solis');
    assert.equal(pickCriticDisplayName(new Map([['Rafer Guzman', 2], ['Rafer Guzmán', 2]])), 'Rafer Guzmán');
    assert.equal(pickCriticDisplayName(new Map([['Dave B', 1], ['Dave B.', 1]])), 'Dave B.');
    assert.equal(pickCriticDisplayName(new Map([['Nicholas de Jongh', 1], ['Nicholas De Jongh', 1]])), 'Nicholas De Jongh');
    assert.equal(pickCriticDisplayName(new Map()), '');
  });
});

describe('real data: getAllCritics() is built from emitted names only', () => {
  test('no profile without a name, none for the legacy sentinel, every slug unique and equal to its own key', () => {
    const critics = getAllCritics();
    assert.ok(critics.length > 100, 'profiles exist');
    const slugs = new Set<string>();
    for (const c of critics) {
      assert.ok(typeof c.name === 'string' && c.name.trim().length > 0, 'profile has a name');
      assert.notEqual(c.name, 'Unknown');
      assert.equal(c.slug, criticProfileKey(c.name), `${c.name}: slug is the folded key of its display name`);
      assert.ok(!slugs.has(c.slug), `duplicate slug ${c.slug}`);
      slugs.add(c.slug);
      for (const r of c.reviews) {
        assert.equal(criticProfileKey(r.criticName), c.slug, `${c.name}: every review's byline keys to this page`);
        assert.equal(r.criticSlug, c.slug, `${c.name}: back-filled criticSlug`);
      }
    }
    assert.deepEqual(Array.from(slugs).sort(), Array.from(getAllCriticSlugs()).sort());
  });

  test('getCriticSlugByName resolves every spelling a page carries, and a folded-equivalent spelling it has not seen', () => {
    for (const c of getAllCritics()) {
      assert.equal(getCriticSlugByName(c.name), c.slug);
      for (const r of c.reviews) if (r.criticName) assert.equal(getCriticSlugByName(r.criticName), c.slug);
    }
    const anyAccented = getAllCritics().find((c) => /[^\x00-\x7f]/.test(c.name));
    if (anyAccented) {
      const folded = anyAccented.name.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      assert.equal(getCriticSlugByName(folded), anyAccented.slug, `${anyAccented.name}: unaccented spelling links to the same page`);
    }
    assert.equal(getCriticSlugByName('No Such Critic Xyz 123'), null);
  });
});

describe('getCriticBySlug: a retired slug resolves once the alias file maps it (seed registry through the real build script)', () => {
  function compactFromSeed(): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), 'critic-grouping-'));
    try {
      writeFileSync(join(dir, 'shows.json'), JSON.stringify({ shows: [{ id: 'hamilton-2015', slug: 'hamilton-2015' }] }));
      const res = spawnSync(process.execPath, [BUILD_SCRIPT], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, SLUG_REDIRECTS_SHOWS_PATH: join(dir, 'shows.json'), SLUG_REDIRECTS_OUT_DIR: dir, CRITIC_SLUG_ALIASES_PATH: SEED_PATH },
      });
      assert.equal(res.status, 0, `build-slug-redirects.js failed:\n${res.stdout}\n${res.stderr}`);
      return JSON.parse(readFileSync(join(dir, 'slug-redirects-compact.json'), 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const compact = compactFromSeed();
  const seeds = Object.keys(compact).filter((k) => k.startsWith(CRITIC_REDIRECT_PREFIX));

  test('the seed registry emits the three documented aliases', () => {
    assert.deepEqual(seeds.sort(), ['critic:jose-sol-s', 'critic:juan-a-ram-rez', 'critic:rafer-guzm-n']);
  });

  for (const key of seeds) {
    const oldSlug = key.slice(CRITIC_REDIRECT_PREFIX.length);
    const canonical = compact[key];
    const live = getCriticBySlug(canonical);
    test(`${oldSlug} → ${canonical}`, { skip: live ? false : `no ${canonical} profile in this reviews.json` }, () => {
      assert.ok(live);
      assert.equal(live.slug, canonical);
      assert.equal(getCriticBySlug(oldSlug, compact), live, 'retired slug resolves to the canonical profile through the alias map');
      assert.equal(getCriticBySlug(oldSlug, {}), undefined, 'and only through it: the retired slug is not a live page after the fold');
    });
  }

  test('an unknown slug stays undefined with or without the map', () => {
    assert.equal(getCriticBySlug('no-such-critic-xyz-123', compact), undefined);
    assert.equal(getCriticBySlug('no-such-critic-xyz-123'), undefined);
  });
});
