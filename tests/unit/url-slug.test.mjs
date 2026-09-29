/**
 * scripts/lib/url-slug.js — the ONE URL-slug rule (2026 data audit, S7-T3).
 *
 * Diacritics fold before slugifying, so a byline captured with and without
 * its accents is one critic page; the pre-fold slugs are the retired keys in
 * data/critic-slug-aliases.json (S5-T9) and 301 to the folded ones. The JS
 * copies that used to fold on their own (title-match.js foldDiacritics,
 * deduplication.js slugify) now go through this module, asserted here by
 * identity and by behaviour. The TS side's parity (src/lib/data-core.ts
 * slugify) is asserted in tests/unit/data-reviews-critic-grouping.test.ts.
 *
 * Run: node --test tests/unit/url-slug.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { foldDiacritics, slugify } = require('../../scripts/lib/url-slug.js');
const titleMatch = require('../../scripts/lib/title-match.js');
const dedup = require('../../scripts/lib/deduplication.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The rule src/lib/data-core.ts slugify() applied BEFORE S7-T3 (no fold).
 * Kept here, and only here, as the spec of what a retired /critics/<slug>
 * URL looked like — it is not production code any more.
 */
const legacySlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

test('S7-T3 acceptance: accented bylines fold to ASCII slugs', () => {
  assert.equal(slugify('José Solís'), 'jose-solis');
  assert.equal(slugify('Jose Solís'), 'jose-solis');
  assert.equal(slugify('Juan A. Ramírez'), 'juan-a-ramirez');
  assert.equal(slugify('Rafer Guzmán'), 'rafer-guzman');
  assert.equal(slugify('Nilgün Yusuf'), 'nilgun-yusuf');
  assert.equal(slugify('André Hereford'), 'andre-hereford');
  assert.equal(slugify('David John Chávez'), 'david-john-chavez');
});

test('the unaccented spelling and the accented spelling are one slug', () => {
  for (const [a, b] of [
    ['Jose Solis', 'Jose Solís'],
    ['Juan A. Ramirez', 'Juan A. Ramírez'],
    ['Rafer Guzman', 'Rafer Guzmán'],
    ['Nilgun Yusuf', 'Nilgün Yusuf'],
  ]) {
    assert.equal(slugify(a), slugify(b), `${a} / ${b}`);
  }
});

test('everything but the fold is the old rule: lowercase, non-alphanumeric runs → one hyphen, trimmed', () => {
  assert.equal(slugify('Laura Collins-Hughes'), 'laura-collins-hughes');
  assert.equal(slugify("Holly O'Mahony"), 'holly-o-mahony');
  assert.equal(slugify('Holly O’Mahony'), 'holly-o-mahony', 'curly apostrophe is a separator like the straight one');
  assert.equal(slugify('A.D. Amorosi'), 'a-d-amorosi');
  assert.equal(slugify('  The Hollywood Reporter '), 'the-hollywood-reporter');
  assert.equal(slugify('Sheridan Morley·'), 'sheridan-morley', 'a trailing middle dot is trimmed');
  assert.equal(slugify('···'), '');
  assert.equal(slugify(''), '');
  // Pure-ASCII input is untouched by the fold: identical to the legacy rule.
  for (const s of ['Jesse Green', 'Ben Brantley', 'Chris Jones', 'Time Out New York', "Playwrights' Horizons"]) {
    assert.equal(slugify(s), legacySlug(s), s);
  }
});

test('old slug → new slug for the three seeds in tests/fixtures/critic-slug-aliases.seed.json', () => {
  const seed = JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/critic-slug-aliases.seed.json'), 'utf8'));
  const expected = {
    'Jose Solís': ['jose-sol-s', 'jose-solis'],
    'Juan A. Ramírez': ['juan-a-ram-rez', 'juan-a-ramirez'],
    'Rafer Guzmán': ['rafer-guzm-n', 'rafer-guzman'],
  };
  for (const [name, [oldSlug, newSlug]] of Object.entries(expected)) {
    assert.equal(legacySlug(name), oldSlug, `${name}: retired slug is what the pre-fold rule produced`);
    assert.equal(slugify(name), newSlug, `${name}: canonical slug is what the folded rule produces`);
    assert.equal(seed[oldSlug], newSlug, `seed maps ${oldSlug} → ${newSlug}`);
    assert.notEqual(oldSlug, newSlug);
  }
});

test('foldDiacritics: NFKD + combining marks stripped; non-decomposing letters pass through unchanged', () => {
  assert.equal(foldDiacritics('José Solís'), 'Jose Solis');
  assert.equal(foldDiacritics('Dvořák'), 'Dvorak');
  assert.equal(foldDiacritics('Les Misérables'), 'Les Miserables');
  assert.equal(foldDiacritics('ﬁ'), 'fi', 'compatibility ligature (NFKD, not NFD)');
  assert.equal(foldDiacritics('Ｊｏｓｅ'), 'Jose', 'full-width letters (NFKD, not NFD)');
  assert.equal(foldDiacritics('Søren Łukasz Straße'), 'Søren Łukasz Straße', 'ø, ł, ß are not transliterated');
  assert.equal(foldDiacritics(null), '');
  assert.equal(foldDiacritics(undefined), '');
});

test('one implementation: title-match.js re-exports this fold and deduplication.js slugify folds through it', () => {
  assert.equal(titleMatch.foldDiacritics, foldDiacritics, 'same function object, not a copy');
  assert.equal(dedup.slugify('Les Misérables'), 'les-miserables');
  assert.equal(dedup.slugify('Café Society'), 'cafe-society');
  // title-match's own callers still get what they always did.
  assert.equal(titleMatch.normalizeTitle('Les Misérables'), titleMatch.normalizeTitle('Les Miserables'));
});
