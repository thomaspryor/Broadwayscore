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
const { readPageBylineForShow } = require('../../scripts/lib/page-byline-for-show.js');
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
  // 2026-11-18 live run: londontheatre1 answered a 200-byte SiteGround captcha (meta refresh to
  // /.well-known/sgcaptcha/) and was reported as drift. A page with no article text was not read.
  test('a challenge page with no article text is unreachable, not drift', () => {
    assert.equal(classifyDrift({ expected: 'Chris Omaweng' }, { criticName: null, textLength: 0 }), 'unreachable');
    assert.equal(classifyDrift({ expected: 'Chris Omaweng' }, { criticName: null, textLength: 4000 }), 'drift');
    assert.equal(classifyDrift({ expected: 'Chris Omaweng' }, { criticName: 'Chris Omaweng', textLength: 0 }), 'same');
  });
  // Cousin: the stored-byline sweep had the same hole (a captcha page read as 'no-page-byline',
  // which is the list that keeps a stored name). Both tools use one rule from page-byline.js.
  test('sweep: a page with no article text is fetch-failed, not no-page-byline', () => {
    const { classify } = require('../../scripts/sweep-stored-bylines.js');
    assert.equal(classify('David Gordon', { pageByline: null, textLength: 0 }), 'fetch-failed');
    assert.equal(classify('David Gordon', { pageByline: null, textLength: 4000 }), 'no-page-byline');
    assert.equal(classify('David Gordon', { pageByline: 'David Gordon', textLength: 0 }), 'match');
  });
  test('sweep and drift check share articleWasRead', async () => {
    const fs = await import('node:fs');
    for (const f of ['scripts/sweep-stored-bylines.js', 'scripts/check-byline-fixture-drift.js']) {
      const src = fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
      assert.match(src, /articleWasRead\(/, `${f} must use page-byline articleWasRead`);
    }
  });
  test('the drift run records the article text length it read', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../scripts/check-byline-fixture-drift.js', import.meta.url), 'utf8');
    assert.match(src, /live\.textLength\s*=/, 'check-byline-fixture-drift.js must set live.textLength for classifyDrift');
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

// BRO-7792: collect-review-texts' Unknown-critic enrichment (1B-iii) names the critic through the
// shared readPageByline, the same reader ingest, the sweep and the lane use. It used to call
// extractAuthorFromHtml directly and skipped the outlet rules (TheaterMania's visible author tag).
describe('collect-review-texts enrichment uses the shared reader (BRO-7792)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/collect-review-texts.js'), 'utf8');
  const start = src.indexOf('1B-iii. AUTHOR ENRICHMENT');
  const block = src.slice(start, src.indexOf('1B-iv.', start));
  test('the enrichment block calls readPageByline with excludeNames and publishDate, not extractAuthorFromHtml', () => {
    assert.ok(start > 0 && block.length > 100, 'enrichment block not found');
    assert.ok(/readPageBylineForShow\(/.test(block), 'enrichment must call readPageBylineForShow (readPageByline + excludeNames)');
    assert.ok(/excludeNames:\s*bylineExcludeNames/.test(block), 'excludeNames dropped');
    assert.ok(/publishDate/.test(block), 'publishDate dropped');
    assert.ok(!/extractAuthorFromHtml\(/.test(block), 'enrichment reverted to extractAuthorFromHtml');
  });
  for (const f of manifest.fixtures) {
    test(`${f.file}: enrichment path names ${f.expected}`, () => {
      const out = quietly(() => readPageBylineForShow({ html: html(f), text: '', url: f.url, outletId: f.outletId, excludeNames: ['Some Cast Member'], publishDate: '2026-01-01' }).criticName);
      assert.ok(out && sameCriticName(out, f.expected), `got ${out}`);
    });
  }
  test('a vetoed name falls back to the article text byline (old extractAuthorFromHtml behaviour)', () => {
    const page = '<html><head><meta name="author" content="Jane Castmember"></head><body><p>By John Critic</p></body></html>';
    const out = quietly(() => readPageBylineForShow({ html: page, text: 'By John Critic\n\nThe show opens with a long first paragraph about the production and its cast and many other things. '.repeat(3), url: 'https://example.com/r', excludeNames: ['Jane Castmember'] }));
    assert.equal(out.criticName, 'John Critic');
    const none = quietly(() => readPageBylineForShow({ html: page, text: '', url: 'https://example.com/r', excludeNames: ['Jane Castmember'] }));
    assert.equal(none.criticName, null);
  });
  test('the collector passes no outletId rather than the literal unknown', () => {
    assert.ok(/enrichOutlet !== 'unknown' \? enrichOutlet : undefined/.test(block), 'unknown outlet must not reach the reader');
  });
  test('an all-caps page byline is stored in proper case (new-york-sun fixture), mixed case untouched', () => {
    const f = manifest.fixtures.find((x) => x.outletId === 'new-york-sun');
    assert.equal(quietly(() => readPageBylineForShow({ html: html(f), url: f.url, outletId: f.outletId }).criticName), 'Elysa Gardner');
    const { properCase } = require('../../scripts/lib/page-byline-for-show.js');
    assert.equal(properCase("MARY O'BRIEN-SMITH"), "Mary O'Brien-Smith");
    assert.equal(properCase('Jesse Green'), 'Jesse Green');
  });
  test('excludeNames vetoes a cast name the page credits', () => {
    const f = manifest.fixtures[0];
    const base = quietly(() => readPageByline({ html: html(f), url: f.url, outletId: f.outletId }).criticName);
    assert.equal(quietly(() => readPageBylineForShow({ html: html(f), url: f.url, outletId: f.outletId, excludeNames: [base] }).criticName), null);
    assert.equal(quietly(() => readPageBylineForShow({ html: html(f), url: f.url, outletId: f.outletId }).criticName), base, 'wrapper must agree with the shared reader when nothing is excluded');
  });
});

// BRO-7792: the sweep's concurrent workers each saved the CURRENT console.log and restored it, so one
// worker could save the muted function and swallow every later line (the report) for good. One saved
// original, restored by every worker.
test('sweep-stored-bylines restores one saved console.log, never a per-worker copy of the current one', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/sweep-stored-bylines.js'), 'utf8');
  assert.ok(/const realLog = console\.log;/.test(src), 'realLog not saved once');
  assert.ok(/console\.log = realLog/.test(src), 'workers must restore realLog');
  assert.ok(!/const log = console\.log; console\.log = quiet/.test(src), 'a worker saves the current console.log (race)');
});

