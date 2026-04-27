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
