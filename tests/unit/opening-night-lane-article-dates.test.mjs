// BRO-7199: on Wanted's press night the lane saw Theatrely's review 2.5 minutes after it went up, could not read a publish
// date from the page (Webflow writes it as <div class="publish-date">, no structured data), and dropped it after three
// strikes; it was found by hand 76 minutes later. A section page is only useful if the lane can date what it links to,
// so every section-index outlet must have a dated article fixture, a feed that dates it, or a stated reason.
// TESTS-VS-DERIVED-DATA-EXEMPT: fixtures hold the date element only (links and structure, no article text).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const ls = require('../../scripts/lib/opening-night-lane/lane-sources.js');
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const FIX = path.join(ROOT, 'tests/fixtures/opening-night-lane/article-dates');
const REPLAY = path.join(ROOT, 'tests/fixtures/opening-night-lane/replay-wanted');

// Outlets whose section page is read but whose article pages need no fixture here, each with the reason.
const NO_FIXTURE = {
  guardian: 'dated by its feed (LANE_FEEDS: theguardian.com/stage/rss); article pages serve runners a challenge page',
  'lighting-and-sound-america': 'own listing parser (SECTION_INDEX_PARSERS) vouches for the link',
  'the-100-word-review': 'no review page has ever been ingested from it; add a fixture when one is',
};

const expected = (html) => (html.match(/<!--\s*expect:\s*(\d{4}-\d{2}-\d{2})\s*-->/) || [])[1];

test('every section-index outlet has an article-date fixture the lane can date, or a stated reason', () => {
  const outlets = [...new Set([...Object.keys(ls.T1_SECTION_INDEXES), ...Object.keys(ls.LANE_SECTION_INDEXES)])];
  const feedOutlets = new Set(ls.LANE_FEEDS.map((f) => f.outletId));
  const missing = [];
  for (const id of outlets) {
    if (d.SECTION_INDEX_PARSERS[id]) continue;
    const file = path.join(FIX, `${id}.html`);
    if (fs.existsSync(file)) continue;
    if (NO_FIXTURE[id]) { if (id === 'guardian') assert.ok(feedOutlets.has(id), 'guardian exemption needs its lane feed'); continue; }
    missing.push(id);
  }
  assert.deepEqual(missing, [], `section-index outlets with no article-date fixture: ${missing.join(', ')}. Save the page's `
    + `date element to tests/fixtures/opening-night-lane/article-dates/<id>.html and make extractPublishDate read it.`);
});

test('extractPublishDate dates every committed fixture', () => {
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.html'));
  assert.ok(files.length >= 10, 'fixture set unexpectedly small');
  for (const f of files) {
    const html = fs.readFileSync(path.join(FIX, f), 'utf8');
    const got = d.extractPublishDate(html);
    assert.ok(got, `${f}: no publish date read (the lane would drop this outlet's reviews as no-publish-date)`);
    const want = expected(html);
    if (want) assert.equal(String(got).slice(0, 10), want, `${f}: wrong date`);
  }
});

test('CMS byline dates: one element dates the page, disagreeing elements do not', () => {
  assert.equal(d.extractPublishDate('<div class="publish-date">November 8, 2026 10:00 PM</div>'), '2026-11-08');
  assert.equal(d.extractPublishDate('<span class="aos-ArticleDate aos-FL">Nov 3, 2026</span>'), '2026-11-03');
  const twoCards = '<div class="publish-date">November 8, 2026</div><div class="publish-date">October 2, 2026</div>';
  assert.equal(d.extractPublishDate(twoCards), null, 'a related-story card must never date the article');
  assert.equal(d.extractPublishDate('<div class="publish-date">November 8, 2026</div><div class="publish-date">November 8, 2026</div>'), '2026-11-08');
});

test('replay of Wanted (2026-11-09): the lane admits Theatrely from its section page', async () => {
  const pages = {
    'https://www.theatrely.com/reviews': fs.readFileSync(path.join(REPLAY, 'theatrely-reviews.html'), 'utf8'),
    'https://www.theatrely.com/post/the-clarke-sisters-get-their-broadway-debut-in-wanted-review':
      fs.readFileSync(path.join(REPLAY, 'theatrely-wanted.html'), 'utf8'),
  };
  const fetchText = async (u) => { const p = pages[String(u).replace(/\/$/, '')]; if (p) return p; throw new Error(`not recorded: ${u}`); };
  const show = { id: 'wanted-2022', title: 'Wanted', category: 'broadway', market: 'broadway', openingDate: '2026-11-08', venue: 'James Earl Jones Theatre', slug: 'wanted' };
  const r = await d.runDiscoveryPass({
    show, night: '2026-11-08', now: Date.parse('2026-11-09T03:05:00Z'), startedAt: Date.parse('2026-11-09T02:38:00Z'),
    fetchText, timeZone: 'America/New_York',
    adapters: [d.sectionIndexAdapter({ outlets: [{ outletId: 'theatrely', indexUrl: 'https://www.theatrely.com/reviews' }] })],
  });
  const hit = (r.admitted || []).find((a) => /wanted-review$/.test(a.url));
  assert.ok(hit, `Theatrely not admitted; rejected: ${JSON.stringify(r.rejected)}`);
  assert.equal(String(hit.publishDate).slice(0, 10), '2026-11-08');
});
