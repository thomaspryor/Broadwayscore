/**
 * BRO-7780: archived-HTML byline contract. One real page per tier-1/2 outlet, cut down to its
 * byline region and metadata (scripts/lib/byline-fixture-strip.js: no review text), each with the
 * critic the page prints. Every fixture runs through both readers that name a critic from a page:
 * the opening-night lane's extractMeta (inline-score.js realFetchPorts) and the shared reader that
 * ingest-urls.js calls (page-byline.js readPageByline). They must agree with each other and with
 * the expected name.
 *
 * Rebuild: node scripts/sweep-stored-bylines.js ... --save-html=<dir>, then
 *          node scripts/build-byline-fixtures.js --pages=<dir> --rows=<jsonl...>
 * Checked monthly against the live pages by scripts/check-byline-fixture-drift.js (data-health-check.yml,
 * the 3rd of each month).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const DIR = path.join(ROOT, 'tests/fixtures/byline-outlets');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const { readPageByline } = require('../../scripts/lib/page-byline.js');
const { realFetchPorts } = require('../../scripts/lib/opening-night-lane/inline-score.js');
const { sameCriticName } = require('../../scripts/lib/byline-from-text.js');
const lane = realFetchPorts({ fetchPage: async () => ({}) });
const html = (f) => zlib.gunzipSync(fs.readFileSync(path.join(DIR, f.file))).toString('utf8');
const quietly = (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; } };

// Outlets with no fixture, and why. A new tier-1/2 outlet must get a fixture or a line here.
const NO_FIXTURE = new Map(manifest.missing.map((m) => [m.outletId, m.reason]));

describe('every tier-1/2 outlet has a byline fixture (or a recorded reason it cannot)', () => {
  const reg = require('../../data/outlet-registry.json');
  const list = Array.isArray(reg.outlets) ? reg.outlets : Object.entries(reg.outlets || reg).map(([id, v]) => ({ id, ...v }));
  const tiers = list.filter((o) => o.tier === 1 || o.tier === 2).map((o) => o.id);
  test('coverage', () => {
    const have = new Set(manifest.fixtures.map((f) => f.outletId));
    const uncovered = tiers.filter((id) => !have.has(id) && !NO_FIXTURE.has(id));
    assert.deepEqual(uncovered, [], `tier-1/2 outlets with neither a fixture nor a recorded reason: ${uncovered.join(', ')}`);
  });
});

describe('lane and ingest name the printed critic on every fixture', () => {
  for (const f of manifest.fixtures) {
    test(`${f.file}: ${f.expected}`, () => {
      const page = html(f);
      const ingest = quietly(() => readPageByline({ html: page, url: f.url, outletId: f.outletId }).criticName);
      const meta = quietly(() => lane.extractMeta(page, f.url, { outletId: f.outletId }));
      assert.ok(ingest && sameCriticName(ingest, f.expected), `ingest reader: ${ingest}`);
      assert.equal(meta.criticName, ingest, 'lane extractMeta and the ingest reader disagree');
    });
  }
});

describe('fixtures carry no review text', () => {
  for (const f of manifest.fixtures) {
    test(f.file, () => {
      const page = html(f).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<title[\s\S]*?<\/title>|<h1[\s\S]*?<\/h1>/gi, '');
      const long = [...page.matchAll(/>([^<]{100,})</g)].map((m) => m[1].trim()).filter(Boolean);
      assert.deepEqual(long, [], 'a text node over 100 chars survived the strip');
      assert.ok(!/"articleBody"\s*:/.test(html(f)), 'JSON-LD articleBody survived');
    });
  }
});

// The TheaterMania editor trap (BRO-7745): a page whose structured author is the account that POSTED
// it, while the author tag prints the critic. Built from the real tommy page (stored as "Pete
// Hempstead", printed byline Jonas Schwartz) with the poster declared as a JSON-LD Person. A reader
// that trusts JSON-LD before the visible tag credits the poster and fails here.
describe('TheaterMania editor-vs-author trap', () => {
  const tommy = manifest.fixtures.find((f) => /1859212/.test(f.url));
  test('the tommy page is a fixture and names Jonas Schwartz', () => {
    assert.ok(tommy, 'tommy fixture missing from the manifest');
    assert.equal(tommy.expected, 'Jonas Schwartz');
  });
  test('a JSON-LD Person poster does not beat the visible author tag', () => {
    const ld = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","author":{"@type":"Person","name":"Pete Hempstead"}}</script>';
    const page = html(tommy).replace(/<head>|<head\b[^>]*>/i, (h) => h + ld);
    const meta = quietly(() => lane.extractMeta(page, tommy.url, { outletId: 'theatermania' }));
    assert.equal(meta.criticName, 'Jonas Schwartz');
    assert.equal(quietly(() => readPageByline({ html: page, url: tommy.url, outletId: 'theatermania' }).criticName), 'Jonas Schwartz');
  });
  test('with no url and no outlet the tag still wins (callers that pass neither)', () => {
    const ld = '<script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"Pete Hempstead"}}</script>';
    const page = html(tommy).replace(/<head>|<head\b[^>]*>/i, (h) => h + ld);
    assert.equal(quietly(() => lane.extractMeta(page, undefined, {})).criticName, 'Jonas Schwartz');
  });
});

describe('monthly drift check verdicts (check-byline-fixture-drift.js)', () => {
  const { classifyDrift } = require('../../scripts/check-byline-fixture-drift.js');
  test('same name, renamed critic, nobody, unreachable', () => {
    assert.equal(classifyDrift({ expected: 'Zachary Stewart' }, { criticName: 'Zach Stewart' }), 'same');
    assert.equal(classifyDrift({ expected: 'Jonas Schwartz' }, { criticName: 'David Gordon' }), 'drift');
    assert.equal(classifyDrift({ expected: 'Jonas Schwartz' }, { criticName: null }), 'drift');
    assert.equal(classifyDrift({ expected: 'Jonas Schwartz' }, { error: '403' }), 'unreachable');
  });
});

// BRO-7780 ship-check: saved pages were named by the last 60 base64 chars of the URL, so two
// URLs with the same tail shared one file and a fixture could bless the wrong page. One name
// function, used by both the sweep (writer) and the fixture builder (reader).
test('saved page names: whole-URL hash, one helper for writer and reader', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const fs = req('fs');
  const { savedPageName } = req('../../scripts/lib/byline-fixture-strip.js');
  const tail = '/review-' + 'x'.repeat(70) + '_1234/';
  const a = savedPageName('theatermania', 'https://www.theatermania.com/news' + tail);
  const b = savedPageName('theatermania', 'https://www.theatermania.com/broadway/reviews' + tail);
  if (a === b) throw new Error(`two URLs with the same tail share ${a}`);
  for (const f of ['scripts/sweep-stored-bylines.js', 'scripts/build-byline-fixtures.js']) {
    const src = fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    if (!/savedPageName\(/.test(src)) throw new Error(`${f} does not name saved pages with savedPageName`);
    if (/base64url'\)\.slice\(-60\)/.test(src)) throw new Error(`${f} still names pages by a base64 tail`);
  }
});
