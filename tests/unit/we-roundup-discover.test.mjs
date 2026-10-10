/**
 * Unit + wiring tests for the WE roundup discovery libs extracted from
 * opening-night-poller.js (2026-07-10, WE completeness gate Phase A2).
 *
 * Parity contract: these libs are verbatim extractions of poller blocks
 * 1d (LBO), 1e (theatre.reviews), 1g (WestEndTheatre). The tests exercise the
 * same decision points the inline code had — title-mismatch rejection, star/
 * title content validation, table- vs section-format WET parsing — with
 * injected fetchers (no network). A wiring test asserts the poller actually
 * requires + calls the libs, so a future revert to inline code fails loudly
 * (CLAUDE.md §15 test-extraction pattern).
 *
 * Run: node --test tests/unit/we-roundup-discover.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { discoverWetRoundupRows } = require('../../scripts/lib/wet-roundup-discover.js');
const { discoverTrRoundupHtml } = require('../../scripts/lib/tr-roundup-discover.js');
const { discoverLboRoundupHtml } = require('../../scripts/lib/lbo-roundup-discover.js');

const noLog = () => {};
const SHOW = { id: 'springwood-west-end-2026', title: 'Springwood', venue: 'Hampstead Theatre', openingDate: '2026-06-19' };

describe('wet-roundup-discover', () => {
  test('table-format post → rows with outlet + stars (headers skipped)', async () => {
    const posts = [{
      id: 42, link: 'https://www.westendtheatre.com/12345/news/reviews/springwood-review-round-up/',
      date: '2026-06-20T10:00:00',
      title: { rendered: 'Springwood Review round-up' },
      content: { rendered: '<table>\n<tr>\n<td>Publication</td>\n<td>Rating</td>\n</tr>\n<tr>\n<td>The Guardian</td>\n<td>★★★★</td>\n</tr>\n<tr>\n<td>The Stage</td>\n<td>★★★</td>\n</tr>\n</table>' },
    }];
    const r = await discoverWetRoundupRows(SHOW, { fetchJSON: async () => posts, fetchPage: async () => { throw new Error('should not fetch page for table format'); }, log: noLog });
    assert.ok(r, 'expected a result');
    assert.equal(r.post.id, 42);
    assert.equal(r.post.date, '2026-06-20');
    const outlets = r.rows.map(x => x.outlet);
    assert.ok(outlets.includes('The Guardian'), 'Guardian row extracted');
    assert.ok(outlets.includes('The Stage'), 'Stage row extracted');
    assert.ok(!outlets.some(o => /publication|rating/i.test(o)), 'table headers skipped');
    assert.equal(r.rows.find(x => x.outlet === 'The Guardian').stars, 4);
  });

  test('title-mismatch posts are rejected (wrong show never yields rows)', async () => {
    const posts = [{
      id: 7, link: 'https://www.westendtheatre.com/99/news/reviews/paddington-review-round-up/',
      date: '2026-06-01T09:00:00',
      title: { rendered: 'Paddington The Musical Review round-up' },
      content: { rendered: '<table><tr><td>The Times</td><td>★★★★★</td></tr></table>' },
    }];
    const r = await discoverWetRoundupRows(SHOW, { fetchJSON: async () => posts, fetchPage: async () => null, log: noLog });
    assert.equal(r, null);
  });

  test('section-format fallback parses CSS classes + external review URL', async () => {
    const posts = [{
      id: 9, link: 'https://www.westendtheatre.com/55/news/reviews/springwood-reviews/',
      date: '2026-06-21T08:00:00',
      title: { rendered: 'Springwood reviews' },
      content: { rendered: '<p>no stars here</p>' },
    }];
    const pageHtml = `
      <div>
        <p class="reviewnewpubhead">Evening Standard</p>
        <p class="reviewnewstars">★★★★</p>
        <p class="reviewnewauthor">Nick Curtis</p>
        <a href="https://www.standard.co.uk/culture/theatre/springwood-review.html">read</a>
      </div>`;
    const r = await discoverWetRoundupRows(SHOW, { fetchJSON: async () => posts, fetchPage: async () => ({ content: pageHtml, source: 'test' }), log: noLog });
    assert.ok(r);
    assert.equal(r.rows.length, 1);
    assert.deepEqual(r.rows[0], { outlet: 'Evening Standard', stars: 4, critic: 'Nick Curtis', url: 'https://www.standard.co.uk/culture/theatre/springwood-review.html' });
  });

  test('WP-API error → null (never throws)', async () => {
    const r = await discoverWetRoundupRows(SHOW, { fetchJSON: async () => { throw new Error('boom'); }, fetchPage: async () => null, log: noLog });
    assert.equal(r, null);
  });
});

describe('tr-roundup-discover', () => {
  test('constructed URL accepted only with ⭑ + title word + cross-show pass', async () => {
    const goodHtml = 'x'.repeat(1100) + ' Springwood at Hampstead ⭑⭑⭑⭑ <title>Springwood reviews roundup</title>';
    const fetched = [];
    const r = await discoverTrRoundupHtml(SHOW, {
      fetchPage: async (url) => { fetched.push(url); return { content: goodHtml, source: 'test' }; },
      fetchJSON: async () => [],
      log: noLog,
    });
    assert.ok(r, 'expected roundup');
    assert.ok(r.url.includes('springwood'), 'constructed slug URL');
    assert.ok(fetched[0].includes('theatre.reviews/reviews-roundup/'), 'tried construction first');
  });

  test('page without star glyph rejected → falls to WP-API → null when API empty', async () => {
    const r = await discoverTrRoundupHtml(SHOW, {
      fetchPage: async () => ({ content: 'Springwood '.repeat(200), source: 'test' }), // long, has title, NO ⭑
      fetchJSON: async () => [],
      log: noLog,
    });
    assert.equal(r, null);
  });
});

describe('lbo-roundup-discover', () => {
  test('archive path: mismatching page title is rejected AND quarantined', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbo-'));
    const archDir = path.join(tmp, 'aggregator-archive', 'lbo-roundups');
    fs.mkdirSync(archDir, { recursive: true });
    const archPath = path.join(archDir, `${SHOW.id}.html`);
    fs.writeFileSync(archPath, '<html><head><title>Review: PADDINGTON THE MUSICAL at the Savoy</title></head><body>wrong show</body></html>');
    const r = await discoverLboRoundupHtml(SHOW, { dataDir: tmp, fetchPage: async () => null, log: noLog });
    assert.equal(r, null);
    assert.ok(!fs.existsSync(archPath), 'bad archive removed');
    assert.ok(fs.existsSync(archPath + '.mismatch'), 'bad archive quarantined');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('archive path: matching page title returned with source=archive', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbo-'));
    const archDir = path.join(tmp, 'aggregator-archive', 'lbo-roundups');
    fs.mkdirSync(archDir, { recursive: true });
    fs.writeFileSync(path.join(archDir, `${SHOW.id}.html`),
      '<html><head><title>Review: SPRINGWOOD at Hampstead Theatre</title></head><body>Great show ★★★★</body></html>');
    const r = await discoverLboRoundupHtml(SHOW, { dataDir: tmp, fetchPage: async () => null, log: noLog });
    assert.ok(r, 'expected archive hit');
    assert.equal(r.source, 'archive');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('poller wiring (extraction must stay wired — CLAUDE.md §15)', () => {
  test('opening-night-poller.js requires and calls all three discover libs', () => {
    const src = fs.readFileSync(new URL('../../scripts/opening-night-poller.js', import.meta.url), 'utf8');
    for (const [lib, fn] of [
      ['lbo-roundup-discover', 'discoverLboRoundupHtml('],
      ['tr-roundup-discover', 'discoverTrRoundupHtml('],
      ['wet-roundup-discover', 'discoverWetRoundupRows('],
    ]) {
      assert.ok(src.includes(`require('./lib/${lib}')`), `poller requires ${lib}`);
      assert.ok(src.includes(fn), `poller calls ${fn}`);
    }
    // REGRESSION: the inline discovery must NOT come back
    assert.ok(!src.includes("news-sitemap.xml'"), 'LBO sitemap fetch no longer inline in poller');
    assert.ok(!src.includes('reviewnewpubhead'), 'WET CSS parsing no longer inline in poller');
    assert.ok(!src.includes('theatre.reviews/wp-json'), 'TR WP-API no longer inline in poller');
  });
});
