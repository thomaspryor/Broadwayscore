/**
 * Article extractor — generic <article> fallback must pick the LARGEST match.
 *
 * Background: Joe Turner 2026-04-26. NY Sun's article page has 8 sidebar
 * teaser cards each wrapped in <article class="group/article-teaser">. The
 * old extractor took the first <article> match (a small Mamdani teaser),
 * yielded 113 chars about a different story, and the URL→content sanity
 * guard rejected the whole page as url_content_mismatch. The Elysa Gardner
 * Joe Turner review never landed.
 *
 * Fix: for generic (no host-specific) <article>/<main> fallbacks, iterate
 * all matches and keep the LARGEST. Real article bodies are multi-KB;
 * teaser cards are <1KB. Host-specific patterns still use first-match
 * because they're targeted enough to be unique.
 *
 * Also covers: validateContentMentionsShow normalizes curly→straight quotes
 * before token matching. shows.json titles use ASCII apostrophes
 * ("Joe Turner's") while most outlets render curly ones ("Joe Turner's").
 * Without normalization the multi-word title token never matched.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';
import pkg from '../../scripts/lib/content-quality.js';
const { validateContentMentionsShow } = pkg;

describe('article-extractor: newyorktheater.me cuts at Jetpack chrome', () => {
  test('truncates entry-content at <div class="sharedaddy">', () => {
    const html =
      '<html><body><article>' +
      '<div class="entry-content clearfix">' +
        '<p>' + 'Real review body. '.repeat(40) + '</p>' +
        '<p>More review prose with critical evaluation of the production.</p>' +
        '<div class="sharedaddy sd-sharing-enabled">' +
          '<p>Reading Broadway: The Books behind the 2025-2026 Season</p>' +
          '<p>Coming soon: Tina Turner and The Temptations</p>' +
        '</div>' +
      '</div></article></body></html>';
    const text = extractArticleText(html, 'newyorktheater.me');
    assert.ok(text, 'extractor should return text');
    assert.ok(text.includes('Real review body'));
    assert.ok(text.includes('critical evaluation'));
    assert.ok(!text.includes('Reading Broadway'), `chrome leaked through: …${text.slice(-200)}`);
    assert.ok(!text.includes('Tina Turner'), 'related-posts content leaked through');
  });

  test('falls back to </div></article> when no Jetpack chrome present', () => {
    const html =
      '<html><body><article>' +
      '<div class="entry-content clearfix">' +
        '<p>' + 'A clean older post body. '.repeat(40) + '</p>' +
      '</div></article></body></html>';
    const text = extractArticleText(html, 'newyorktheater.me');
    assert.ok(text, 'extractor should return text');
    assert.ok(text.includes('clean older post body'));
  });
});

describe('article-extractor: generic <article> picks largest match', () => {
  test('single <article> on page returns that article', () => {
    const html =
      '<html><body><article>' +
      'Body text. '.repeat(50) +
      '</article></body></html>';
    const text = extractArticleText(html, 'unknown.com');
    assert.ok(text, 'should extract text from single article');
    assert.ok(text.includes('Body text'));
  });

  test('multiple <article> tags: returns the largest, not the first', () => {
    const teaser =
      '<article class="teaser">' +
      'Tiny sidebar teaser. '.repeat(20) +
      '</article>';
    const main =
      '<article class="main">' +
      'Real article body. '.repeat(100) +
      '</article>';
    // Teaser FIRST in DOM order — old code would pick this and reject the page.
    const html = `<html><body>${teaser}${main}</body></html>`;
    const text = extractArticleText(html, 'unknown.com');
    assert.ok(text, 'should extract text');
    assert.ok(
      text.includes('Real article body'),
      `expected main article body in extracted text, got: ${text.slice(0, 100)}…`
    );
    assert.ok(
      !text.includes('Tiny sidebar teaser'),
      'teaser content should NOT appear when a larger article exists'
    );
  });
});

describe('validateContentMentionsShow: diacritic folding', () => {
  // Regression for the 2026-07-30 pipeline-health-audit fix. showId slugs are
  // ASCII ("les-miserables-...") while outlets spell the show correctly
  // ("Les Misérables"), so before NFD folding NO showId token could match a
  // correctly-accented headline. The <title> backstop then rejected genuine
  // reviews as url_content_mismatch: the NY Sun's review of Les Misérables:
  // The Arena Concert Spectacular had 12 body mentions and was still dropped.
  const ACCENTED_TITLE = 'Les Misérables: The Arena Concert Spectacular';
  const ACCENTED_ID = 'les-miserables-arena-concert-spectacular-off-broadway-2026';

  test('accented <title> matches the ASCII showId token', () => {
    const html =
      '<html><head><title>Les Misérables Revolutionizes Radio City With a Vengeance ' +
      '| The New York Sun</title></head><body></body></html>';
    const text =
      'Les Misérables: The Arena Concert Spectacular opened at Radio City Music Hall. '.repeat(3) +
      'The staging is vast. '.repeat(60);
    const result = validateContentMentionsShow(text, html, ACCENTED_TITLE, ACCENTED_ID);
    assert.strictEqual(result.valid, true, `expected valid, got: ${result.reason}`);
    assert.strictEqual(result.htmlTitleMatch, true, 'accented <title> should match the folded token');
  });

  test('folding does NOT let a different show pass (CDN misroute still rejected)', () => {
    const wrongText = "Everybody's Talking About Jamie is a joyous coming-of-age musical. ".repeat(20);
    const wrongHtml = "<title>Everybody's Talking About Jamie review | The New York Sun</title>";
    const result = validateContentMentionsShow(wrongText, wrongHtml, ACCENTED_TITLE, ACCENTED_ID);
    assert.strictEqual(result.valid, false, 'a wrong-show page must still be rejected');
  });

  test('folding does NOT let a roundup page pass on a single mention', () => {
    const html =
      '<title>5 shows to see this week: Les Misérables and more | The New York Sun</title>';
    const text = 'Les Misérables is one of five. ' + 'filler text here. '.repeat(120);
    const result = validateContentMentionsShow(text, html, ACCENTED_TITLE, ACCENTED_ID);
    assert.strictEqual(result.valid, false, 'a roundup <title> must still be rejected');
  });
});

describe('validateContentMentionsShow: curly quote normalization', () => {
  test("'Joe Turner's' (curly) matches showTitle 'Joe Turner's' (straight)", () => {
    // Text uses curly apostrophe (U+2019) — what the NY Sun and most major
    // outlets actually render. shows.json title uses ASCII apostrophe.
    const text =
      '‘Joe Turner’s Come and Gone’ Triumphantly Returns on Broadway. ' +
      'Director Debbie Allen and an excellent cast play August Wilson’s music beautifully ' +
      'in a new revival of this haunting classic.';
    const result = validateContentMentionsShow(
      text,
      null,
      "Joe Turner's Come and Gone",
      'joe-turners-come-and-gone-2026'
    );
    assert.strictEqual(result.valid, true, `expected valid, got: ${result.reason}`);
    assert.ok(result.mentionCount >= 1, `expected at least 1 mention, got ${result.mentionCount}`);
  });

  test('HTML <title> with curly quotes matches straight-quote token', () => {
    const html =
      '<html><head><title>‘Joe Turner’s Come and Gone’ Returns | Sun</title></head>' +
      '<body><p>Joe Turner’s Come and Gone is a powerful revival.</p></body></html>';
    const text =
      'Joe Turner’s Come and Gone is a powerful revival. ' +
      'August Wilson’s play returns to Broadway with a strong cast.';
    const result = validateContentMentionsShow(
      text,
      html,
      "Joe Turner's Come and Gone",
      'joe-turners-come-and-gone-2026'
    );
    assert.strictEqual(result.htmlTitleMatch, true, 'curly-quote title should match straight-quote token');
  });

  test("possessive title: body usage 'Joe Turner' counts toward show-mention threshold", () => {
    // Long-form review (>1500 chars, threshold=3) where the body uses the
    // SHORT form "Joe Turner" (the protagonist's name) but the full title
    // "Joe Turner's Come and Gone" only appears in the headline. Without the
    // before-apostrophe-s token the validator counted 1 and rejected.
    const text =
      'Joe Turner’s Come and Gone Triumphantly Returns on Broadway. '.padEnd(200, ' ') +
      ('Joe Turner is a powerful presence in this revival. '.repeat(10)) +
      ('Director Debbie Allen leans into August Wilson’s lyrical rhythms. '.repeat(15));
    assert.ok(text.length >= 1500, 'fixture must exceed long-text threshold');
    const result = validateContentMentionsShow(
      text,
      null,
      "Joe Turner's Come and Gone",
      'joe-turners-come-and-gone-2026'
    );
    assert.strictEqual(result.valid, true, `expected valid, got: ${result.reason}`);
    assert.ok(result.mentionCount >= 3, `expected >=3 mentions, got ${result.mentionCount}`);
  });

  test('single-word possessive title (Hells Kitchen) matches body usage of Hell', () => {
    // 47 shows in shows.json have single-word possessive titles ("Hell's
    // Kitchen", "It's Only a Play", "Marvin's Room"). Original `/\\s/.test(prefix)`
    // check filtered all of them out — caught in QA review 2026-04-27.
    const text =
      'Hell’s Kitchen returns to Broadway. The new musical from Alicia Keys.'.padEnd(200, ' ') +
      ('Hell, somehow, finds room for innovation. '.repeat(10)) +
      ('The score is brilliant and the staging inventive. '.repeat(20));
    assert.ok(text.length >= 1500, 'fixture must exceed long-text threshold');
    const result = validateContentMentionsShow(
      text,
      null,
      "Hell's Kitchen",
      'hells-kitchen-2024'
    );
    assert.strictEqual(result.valid, true, `expected valid, got: ${result.reason}`);
    assert.ok(result.mentionCount >= 3, `expected >=3 mentions, got ${result.mentionCount}`);
  });

  test('htmlTitleMatch=true relaxes threshold by 1 (Beaches NY Sun case)', () => {
    // Single-word show title where the body mentions it 2× in a >1500-char
    // article. Without the htmlTitleMatch relaxation, threshold=3 would reject
    // even though the page is provably about the show (title contains it).
    // Beaches NY Sun 2026-04-27 incident.
    const text = 'Beaches washes up on Broadway. '.padEnd(2500, ' ') + 'Some final thoughts about Beaches musical.';
    const html = '<html><head><title>‘Beaches’ Washes Up on Broadway | The New York Sun</title></head><body></body></html>';
    const result = validateContentMentionsShow(text, html, 'Beaches', 'beaches-2026');
    assert.strictEqual(result.valid, true, `expected valid (htmlTitleMatch should relax threshold), got: ${result.reason}`);
    assert.strictEqual(result.htmlTitleMatch, true);
  });

  test('htmlTitleMatch=true does NOT let through pages with 0 body mentions', () => {
    // Even with title match, require at least 1 body mention. A title-only
    // page (sidebar listing, sitemap) should still fail.
    const text = 'Lorem ipsum dolor sit amet. '.repeat(100);
    const html = '<html><head><title>Beaches | The New York Sun</title></head><body></body></html>';
    const result = validateContentMentionsShow(text, html, 'Beaches', 'beaches-2026');
    assert.strictEqual(result.valid, false, 'title-only page (0 body mentions) should still fail');
  });

  test('NBSP (U+00A0) between words matches regular-space title', () => {
    // Some outlets (FT, certain WordPress themes) inject NBSP between words.
    // Without normalization, "Joe Turner's" with NBSP would not match.
    const text =
      'Joe Turner’s Come and Gone returns to Broadway. ' +
      'Joe Turner is a stirring presence. The production excels in every way.';
    const result = validateContentMentionsShow(
      text,
      null,
      "Joe Turner's Come and Gone",
      'joe-turners-come-and-gone-2026'
    );
    assert.strictEqual(result.valid, true, `expected valid, got: ${result.reason}`);
    assert.ok(result.mentionCount >= 1, `expected >=1 mention, got ${result.mentionCount}`);
  });
});
