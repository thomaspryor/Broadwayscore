'use strict';

/**
 * thestage-extract.js — pure cheerio extractor for The Stage roundup HTML.
 *
 * Extracted from scrape-thestage-roundups.js (which requires playwright at the
 * top level) so the review census can union The Stage WITHOUT transitively
 * loading a browser engine. The scraper re-exports this function; production
 * code change here → its test fails (CLAUDE.md §15 extraction pattern).
 *
 * Returns [{outlet, outletId, critic, stars, starsOutOf, excerpt, url, source}].
 */
const cheerio = require('cheerio');
const { normalizeOutlet } = require('./review-normalization');

function extractReviews(html, showId) {
  const $ = cheerio.load(html);
  const reviews = [];
  const seen = new Set(); // dedup by outlet

  // Star character class: ASCII * or Unicode ★ (U+2605)
  // Regex to match link text containing "Outlet, <stars>" with optional surrounding parens/text
  // Handles: "Outlet, ★★★★", "(Outlet, ★★)", "Critic Name (Outlet, ★★★★",
  //          "The Stage, ***)", "Outlet, ★★★★1/2"
  const STAR_PATTERN = /(?:^|\()\s*(?:(?:[A-Z][a-z]+(?:\s+[A-Z][a-z']+(?:-[A-Z][a-z]+)?)*)\s*\()?\s*(?:the\s+)?(.+?),\s*([★*]{1,5})(?:1\/2)?\s*\)?\s*\.?$/;

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const linkText = $a.text().trim();
    const href = $a.attr('href') || '';

    // Quick pre-filter: must contain at least one star character
    if (!linkText.includes('★') && !linkText.includes('*')) return;

    // Match star rating pattern in link text
    const starMatch = linkText.match(STAR_PATTERN);
    if (!starMatch) return;

    let outlet = starMatch[1].trim();
    const starChars = starMatch[2];
    const stars = starChars.length;
    // Detect half-star
    const hasHalf = /[★*]{1,5}1\/2/.test(linkText);

    // Clean up outlet name — remove leading "the ", "(", or other junk
    outlet = outlet.replace(/^\(+/, '').replace(/^the\s+/i, '').trim();

    // Fix known truncated outlet names from HTML rendering issues
    if (/^hatsOnStage$/i.test(outlet)) outlet = 'WhatsOnStage';

    // Skip bare star-only links with no outlet name
    if (!outlet || outlet.length < 1) return;

    // Skip if not a review URL
    if (!href.startsWith('http') && !href.startsWith('/')) return;
    const reviewUrl = href.startsWith('/') ? `https://www.thestage.co.uk${href}` : href;

    // Skip if we already have this outlet
    const outletId = normalizeOutlet(outlet);
    if (seen.has(outletId)) return;
    seen.add(outletId);

    // Extract critic name from surrounding HTML context
    // The pattern is: "Critic Name (" immediately before the <a> tag in the parent element
    const $parent = $a.closest('p');
    const parentHtml = $parent.html() || '';
    const parentText = $parent.text() || '';

    let critic = 'Unknown';

    // Strategy 1: Look at the HTML before this link for "Name (" pattern
    const linkHtml = $.html(el);
    const linkIdx = parentHtml.indexOf(linkHtml);
    if (linkIdx > 0) {
      // Get text content before this link by parsing the preceding HTML fragment
      const beforeHtml = parentHtml.substring(Math.max(0, linkIdx - 200), linkIdx);
      const beforeText = cheerio.load(`<p>${beforeHtml}</p>`)('p').text();

      // Match "Critic Name (" at the end of the preceding text
      // Handles: "writes Alice Saville (", "for Tim Bano (", "Dominic Cavendish ("
      // Use a non-capturing prefix to skip common prose words (for, and, but, etc.)
      const criticMatch = beforeText.match(
        /(?:^|[,;:]\s*|\.\s+|[""]\s*|[a-z]\s+)([A-Z][a-zé]+(?:['’]?[A-Za-z]*)?(?:\s+(?:de\s+|van\s+|von\s+)?[A-Z][a-zé]+(?:-[A-Z][a-zé]+)?){1,3})\s*\(\s*$/
      );
      if (criticMatch) {
        critic = criticMatch[1].trim();
      }
    }

    // Clean up critic name — strip leading prose words captured by the regex
    // e.g. "For Clive Davis", "And Arifa Akbar", "But Tim Bano", "Only Martin Robinson"
    if (critic !== 'Unknown') {
      critic = critic.replace(/^(?:For|And|But|Only|While|As|Yet)\s+/i, '').trim();
    }

    // Strategy 2: If critic name was embedded in the link text itself
    // Pattern: "Critic Name (Outlet, ★★★★"
    if (critic === 'Unknown') {
      const embeddedCritic = linkText.match(
        /^([A-Z][a-zé]+(?:\s+[A-Z][a-zé]+(?:-[A-Z][a-zé]+)?){1,2})\s*\(/
      );
      if (embeddedCritic) {
        critic = embeddedCritic[1].trim();
      }
    }

    // Extract excerpt: the sentence/clause containing this critic reference
    let excerpt = '';
    const sentences = parentText.split(/(?<=[.!?])\s+/);
    for (const sent of sentences) {
      if (sent.includes(outlet) || (critic !== 'Unknown' && sent.includes(critic))) {
        // Clean up the sentence — remove parenthetical ratings (both Unicode and ASCII stars)
        excerpt = sent
          .replace(/\([^)]*[★*]{1,5}(?:1\/2)?\s*\)/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        break;
      }
    }

    reviews.push({
      outlet,
      outletId,
      critic,
      stars: hasHalf ? stars + 0.5 : stars,
      starsOutOf: 5,
      excerpt: excerpt.substring(0, 500),
      url: reviewUrl,
      source: 'thestage-roundup',
    });
  });

  return reviews;
}

module.exports = { extractReviews };
