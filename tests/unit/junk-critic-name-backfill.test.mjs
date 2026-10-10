/**
 * BRO-4502: ~45 reviews displayed junk critic names ("Read more articles by
 * Carol Rocamora", "Sam - Admin", "nick730", "National Theatre", "Huffington
 * Post (Steven Suskin)"). backfill-unknown-critics Phase B only handled
 * criticName "Unknown", and the guarded write path (review-file-writer
 * applyPageByline, BRO-4485) refused any file not named --unknown.json.
 *
 * isJunkCriticName: a strict pattern list (never first-name-only bloggers or
 * co-author bylines). nameFromJunkCriticName: the real name when the junk
 * carries it verbatim. pageBylineRefusal/applyPageByline: a junk-named file
 * gets the same guarded rename an --unknown file gets; a real name is never
 * replaced.
 *
 * Run: node --test tests/unit/junk-critic-name-backfill.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isJunkCriticName, nameFromJunkCriticName } = require('../../scripts/lib/byline-recovery');
const { applyPageByline, pageBylineRefusal } = require('../../scripts/lib/review-file-writer');
const { generateReviewFilename } = require('../../scripts/lib/review-normalization');

// Every junk name the 2026-10-01 corpus scan found (BRO-4502 issue list).
const JUNK = [
  'Read more articles by Carol Rocamora', 'View more posts', 'View my Complete',
  'Sam - Admin', 'Lily - Admin', 'LALadmin', 'OperaWireAdmin2', 'helena6', 'nick730',
  'cupor1', 'Guest Author', 'National Theatre', 'York Magazine', 'London Theatre Direct',
  'Morris Theatre DC', 'J. Friedman Theatre', "Holly O'", 'Huffington Post (Steven Suskin)',
  'Laura Hackett, Fiction Editor', 'Debra C ArgenEdward F Nesta', 'Shanxi Radio and',
];
// Real bylines the same scan found that fail isPlausiblePersonName and must
// never be put up for replacement.
const LEGIT = [
  'Ross', 'Neil', 'Aaron', 'Jonathan', 'Genevieve', 'Bee (UK)', 'A.m.h.',
  'Sara Holdren and Jesse David Fox', 'Sara Holdren, Jackson McHenry', 'Sara Holdren/Jackson McHenry',
  'Nancy van Valkenburg', 'Natalie de la Garza', 'John R. Ziegler and Leah Richards',
  'Sue Weston and Susan', 'Jacques le Sourd', 'Barbara Siegel & Scott Siegel',
  'Dan Dinero & Molly Marinik', 'Nicky & Rosie Chambers', 'Elliot & Tom', 'Shahnaz (Shiny) Hussain',
  'Nicholas de Jongh', 'Charles McNulty', 'Ben Brantley', 'Mary MacDonald', 'Jesse Green',
  // name-first bylines with the outlet in parens (ship-check)
  'Peter Marks (The Washington Post)', 'Mary Smith (Mary Jones)', 'Victoria Myers (Intermission Magazine)',
];

describe('isJunkCriticName', () => {
  for (const n of JUNK) test(`junk: ${n}`, () => assert.equal(isJunkCriticName(n), true));
  for (const n of LEGIT) test(`legit: ${n}`, () => assert.equal(isJunkCriticName(n), false));
  test('Unknown / empty are not "junk" (handled as Unknown already)', () => {
    assert.equal(isJunkCriticName('Unknown'), false);
    assert.equal(isJunkCriticName(''), false);
    assert.equal(isJunkCriticName(null), false);
  });
});

describe('nameFromJunkCriticName', () => {
  test('Exeunt author-box prefix', () => {
    assert.equal(nameFromJunkCriticName('Read more articles by Carol Rocamora'), 'Carol Rocamora');
    assert.equal(nameFromJunkCriticName('Read more articles by Lorin Wertheimer'), 'Lorin Wertheimer');
  });
  test('outlet label with the byline in parens', () => {
    assert.equal(nameFromJunkCriticName('Huffington Post (Steven Suskin)'), 'Steven Suskin');
  });
  test('no verbatim name: null (re-read the page instead)', () => {
    for (const n of ['Sam - Admin', 'nick730', 'View more posts', 'Bee (UK)', 'Shahnaz (Shiny) Hussain', 'Read more articles by']) {
      assert.equal(nameFromJunkCriticName(n), null, n);
    }
  });
});

describe('orderCriticCandidates', () => {
  const { orderCriticCandidates } = require('../../scripts/backfill-unknown-critics');
  test('verbatim-name junk goes ahead of open-show Unknowns (no fetch needed)', () => {
    const e = (dir, criticName) => ({ dir, file: `${dir}.json`, data: { criticName, url: `https://x.com/${dir}` } });
    const out = orderCriticCandidates([
      e('open-unknown', 'Unknown'),
      e('closed-admin', 'Sam - Admin'),
      e('closed-exeunt', 'Read more articles by Carol Rocamora'),
    ], { openShowIds: new Set(['open-unknown']) });
    assert.deepEqual(out.map(x => x.dir), ['closed-exeunt', 'open-unknown', 'closed-admin']);
  });
});

function setup(files, show = 'bro-4502-junk-show') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4502-junk-'));
  const showDir = path.join(dir, show);
  fs.mkdirSync(showDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(showDir, name), JSON.stringify({ showId: show, ...data }, null, 2));
  }
  return { show, fp: name => path.join(showDir, name), read: name => JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf8')), list: () => fs.readdirSync(showDir).sort() };
}

describe('applyPageByline on a junk-named file', () => {
  const URL = 'https://exeuntnyc.com/reviews/review-kyoto-at-lincoln-center-theater/';
  const JUNK_NAME = 'Read more articles by Carol Rocamora';
  const junkFile = generateReviewFilename('exeunt-magazine', JUNK_NAME);

  test('renames to the recovered name and keeps every other field', () => {
    const t = setup({ [junkFile]: { outletId: 'exeunt-magazine', outlet: 'Exeunt', criticName: JUNK_NAME, url: URL, assignedScore: 72 } });
    const r = applyPageByline(t.fp(junkFile), t.read(junkFile), { showId: t.show, criticName: 'Carol Rocamora', source: 'junk-byline' });
    assert.equal(r.applied, true, r.reason);
    assert.deepEqual(t.list(), ['exeunt-magazine--carol-rocamora.json']);
    const d = t.read('exeunt-magazine--carol-rocamora.json');
    assert.equal(d.criticName, 'Carol Rocamora');
    assert.equal(d.assignedScore, 72);
    assert.equal(d.criticEnrichedFrom, 'page-byline:junk-byline');
  });

  test('a real stored name is never replaced', () => {
    const t = setup({ 'exeunt-magazine--ross.json': { outletId: 'exeunt-magazine', criticName: 'Ross', url: URL } });
    assert.equal(pageBylineRefusal(t.fp('exeunt-magazine--ross.json'), t.read('exeunt-magazine--ross.json'), { showId: t.show, criticName: 'Carol Rocamora' }), 'not-unknown-file');
  });

  test('a junk name is never written as the new name', () => {
    const t = setup({ 'exeunt-magazine--unknown.json': { outletId: 'exeunt-magazine', criticName: 'Unknown', url: URL } });
    assert.equal(pageBylineRefusal(t.fp('exeunt-magazine--unknown.json'), t.read('exeunt-magazine--unknown.json'), { showId: t.show, criticName: 'Lily - Admin' }), 'implausible-name');
  });

  test('a same-outlet sibling with the recovered name blocks the rename (nothing deleted)', () => {
    const t = setup({
      [junkFile]: { outletId: 'exeunt-magazine', criticName: JUNK_NAME, url: URL },
      'exeunt-magazine--carol-rocamora.json': { outletId: 'exeunt-magazine', criticName: 'Carol Rocamora', url: URL + '?amp' },
    });
    const r = applyPageByline(t.fp(junkFile), t.read(junkFile), { showId: t.show, criticName: 'Carol Rocamora' });
    assert.equal(r.applied, false);
    assert.equal(t.list().length, 2);
  });

  test('locked / hand-set junk files are left alone', () => {
    const t = setup({ [junkFile]: { outletId: 'exeunt-magazine', criticName: JUNK_NAME, url: URL, criticNameManual: true } });
    assert.equal(pageBylineRefusal(t.fp(junkFile), t.read(junkFile), { showId: t.show, criticName: 'Carol Rocamora' }), 'locked-or-manual');
  });
});