// BRO-7792 class guard: a script that names a critic from a fetched page goes through the shared reader
// (readPageByline / readPageBylineForShow), not extractAuthorFromHtml directly (which skips the outlet
// rules: TheaterMania's visible author tag, BRO-7745). New direct callers fail here; the ones below are
// the known remainder, each with why it is not converted yet. BRO-7798 converted the four backfill/replay scripts.
test('no script reads a page byline with extractAuthorFromHtml directly (allowlist of known remainder)', () => {
  const ALLOWED = new Map([
    ['scripts/sweep-stored-bylines.js', 'diagnostic: records every reader side by side'],
    ['scripts/lib/game-day/simulated-opening-night.js', 'game-day simulation'],
    ['scripts/lib/page-byline.js', 'the shared reader itself'],
    ['scripts/lib/page-byline-for-show.js', 'the shared reader wrapper'],
  ]);
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) { if (!/node_modules|fixtures/.test(e.name)) walk(rel); continue; }
      if (!/\.js$/.test(e.name) || /\.test\./.test(e.name) || rel === 'scripts/lib/content-quality.js') continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      // BRO-7798: a call, or an import / alias of it (`{ extractAuthorFromHtml: x } = require(...)`).
      if (/\bextractAuthorFromHtml\(/.test(src) || /\{[^}]*\bextractAuthorFromHtml\b[^}]*\}\s*=\s*require\(/.test(src)) found.push(rel);
    }
  };
  walk('scripts');
  const extra = found.filter((f) => !ALLOWED.has(f));
  assert.deepEqual(extra, [], `direct extractAuthorFromHtml callers (use readPageByline / readPageBylineForShow): ${extra.join(', ')}`);
});
