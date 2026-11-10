// BRO-7171 Stage 5 class guard: every outlet extractor, run on real saved
// pages, must hand the save path a body with no page furniture in it.
//
// Fixtures (tests/fixtures/page-furniture/) are real archived review pages
// (data/archives/reviews) with their page structure and widgets kept and every
// prose run replaced by neutral filler (no review text in the public repo).
// Each one carried furniture into the stored body before this fix: The Stage's
// "Invest in The Stage" paywall line and author card, WhatsOnStage/TheaterMania
// related-story runs, Time Out's newsletter consent block, HuffPost's donation
// tiers, Observer's newsletter prompt, the Standard's booking line, the FT's
// copyright lines.
//
// Path: extractTextFromHtml (collector, outlet-first) -> textAsStored (the
// save-path cleaner). A new extractor or cleaner change that lets furniture
// through fails here. Advisory in test.yml first (CLAUDE.md rule 19).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { extractTextFromHtml } = require('../collect-review-texts.js');
const { textAsStored } = require('./stored-text-form.js');
const { detectPageFurniture } = require('./page-furniture.js');

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'page-furniture');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

// Strings that reached stored bodies before BRO-7171 (scripts/audit-page-furniture.js).
const KNOWN = [
  /Invest in The Stage/i,
  /^Latest Reviews$/im,
  /^Related (?:Stories|Articles)$/im,
  /By entering your email address/i,
  /Thanks for subscribing/i,
  /Everything in the (?:Silver|Gold) Tier/i,
  /^(?:Facebook|Email|Share:?)$/im,
  /^Buy tickets for /im,
  /^Leave a Comment$/im,
];

function stored(entry) {
  const html = fs.readFileSync(path.join(DIR, entry.file), 'utf8');
  return textAsStored(extractTextFromHtml(html, entry.url) || '');
}

test('fixture set covers the outlets the survey found', () => {
  assert.ok(manifest.length >= 8);
});

for (const entry of manifest) {
  test(`${entry.outlet}: stored body carries no page furniture (${entry.file})`, () => {
    const text = stored(entry);
    assert.ok(text.length >= 300, `extractor lost the body (${text.length} chars)`);
    assert.match(text, /Fixture paragraph \d+/, 'article prose missing');
    const hits = detectPageFurniture(text);
    assert.deepStrictEqual(hits, [], `furniture survived: ${hits.slice(0, 5).map((h) => `${h.category}: ${h.line}`).join(' | ')}`);
    for (const re of KNOWN) assert.doesNotMatch(text, re);
  });
}

test('the guard bites: with the kill switch on, furniture reaches the stored body', () => {
  process.env.PAGE_FURNITURE_DISABLED = 'true';
  try {
    const dirty = manifest.filter((e) => detectPageFurniture(stored(e)).length > 0);
    assert.ok(dirty.length >= 3, `only ${dirty.length} fixtures show furniture with the fix off`);
  } finally { delete process.env.PAGE_FURNITURE_DISABLED; }
});
