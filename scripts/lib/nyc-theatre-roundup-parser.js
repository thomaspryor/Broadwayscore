'use strict';
// NYC Theatre roundup HTML parser. Extracted from scrape-nyc-theatre-roundups.js
// (BRO-7931 #9) so audits can call the REAL parser without loading the scraper
// (fetch/LLM/secret-reading chain).
const cheerio = require('cheerio');
const { isJunkOutlet } = require('./review-normalization');

// Known outlet names for Pattern C matching (outlet at start of paragraph)
const KNOWN_OUTLETS = [
  'The New York Times', 'New York Times', 'Variety', 'The Guardian', 'Guardian',
  'Vulture', 'Deadline', 'Theatermania', 'TheatreMania', 'Theatrely', 'Theatreley',
  'TimeOut', 'Time Out', 'Time Out New York', 'Timeout', 'TimeOutNY',
  'Entertainment Weekly', 'The Washington Post', 'Washington Post',
  'New York Theatre Guide', 'New York Post', 'The New York Post',
  'New York Magazine', 'New York Daily News', 'The Daily Beast',
  'USA Today', 'Chicago Tribune', 'The Wrap', 'TheWrap',
  'New York Stage Review', 'Broadway News', 'Cititour', 'CititourNY',
  'Culture Sauce', 'amNewYork', 'am New York',
  'Hollywood Reporter', 'The Hollywood Reporter', 'Observer',
  'Wall Street Journal', 'The Wall Street Journal',
  'Theater Pizzazz', 'Front Mezz Junkies',
  'Theatremania', 'Broadway World', 'BroadwayWorld',
  'amNY', 'Amny',
];

