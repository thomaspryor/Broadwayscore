/**
 * Article extractor — lightingandsoundamerica.com (table-based, no body div).
 *
 * Background (2026-06-06): L&SA is an old table-layout site with NO content
 * container — the review prose is a run of sibling
 * <p><font face="Arial,Helvetica,Geneva,Swiss,SunSans-Regular">…</p> paragraphs.
 * It had no host-specific extractor, so the generic fallback returned a stub, and
 * its opaque story.asp?ID=… URLs (no title in the path) also got filtered out of
 * gap-audit discovery — L&SA was the dominant Show Score capture gap across shows
 * (Receptionist/Animal Wisdom/Jerome/Indian Princesses).
 *
 * Verified end-to-end against 3 live reviews: The Receptionist (5309 chars),
 * Animal Wisdom (5215), Jerome (7967) — all ending with the "--David Barbour" byline.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

const FONT = 'Arial,Helvetica,Geneva,Swiss,SunSans-Regular';

describe('article-extractor: lightingandsoundamerica.com', () => {
  test('extracts Arial-font review paragraphs and drops nav/contact footer', () => {
    const html =
      '<html><body><table><tr>' +
      // nav cell — different font, must be ignored
      '<td valign="top"><p><font face="Verdana">Today\'s News Theatre in Review Business News</font></p></td>' +
      '<td>' +
        `<p><font face="${FONT}">If the acting thing ever dries up for the lead, she has a fine career ahead in office management. ${'The production is taut and unsettling. '.repeat(6)}</font></p>` +
        `<p><font face="${FONT}">First staged in 2007, the play packs a gut punch, beginning as a light workplace comedy and ending in the unthinkable. --David Barbour</font></p>` +
        // contact/address footer — shares the Arial font, must be dropped by content
        `<p><font face="${FONT}">Lighting&Sound America , 372 Central Park West #19C, New York, NY 10025 USA Tel: 212-244-1505 www.lightingandsoundamerica.com</font></p>` +
      '</td>' +
      '</tr></table></body></html>';
    const text = extractArticleText(html, 'www.lightingandsoundamerica.com');
    assert.ok(text, 'extractor should return text');
    assert.ok(text.includes('fine career ahead in office management'), 'review body captured');
    assert.ok(text.includes('--David Barbour'), 'byline/end captured');
    assert.ok(!/Central Park West|Tel: 212/.test(text), 'contact footer must be dropped');
    assert.ok(!/Today's News/.test(text), 'nav must be excluded (wrong font)');
  });

  test('returns null when there is no Arial-font review prose', () => {
    const html = '<html><body><td><p><font face="Verdana">Just navigation here</font></p></td></body></html>';
    assert.strictEqual(extractArticleText(html, 'lightingandsoundamerica.com'), null);
  });
});
