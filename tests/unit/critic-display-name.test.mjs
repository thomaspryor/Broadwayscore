/**
 * Unit tests for scripts/lib/critic-display-name.js — audit S7-T1 (BRO-4204).
 *
 * 11% of 2026 reviews carried critic "Unknown", and placeholders such as
 * "The Stage", "All That Dazzles", "Archive", "The Reviews Hub - London",
 * "Conde Nast", "Written by", "Reviewed by" were emitted as critics with
 * their own pages; only the exact string "Unknown" was filtered. Every
 * string below is a real corpus byline. The helper is required (§15), never
 * re-implemented here.
 *
 * Run: node --test tests/unit/critic-display-name.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  displayCriticName,
  isPlaceholderCritic,
  CRITIC_NAME_FIXES,
  PLACEHOLDER_BYLINES,
  titleCaseName,
} = require('../../scripts/lib/critic-display-name.js');
const { loadOutletRegistry, JUNK_BYLINES } = require('../../scripts/lib/review-normalization.js');
const { GENERIC_BYLINE_TERMS, normalizeForCompare } = require('../../scripts/lib/placeholder-byline.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registry = loadOutletRegistry();
const entry = (id) => {
  assert.ok(registry.outlets[id], `registry outlet ${id} exists`);
  return { id, ...registry.outlets[id] };
};

test('placeholders from the 2026 audit are not critics → null', () => {
  const table = [
    ['The Stage', 'The Stage', entry('thestage')],
    ['The Stage', 'Variety', entry('variety')],
    ['All That Dazzles', 'All That Dazzles  (UK)', entry('all-that-dazzles-uk')],
    ['All That Dazzles', undefined, undefined],
    ['Archive', 'The Guardian', undefined],
    ['The Reviews Hub - London', 'The Reviews Hub', entry('thereviewshub')],
    ['The Reviews Hub - London', undefined, undefined],
    ['Conde Nast', 'The New Yorker', undefined],
    ['Condé Nast', 'Vanity Fair', undefined],
    ['Written by Ziwen', 'Some Blog', undefined],
    ['Written by', 'Some Blog', undefined],
    ['Reviewed by', 'Some Blog', undefined],
    ['Unknown', 'Variety', entry('variety')],
    ['Team BWW', 'BroadwayWorld', entry('broadwayworld')],
    ['Team BWW', undefined, undefined],
    ['London Theatre Hub Editorial Team', 'London Theatre Hub', undefined],
    ['Staff', 'Variety', undefined],
    ['BWW News Desk', 'BroadwayWorld', undefined],
    ['Posted By', 'MD Theatre Guide', undefined],
    ['Uncredited', 'The Times', undefined],
    ['Time Out', 'Time Out New York', entry('timeout')],
    ['Variety Staff', 'Variety', entry('variety')],
    ['Guardian Stage', 'The Guardian', undefined],
    ['Financial Times', 'Financial Times', entry('financialtimes')],
    ['12345', 'Variety', undefined],
    ['', 'Variety', undefined],
    ['   ', 'Variety', undefined],
  ];
  for (const [raw, outlet, reg] of table) {
    assert.equal(displayCriticName(raw, outlet, reg), null, `${JSON.stringify(raw)} @ ${outlet}`);
    assert.equal(isPlaceholderCritic(raw, outlet, reg), true, `isPlaceholderCritic(${JSON.stringify(raw)})`);
  }
  assert.equal(displayCriticName(null), null);
  assert.equal(displayCriticName(undefined), null);
  assert.equal(displayCriticName(42), null);
});

test('S7-T5: thereviewshub no longer claims the edition label as its default critic', () => {
  assert.equal(registry.outlets.thereviewshub.defaultCritic, null);
});

test('suffix artifacts (job title, pronouns, HTML) are stripped last; the person survives', () => {
  assert.equal(displayCriticName('Dominic Cavendish, Chief Theatre Critic', 'The Telegraph', entry('telegraph')), 'Dominic Cavendish');
  assert.equal(displayCriticName('Sarah Crompton (she/her)', 'WhatsOnStage'), 'Sarah Crompton');
  assert.equal(displayCriticName('Michael Sommers<br>', 'New Jersey Stage'), 'Michael Sommers');
  assert.equal(displayCriticName('Michael Sommers>', 'New Jersey Stage'), 'Michael Sommers');
  assert.equal(displayCriticName('Sarah Crompton (she/her), Theatre Critic', 'WhatsOnStage'), 'Sarah Crompton');
});

test('diacritics are kept: "José Solís" stays "José Solís"', () => {
  assert.equal(displayCriticName('José Solís', 'Observer'), 'José Solís');
  assert.equal(displayCriticName('Juan A. Ramírez', 'The New York Times'), 'Juan A. Ramírez');
});

test('the 37 CRITIC_NAME_FIXES pairs resolve to their canonical (and the canonical is a fixed point)', () => {
  assert.equal(Object.keys(CRITIC_NAME_FIXES).length, 37);
  for (const [raw, canonical] of Object.entries(CRITIC_NAME_FIXES)) {
    assert.equal(displayCriticName(raw), canonical, `${JSON.stringify(raw)} → ${canonical}`);
    assert.equal(displayCriticName(canonical), canonical, `${canonical} is a fixed point`);
  }
  // Spot checks on the awkward keys.
  assert.equal(displayCriticName('CSA.     Naveen Kumar'), 'Naveen Kumar');
  assert.equal(displayCriticName('Daniel D&#8217;Addario'), "Daniel D'Addario");
  assert.equal(displayCriticName('Ben Brantley (Pt. 2)'), 'Ben Brantley');
  assert.equal(displayCriticName('Reviews Karen Galindo'), 'Karen Galindo');
  // Nancy Sasso Janis is the real Patch.com byline and must NOT be remapped.
  assert.equal(displayCriticName('Nancy Sasso Janis', 'Patch'), 'Nancy Sasso Janis');
});

test('one map: the fixes JSON is read by this helper only — src/lib/data-reviews.ts keeps neither a copy nor an import (S7-T2)', () => {
  const ts = readFileSync(path.join(repoRoot, 'src/lib/data-reviews.ts'), 'utf8');
  assert.doesNotMatch(ts, /import[^;]*critic-name-fixes\.json/, 'the site reads the emitted name, not the fixes table');
  assert.doesNotMatch(ts, /CRITIC_NAME_FIXES\s*[:=]/, 'no inline copy of the fixes map');
  assert.doesNotMatch(ts, /'Ben Brantly':/, 'no inline copy of the fixes map');
  const json = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/lib/critic-name-fixes.json'), 'utf8'));
  assert.deepEqual(json.fixes, CRITIC_NAME_FIXES);
});

test('rule 1: the outlet-scoped mis-attribution map runs first', () => {
  assert.equal(displayCriticName('David Finkle', 'Cote Notices', entry('cote-notices')), 'David Cote');
  assert.equal(displayCriticName('JK', "JK's Theatre Scene", entry('jks-theatre-scene')), 'Jeff Kyler');
  // Same critic at his own outlet is untouched.
  assert.equal(displayCriticName('David Finkle', 'New York Stage Review'), 'David Finkle');
});

test('rule 2: the alias table (CRITIC_ALIASES + cleaned auto file) canonicalizes typo variants', () => {
  assert.equal(displayCriticName('Ben Brantly', 'The New York Times'), 'Ben Brantley');
  // A suffix cannot hide a typo: lookups key on the stripped form.
  assert.equal(displayCriticName('Ben Brantly, Chief Theatre Critic', 'The New York Times'), 'Ben Brantley');
  assert.equal(displayCriticName('Chales McNulty', 'Los Angeles Times'), 'Charles McNulty');
  assert.equal(displayCriticName('Alesis Soloski', 'The Guardian'), 'Alexis Soloski');
  assert.equal(displayCriticName('Sara Hemming', 'Financial Times'), 'Sarah Hemming');
  // A raw string that already slugifies to the canonical keeps its own casing.
  assert.equal(displayCriticName('Jd Knapp', 'Variety'), 'Jd Knapp');
});

test('rule 3: the merged placeholder list is a superset of JUNK_BYLINES ∪ GENERIC_BYLINE_TERMS', () => {
  for (const term of [...JUNK_BYLINES, ...GENERIC_BYLINE_TERMS]) {
    assert.ok(PLACEHOLDER_BYLINES.has(normalizeForCompare(term)), `${term} in PLACEHOLDER_BYLINES`);
    assert.equal(displayCriticName(term, 'Variety'), null, `${term} → null`);
    assert.equal(displayCriticName(term.toUpperCase(), 'Variety'), null, `${term.toUpperCase()} → null`);
  }
  for (const term of ['archive', 'uncredited', 'condé nast', 'written by', 'reviewed by', 'staff']) {
    assert.ok(PLACEHOLDER_BYLINES.has(normalizeForCompare(term)), `${term} in PLACEHOLDER_BYLINES`);
  }
});

test('curated critics whose names are registry outlet ALIASES are people, not placeholders', () => {
  // outlet-registry.json lists "jesse-green" under nytimes, "adam-feldman"
  // under timeout, "chris-jones" under chicagotribune (legacy routing).
  assert.equal(displayCriticName('Jesse Green', 'The New York Times', entry('nytimes')), 'Jesse Green');
  assert.equal(displayCriticName('Adam Feldman', 'Time Out New York', entry('timeout')), 'Adam Feldman');
  assert.equal(displayCriticName('Chris Jones', 'Chicago Tribune', entry('chicagotribune')), 'Chris Jones');
  assert.equal(displayCriticName('Joe Dziemianowicz', 'New York Daily News', entry('nydailynews')), 'Joe Dziemianowicz');
  // Uncurated people the registry also carries as outlet aliases.
  assert.equal(displayCriticName('Mark Kennedy', 'Associated Press', entry('ap')), 'Mark Kennedy');
  assert.equal(displayCriticName('Michael Musto', 'Village Voice', entry('village-voice')), 'Michael Musto');
});

test('self-branded outlets: the registry byline is never a placeholder', () => {
  assert.equal(displayCriticName('Carole Di Tosti', 'Carole Di Tosti', entry('carole-di-tosti')), 'Carole Di Tosti');
  assert.equal(displayCriticName('Carole Di Tosti'), 'Carole Di Tosti');
  assert.equal(displayCriticName('Carey Purcell'), 'Carey Purcell');
  assert.equal(displayCriticName('Matt Trueman', 'Matt Trueman', entry('matttrueman')), 'Matt Trueman');
  // A synthetic registry entry with defaultCritic equal to the outlet name.
  const jane = { id: 'jane-blog', displayName: 'Jane Blog', aliases: ['jane-blog'], defaultCritic: 'Jane Blog' };
  assert.equal(displayCriticName('Jane Blog', 'Jane Blog', jane), 'Jane Blog');
});

test('rule 4: non-person shapes → null, recoverable shapes → the person', () => {
  assert.equal(displayCriticName('https://observer.com/author/rex-reed', 'Observer'), 'Rex Reed');
  assert.equal(displayCriticName('https://www.facebook.com/peoplemag', 'People'), null);
  assert.equal(displayCriticName('Christopher Kelly | NJ.com', 'NJ.com'), 'Christopher Kelly');
  assert.equal(displayCriticName('Written by Jane Doe', 'Some Blog'), 'Jane Doe');
  assert.equal(displayCriticName("Posted By: Aidan O'Connor", 'MD Theatre Guide'), "Aidan O'Connor");
  assert.equal(displayCriticName('Jane Doe — The Stage', 'The Stage', entry('thestage')), 'Jane Doe');
  assert.equal(displayCriticName('Ross', 'Front Mezz Junkies'), 'Ross');
  assert.equal(displayCriticName('ELYSA GARDNER', 'The New York Sun'), 'Elysa Gardner');
});

test('ordinary critics pass through unchanged', () => {
  for (const [name, outlet] of [
    ['Helen Shaw', 'The New Yorker'], ['Michael Riedel', 'New York Post'], ['Thom Geier', 'TheWrap'],
    ['Sara Holdren', 'Vulture'], ['Arifa Akbar', 'The Guardian'], ['Dominic Cavendish', 'The Telegraph'],
    ['Andrzej Łukowski', 'Time Out London'], ['Frank Rizzo', 'Variety'],
  ]) {
    assert.equal(displayCriticName(name, outlet), name);
  }
});

test('titleCaseName: alias-table spellings become display forms', () => {
  assert.equal(titleCaseName('chales mcnulty'), 'Chales McNulty');
  assert.equal(titleCaseName('a.d. amorosi'), 'A.D. Amorosi');
  assert.equal(titleCaseName('jd knapp'), 'JD Knapp');
  assert.equal(titleCaseName("shane o'neill"), "Shane O'Neill");
  assert.equal(titleCaseName('nicholas de jongh'), 'Nicholas de Jongh');
  assert.equal(titleCaseName('rob weinert-kendt'), 'Rob Weinert-Kendt');
});