function extractReviewsFromRoundup(html, showId) {
  const $ = cheerio.load(html);
  const reviews = [];

  // Final-pass helper: after every pattern exits, walk <a> tags and add outlets the
  // pattern-based walk missed. Must be invoked from every return path.
  function finalize() {
    try {
      const { supplementOutletsFromAnchors } = require('./outlet-domain-supplement');
      const { resolveOutletFromUrl } = require('./review-normalization');
      // Translate reviews[] shape so the helper's "already represented" check works
      const shaped = reviews.map(r => {
        const resolved = r.url ? resolveOutletFromUrl(r.url) : null;
        return { outletId: resolved ? resolved.outletId : (r.outlet || '').toLowerCase() };
      });
      const { added, newReviews } = supplementOutletsFromAnchors({
        html,
        reviews: shaped,
        showId,
        sourceName: 'nyc-theatre-domain-supplement',
        excludeDomains: ['nyctheatre.com', 'nyc-theatre.com'],
        urlTitleCheck: () => true, // NYC Theatre roundups are show-specific, no title check needed
        makeStub: (oid, url) => ({
          outlet: oid,
          excerpt: '',
          url,
          showId,
        }),
      });
      for (const nr of newReviews) reviews.push(nr);
      if (added > 0) {
        console.log(`    [NYC Theatre supplement] added ${added} outlet(s) missed by pattern walk`);
      }
    } catch (e) {
      // Non-fatal
    }
    return reviews;
  }

  // NYC Theatre roundups use three different HTML patterns:
  //
  // Pattern A: <h3>The Reviews</h3> → <h4>Outlet</h4> → <p>excerpt</p>
  // Pattern B: <p>"<strong>key quote</strong> more text" - Outlet Name</p>
  // Pattern C: <p>Outlet Name: "excerpt text"</p>

  // Track seen outlets to deduplicate
  const seenOutlets = new Set();

  function cleanOutletName(name) {
    // Strip trailing colons, whitespace, and non-breaking spaces
    return name.replace(/[\s\u00a0]*:[\s\u00a0]*$/, '').trim();
  }

  function addReview(outlet, excerpt, url) {
    outlet = cleanOutletName(outlet);
    // Skip junk outlets
    if (/book tickets|buy tickets|get tickets|subscribe|newsletter/i.test(outlet)) return;
    if (!outlet || outlet.length < 3) return;
    // BRO-7100: shared junk-outlet guard (section headings like "Reviews").
    if (isJunkOutlet(outlet)) return;
    const key = outlet.toLowerCase();
    if (seenOutlets.has(key)) return;
    seenOutlets.add(key);
    reviews.push({ outlet, excerpt, url: url || '', showId });
  }

  // Build a lowercase set of known outlet names for validation
  // Space-insensitive so "Culturesauce" matches "Culture Sauce" (BRO-7100).
  const squash = (s) => s.toLowerCase().replace(/[\s\u00a0]+/g, '');
  const knownOutletSet = new Set(KNOWN_OUTLETS.map(squash));
  function looksLikeOutlet(name) {
    return knownOutletSet.has(squash(cleanOutletName(name)));
  }

  // --- Pattern A: h4 outlet headings ---
  let inReviewSection = false;
  let currentOutlet = null;
  let reviewSectionEnded = false;

  $('h2, h3, h4, h5, p, blockquote').each((_, el) => {
    if (reviewSectionEnded) return;
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    // Detect review section start — "The Reviews" or similar
    if (['h2', 'h3'].includes(tag) && /^the reviews$/i.test(text.replace(/\s+/g, ' '))) {
      if (!inReviewSection) inReviewSection = true;
      return;
    }
    if (['h2', 'h3'].includes(tag) && /what.*critics|reviews? are in|critics? thought/i.test(text)) {
      if (!inReviewSection) inReviewSection = true;
      return;
    }

    // Also detect start when we see an h4 matching a known outlet name
    if (['h4', 'h5'].includes(tag) && !inReviewSection && looksLikeOutlet(text)) {
      inReviewSection = true;
      currentOutlet = text;
      return;
    }

    // End review section on CTA, footer, or "MORE reviews" sections
    if (['h2', 'h3'].includes(tag) && inReviewSection) {
      if (/more reviews|news.*tickets|need help|connect with/i.test(text) || $(el).attr('id') === 'cta-left-text') {
        inReviewSection = false;
        reviewSectionEnded = true;
        return;
      }
      if (text.length < 50 && !text.includes('"') && !/reviews?|critics?/i.test(text)) {
        inReviewSection = false;
        reviewSectionEnded = true;
        return;
      }
    }

    if (!inReviewSection && !currentOutlet) return;

    if (['h4', 'h5'].includes(tag) && text.length < 100) {
      // BRO-7100: a generic heading ("<h4>Reviews</h4>") opens the section;
      // it is not an outlet. Treating it as one wrote outletId "reviews" and
      // its dedup swallowed every real outlet on the page.
      if (isJunkOutlet(cleanOutletName(text))) {
        inReviewSection = true;
        currentOutlet = null;
        return;
      }
      currentOutlet = text;
      return;
    }

    if (['p', 'blockquote'].includes(tag) && currentOutlet && text.length > 30) {
      const link = $(el).find('a').first();
      addReview(currentOutlet, text, link.attr('href') || '');
    }

    // Only treat bold text as outlet name if it actually matches a known outlet
    if (tag === 'p') {
      const bold = $(el).find('b, strong').first().text().trim();
      if (bold && bold.length < 80 && bold.length > 3 && looksLikeOutlet(bold)) {
        const remainder = text.replace(bold, '').trim();
        if (remainder.length > 30) {
          addReview(bold, remainder, $(el).find('a').first().attr('href') || '');
        } else {
          currentOutlet = bold;
        }
      }
    }
  });

  if (reviews.length > 0) return finalize();

  // --- Pattern B: "excerpt text" - Outlet Name (outlet at end after dash) ---
  // Only accept outlet names that match KNOWN_OUTLETS to prevent capturing
  // excerpt text fragments as outlet names
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    // Match: "...text..." - Outlet Name  or  "...text..." – Outlet Name
    // BRO-7100: the dash is optional ("...right." TheatreMania); the
    // looksLikeOutlet gate below keeps prose tails out either way.
    const trailingOutlet = text.match(/["\u201d']\s*([-\u2013\u2014]\s*)?([A-Z][A-Za-z\s.&']{2,50})\s*$/);
    if (trailingOutlet && text.length > 60) {
      const outlet = trailingOutlet[2].trim();
      // Only accept if it matches a known outlet name
      if (!looksLikeOutlet(outlet)) return;
      // Cut at the closing quote the match starts on, so the attribution goes
      // whether it is ' - Outlet', '"-Outlet' (glued) or ' Outlet' (BRO-7100).
      const excerpt = text.slice(0, trailingOutlet.index + 1).trim();
      // Drop the one wrapping quote pair only: a quoted title at the end of
      // the excerpt ('"The Jellicle Ball.""') keeps its own closing quote.
      const cleanExcerpt = excerpt.replace(/^["\u201c\u201d]/, '').replace(/["\u201c\u201d']$/, '').trim();
      if (cleanExcerpt.length > 30) {
        addReview(outlet, cleanExcerpt, $(el).find('a').first().attr('href') || '');
      }
    }
  });

  if (reviews.length > 0) return finalize();

  // --- Pattern C: Outlet Name: "excerpt text" (outlet at start before colon) ---
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    // Try matching known outlet names at start of paragraph
    for (const outlet of KNOWN_OUTLETS) {
      // Match: "Outlet Name: "excerpt"" or "Outlet Name:\xa0"excerpt""
      const pattern = new RegExp(`^${outlet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\u00a0]\\s*(?:["\u201c])?`, 'i');
      if (pattern.test(text)) {
        const excerpt = text.replace(pattern, '').replace(/["\u201d]+$/, '').trim();
        if (excerpt.length > 30) {
          addReview(outlet, excerpt, $(el).find('a').first().attr('href') || '');
        }
        break;
      }
    }
  });

  return finalize();
}

module.exports = { extractReviewsFromRoundup, KNOWN_OUTLETS };
