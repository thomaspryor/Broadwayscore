/**
 * Regression test for the theaterlife.com byline override.
 *
 * The bug (Notion 39b637c5): theaterlife.com (WordPress) attributes EVERY post
 * to the site owner "Barry Gordin" via the author vcard
 * (class="author vcard" → /author/barry/). The generic byline-CSS strategy in
 * extractAuthorFromHtml picks that vcard, so 366 reviews were mis-bylined
 * "Barry Gordin" — none of them written by him. The real critic is the in-body
 * "By: <name>" line near the top of the article ("By: Samuel L. Leiter").
 *
 * The fix: extractTheaterLifeByline() parses the in-body "By:" line (colon form,
 * which the shared BYLINE_PATTERNS do not catch), and extractAuthorFromHtml
 * prefers it for theaterlife.com URLs before the vcard strategy runs.
 *
 * These fixtures are the real cleaned-text shapes seen in the corpus: the
 * newline-formatted modern scrape and the space-flattened legacy scrape.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractTheaterLifeByline, extractAuthorFromHtml } = require('../../scripts/lib/content-quality.js');

describe('extractTheaterLifeByline', () => {
  test('parses "By: First M. Last" (colon + middle initial)', () => {
    const text = 'CHARLES DICKENS’ A CHRISTMAS CAROL\n\nBy: Samuel L. Leiter\n\nNovember 30, 2022: If you go';
    assert.strictEqual(extractTheaterLifeByline(text), 'Samuel L. Leiter');
  });

  test('parses "By: First Last" and stops before trailing body text (flattened scrape)', () => {
    const text = '1984 ***1/2 – theaterlife Skip to content Reviews By: Isa Goldberg Transferred from London to Broadway';
    assert.strictEqual(extractTheaterLifeByline(text), 'Isa Goldberg');
  });

  test('parses "By: First Last" and stops before the publish date', () => {
    const text = 'By: David Sheward\n\nMarch 17, 2023: Jessica Chastain’s compelling performance';
    assert.strictEqual(extractTheaterLifeByline(text), 'David Sheward');
  });

  test('parses "By Name" without a colon at text-start', () => {
    assert.strictEqual(extractTheaterLifeByline('By David Sheward\n\nJanuary 22, 2025: Billed as a new play'), 'David Sheward');
  });

  test('cuts a byline glued to a curly quote ("By: Alix Cohen“We are…")', () => {
    assert.strictEqual(extractTheaterLifeByline('THIS is Great Theater\n\nBy: Alix Cohen“We are merchants of money.'), 'Alix Cohen');
  });

  test('cuts a byline glued to a month ("By: Alix CohenSeptember 19, 2025")', () => {
    assert.strictEqual(extractTheaterLifeByline('By: Alix CohenSeptember 19, 2025: On our way out'), 'Alix Cohen');
  });

  test('does not split Mc/Mac surnames (no-colon path)', () => {
    assert.strictEqual(extractTheaterLifeByline('By McDonald Smith\n\nsome review text here'), 'McDonald Smith');
  });

  test('does not match a body sentence starting with "By" + lowercase', () => {
    assert.strictEqual(extractTheaterLifeByline('The show opens.\nBy then the plot has thickened considerably.'), null);
  });

  test('never re-stamps the phantom "Barry Gordin" even if the body said so', () => {
    assert.strictEqual(extractTheaterLifeByline('By: Barry Gordin\n\nsome text about a show'), null);
  });

  test('returns null when no in-body byline is parseable (routes to manual triage)', () => {
    assert.strictEqual(extractTheaterLifeByline('No byline here at all, just prose about the show.'), null);
    assert.strictEqual(extractTheaterLifeByline(''), null);
    assert.strictEqual(extractTheaterLifeByline(null), null);
  });
});

describe('extractAuthorFromHtml — theaterlife.com override', () => {
  // Minimal reproduction of theaterlife's structure: the author vcard names the
  // site owner, the article body carries the real critic.
  const html =
    '<html><body>' +
    '<span class="author vcard"><a class="url fn n" href="https://theaterlife.com/author/barry/">Barry Gordin</a></span>' +
    '<div class="entry-content"><p><strong>By:  Samuel L. Leiter</strong></p><p>A review body.</p></div>' +
    '</body></html>';
  const cleanedText = "A Doll's House ****1/2 By: Samuel L. Leiter March 17, 2023: Jessica Chastain’s compelling performance of Nora";

  test('theaterlife.com URL → in-body critic wins over the vcard site owner', () => {
    const got = extractAuthorFromHtml(html, cleanedText, { url: 'https://theaterlife.com/a-dolls-house-1-2/' });
    assert.strictEqual(got, 'Samuel L. Leiter');
    assert.notStrictEqual(got, 'Barry Gordin');
  });

  test('non-theaterlife URL is unaffected by the override (vcard path still used)', () => {
    // A different WordPress outlet where the vcard IS the real byline — override
    // must not fire, so the generic strategy still returns the vcard name.
    const got = extractAuthorFromHtml(html, cleanedText, { url: 'https://example-blog.com/some-review/' });
    assert.strictEqual(got, 'Barry Gordin');
  });
});
