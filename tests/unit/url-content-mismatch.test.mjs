/**
 * BRO-7060: URL→content mismatch detector (scripts/lib/url-content-mismatch.mjs).
 *
 * The BRO-7055 re-collect rejected 74 files as url_content_mismatch ("show
 * mentioned under 3 times"). Re-fetching them found one dominant false-positive
 * class: dedicated reviews whose page <title> names the show while the body
 * never repeats the title ("MIDDLEMARCH Swan, Stratford upon Avon | theatreCat",
 * 0 body mentions in ~5000 chars). The rest were real wrong pages: section
 * fronts, news items, a different show's review at the same URL.
 *
 * Every case below is taken from that audit (headlines verbatim, bodies are
 * synthetic filler with no show name). The real function is imported, never
 * copied (CLAUDE.md rule 15). A fixture catalog stands in for shows.json so the
 * test never reads live data.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CATALOG = [
  'Middlemarch', 'Bat Out of Hell', 'Birdland', 'A Small Family Business', 'Standing at the Sky\'s Edge',
  'Lazarus', 'One Day – The Musical', 'Triumph', 'Still', 'Into the Woods', 'The Shark Is Broken',
  'The Imaginary Invalid', '& Juliet', 'Romeo and Juliet', 'Broadway', 'Bleak Expectations', 'King Lear',
  'Pity', 'The Gap', 'Oklahoma!',
];

let tmpDir;
let prevShowsPath;
let m;
before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-content-mismatch-'));
  const p = path.join(tmpDir, 'shows.json');
  fs.writeFileSync(p, JSON.stringify({ shows: CATALOG.map((title, i) => ({ id: `fixture-${i}`, title })) }));
  prevShowsPath = process.env.SHOWS_JSON_PATH;
  process.env.SHOWS_JSON_PATH = p;
  m = await import('../../scripts/lib/url-content-mismatch.mjs');
});
after(() => {
  if (prevShowsPath === undefined) delete process.env.SHOWS_JSON_PATH;
  else process.env.SHOWS_JSON_PATH = prevShowsPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Review-shaped prose that never names any catalog show.
const SENTENCES = [
  'The production opens on a bare stage with a single chair and a lamp.',
  'Its lead actor gives a performance of real precision and warmth.',
  'The director keeps the pace brisk through a long first act.',
  'Set design leans on projection, which works better than expected.',
  'A second-act duet is the emotional high point of the evening.',
  'Some of the supporting cast are underused, which is a pity of sorts.',
];
function body(minChars) {
  let out = '';
  for (let i = 0; out.length < minChars; i++) out += `${SENTENCES[i % SENTENCES.length]} `;
  return out.trim();
}
const page = (title) => `<html><head><title>${title}</title></head><body></body></html>`;
const check = (showTitle, htmlTitle, text, extra = {}) => m.checkUrlContentMismatch({
  result: { text, html: htmlTitle == null ? '' : page(htmlTitle), method: 'playwright', ...(extra.result || {}) },
  showTitle,
  showId: extra.showId || 'fixture-show',
  url: extra.url || 'https://example.com/review',
  outletId: extra.outletId || 'example',
});

describe('false positives: dedicated review headline, title never repeated in the body', () => {
  test('MIDDLEMARCH Swan, Stratford upon Avon | theatreCat (0 mentions, 5000 chars) passes', () => {
    const r = check('Middlemarch', 'MIDDLEMARCH Swan, Stratford upon Avon | theatreCat', body(5000));
    assert.equal(r.mentionCount, 0);
    assert.equal(r.valid, true);
    assert.equal(r.waivedBy, 'review-headline');
  });

  test('"Theatre review: <title> from ..." prefix is stripped before the lead check', () => {
    const r = check('Bat Out of Hell', 'Theatre review: Bat Out of Hell from David Sonenberg, Michael Cohl, Randy Lennox and Tony Smith at Dominion Theatre', body(2900));
    assert.equal(r.valid, true);
    assert.equal(r.waivedBy, 'review-headline');
  });

  test('one-word title followed by a comma ("Birdland, theatre review: ...")', () => {
    const r = check('Birdland', "Birdland, theatre review: Sherlock's Moriarty Andrew Scott is excellent | The Independent", body(3400));
    assert.equal(r.valid, true);
  });

  test('long multi-word title anywhere in the headline', () => {
    const r = check("Standing at the Sky's Edge", "Richard Hawley's Standing at the Sky's Edge is a perfect musical love letter to Sheffield", body(2700));
    assert.equal(r.valid, true);
    assert.equal(r.waivedBy, 'review-headline');
  });

  test('blog post titled "<Blog name>: <show title>"', () => {
    const r = check('Lazarus', 'Act Three - The Reviews: Lazarus', body(1800));
    assert.equal(r.valid, true);
  });

  test('title with trailing "!" followed by prose ("Oklahoma! is a thrilling reinvention ...")', () => {
    const r = check('Oklahoma!', 'Oklahoma! is a thrilling reinvention that swaps the twee for sex and danger', body(2950));
    assert.equal(r.valid, true);
  });

  test('"The Gap review at Hope Mill" (short "The X" title followed by "review")', () => {
    assert.equal(check('The Gap', 'The Gap review at Hope Mill, Manchester by Anthony Banks', body(3000)).valid, true);
  });
});

describe('legitimate mismatches stay rejected', () => {
  test('subtitle prefix is not the title: "One Day – The Musical" vs ONE DAY WHEN WE WERE YOUNG', () => {
    const r = check('One Day – The Musical', 'Review: ONE DAY WHEN WE WERE YOUNG at Park Theatre - West End Theatre News and Reviews', body(3300));
    assert.equal(r.valid, false);
    assert.equal(r.waivedBy, null);
  });

  test('one-word title used as an ordinary word in the headline ("Is A Triumph Of")', () => {
    const r = check('Triumph', 'Oscar: Christopher Wheeldon’s Breathtaking Ballet Is A Triumph Of Theatrical Storytelling – Close-Up Culture', body(5000));
    assert.equal(r.valid, false);
  });

  test('"...Can Still Thrive" is not a review of "Still"', () => {
    assert.equal(check('Still', 'Mr. Broadway Proving That The Jewish Deli Can Still Thrive In New York City', body(4000)).valid, false);
  });

  test('multi-show headline: body was another show\'s section', () => {
    const r = check('Birdland', 'Birdland, Another Country and A Small Family Business - reviews | Theatre | Entertainment | Express.co.uk', body(3400));
    assert.equal(r.valid, false);
  });

  test('thin page under 1500 chars still needs a body mention', () => {
    const r = check('Into the Woods', 'Into the Woods | Maryland Theatre Guide', body(1045));
    assert.equal(r.valid, false);
  });

  test('a different show\'s review served at this URL (Talkin\' Broadway, 7 files on one URL)', () => {
    const r = check('The Shark Is Broken', 'Talkin\' Broadway on Broadway Review: "The Imaginary Invalid" - 10/22/26', body(4300));
    assert.equal(r.valid, false);
    assert.equal(r.waivedBy, null);
  });

  test('section front / homepage title', () => {
    assert.equal(check('Bleak Expectations', 'Theater - The New York Times', body(3800)).valid, false);
  });
});

describe('headlineProvesShow edge cases', () => {
  const cat = () => m.loadCatalogTitles();
  test('a shorter title inside a longer catalog title ("& Juliet" in "Romeo and Juliet")', () => {
    const h = 'Christian Camargo, Justin Guarini, Roslyn Ruff Join Orlando Bloom and Condola Rashad in Broadway’s Romeo and Juliet';
    assert.equal(m.headlineProvesShow(h, '& Juliet', { catalogTitles: cat() }).ok, false);
    assert.equal(m.headlineProvesShow(h, 'Romeo and Juliet', { catalogTitles: cat() }).ok, true);
  });
  test('short one-word title followed by more words is not the subject ("Broadway Will Dim the Lights")', () => {
    assert.equal(m.headlineProvesShow('Broadway Will Dim the Lights in Memory of Producer Stuart Thompson', 'Broadway', { catalogTitles: cat() }).ok, false);
    assert.equal(m.headlineProvesShow('Pity Party review – a riot', 'Pity', { catalogTitles: cat() }).ok, false);
    assert.equal(m.headlineProvesShow('Pity review – a riot', 'Pity', { catalogTitles: cat() }).ok, true);
  });
  test('roundup headlines never prove a show', () => {
    assert.equal(m.headlineProvesShow('Middlemarch and more: 5 shows to see this week', 'Middlemarch', { catalogTitles: cat() }).ok, false);
  });
  test('waiver only applies when the <title> matched the show', () => {
    const sanity = { valid: false, htmlTitle: 'Middlemarch, Swan Theatre', htmlTitleMatch: false };
    assert.equal(m.dedicatedReviewHeadlineWaiver(sanity, body(4000), 'Middlemarch', { catalogTitles: cat() }), false);
  });
});

describe('checkUrlContentMismatch keeps the collector\'s existing behaviour', () => {
  test('body with enough mentions passes with no waiver', () => {
    const text = `${body(1600)} Middlemarch is long. Middlemarch is good. Middlemarch ends well.`;
    const r = check('Middlemarch', 'Middlemarch review', text);
    assert.equal(r.valid, true);
    assert.equal(r.waivedBy, null);
  });
  test('pages-on-stages <title> is ignored (unreliable outlet): no headline waiver', () => {
    const r = check('Middlemarch', 'MIDDLEMARCH Swan, Stratford upon Avon', body(5000), { outletId: 'pages-on-stages' });
    assert.equal(r.htmlTitle, null);
    assert.equal(r.valid, false);
  });
  test('Guardian API headline waiver still applies through the detector', () => {
    const r = check('King Lear', null, body(3000), {
      result: { html: '', method: 'guardian-api', pageTitle: 'King Lear review – Ian McKellen is a fiery, mischievous king' },
    });
    assert.equal(r.valid, true);
    assert.equal(r.waivedBy, 'guardian-api');
  });
});
