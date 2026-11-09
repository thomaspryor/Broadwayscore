'use strict';
// Pure LBO roundup extractor, split out of scripts/scrape-london-box-office-roundups.js (BRO-5956) so the opening-night
// lane can use it without pulling in the scraper's SCRAPINGBEE_API_KEY read (workflow secret-gap budget).
const cheerio = require('cheerio');
const { parseJsonLd } = require('./jsonld');

function extractReviewsFromLBO(html, showId, sourceUrl) {
  const $ = cheerio.load(html);
  const reviews = [];
  const seenOutlets = new Set();

  // LBO structure: <h4>Outlet Name</h4> followed by star rating, critic, excerpt
  // Stars are Unicode ★ characters
  // Critic line: "Reviewer: Name" (bold)
  // Review link: <a> within or after excerpt

  // Strategy: iterate through content elements, use h3/h4 as outlet markers
  // Some LBO pages use h3 for outlets (e.g., Hunger Games), others use h4
  const contentElements = $('h3, h4, p, blockquote').toArray();

  let currentOutlet = null;
  let currentStars = null;
  let currentCritic = null;
  let currentExcerpt = null;
  let currentUrl = null;
  // True once any h3/h4 passes the outlet-heading filters below, regardless
  // of whether a full review later gets flushed for it. Used to gate the
  // individual-page fallback below on "this page structurally has no outlet
  // markers at all", not just "0 reviews were extracted" — the latter would
  // also be true for a genuine roundup page where a real (unrelated) bug
  // breaks extraction after an outlet heading was found, and silently
  // masking that as a fabricated 1-row individual review would be worse
  // than the false "parser drift" alert it replaces (#1708 review).
  let sawOutletHeading = false;

  function flushReview() {
    if (currentOutlet && (currentExcerpt || currentStars !== null)) {
      const key = currentOutlet.toLowerCase();
      if (!seenOutlets.has(key)) {
        seenOutlets.add(key);
        reviews.push({
          outlet: currentOutlet,
          stars: currentStars,
          score: currentStars !== null ? Math.round((currentStars / 5) * 100) : null,
          critic: currentCritic || 'Unknown',
          excerpt: currentExcerpt || '',
          url: currentUrl || '',
          showId,
        });
      }
    }
    currentOutlet = null;
    currentStars = null;
    currentCritic = null;
    currentExcerpt = null;
    currentUrl = null;
  }

  for (const el of contentElements) {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    if (tag === 'h3' || tag === 'h4') {
      // LBO puts star ratings in heading elements too — check for stars first
      const hStars = text.match(/^(★+)\s*$/);
      if (hStars && currentOutlet) {
        currentStars = hStars[1].length;
        continue;
      }

      // New outlet — flush previous
      flushReview();

      // Skip non-outlet headings (navigation, ads, etc.)
      if (text.length > 80 || text.length < 3) continue;
      if (/book tickets|buy tickets|related|share|newsletter|categories|connect with|latest news/i.test(text)) continue;
      // Skip pure star strings without a preceding outlet
      if (/^★+$/.test(text)) continue;

      currentOutlet = text;
      sawOutletHeading = true;
      continue;
    }

    if (!currentOutlet) continue;

    // Skip LBO boilerplate / footer content
    if (/^100% Honest Reviews/i.test(text) || /^If you're interested in more/i.test(text)) continue;

    // Star rating line — Unicode ★ characters (in <p> elements)
    const starMatch = text.match(/^(★+)\s*$/);
    if (starMatch) {
      currentStars = starMatch[1].length;
      continue;
    }

    // Stars might be inline with other text
    const inlineStars = text.match(/(★+)/);
    if (inlineStars && text.length < 20) {
      currentStars = inlineStars[1].length;
      continue;
    }

    // Numeric rating like "4/5" or "4 out of 5"
    const numericRating = text.match(/^(\d(?:\.\d)?)\s*(?:\/|out of)\s*5\s*$/);
    if (numericRating) {
      currentStars = parseFloat(numericRating[1]);
      continue;
    }

    // Critic line: "Reviewer: Name" or just bold name
    const reviewerMatch = text.match(/^Reviewer:\s*(.+)/i);
    if (reviewerMatch) {
      currentCritic = reviewerMatch[1].trim();
      continue;
    }

    // Check for bold critic attribution
    const boldEl = $(el).find('strong, b').first();
    const boldText = boldEl.text().trim();
    if (boldText && /^Reviewer/i.test(boldText)) {
      const criticText = text.replace(boldText, '').trim().replace(/^:\s*/, '');
      if (criticText.length > 0 && criticText.length < 60) {
        currentCritic = criticText;
        continue;
      }
    }

    // Short "Read the review here" link paragraphs (LBO puts these in separate <p>)
    if (text.length <= 40 && /read the review|read more|full review/i.test(text)) {
      const link = $(el).find('a').first();
      const linkHref = link.length ? link.attr('href') : '';
      if (linkHref && linkHref.startsWith('http') && !linkHref.includes('londonboxoffice.co.uk')) {
        currentUrl = linkHref;
      }
      continue;
    }

    // Excerpt — longer paragraph text
    if (text.length > 40) {
      // Capture first link as review URL
      const link = $(el).find('a').first();
      if (link.length && link.attr('href')) {
        const href = link.attr('href');
        // Only capture external review links (not LBO internal or relative links)
        if (!href.includes('londonboxoffice.co.uk') && href.startsWith('http')) {
          currentUrl = href;
        }
      }

      // Also check for "Read the full review" style links
      const allLinks = $(el).find('a').toArray();
      for (const a of allLinks) {
        const href = $(a).attr('href') || '';
        const linkText = $(a).text().toLowerCase();
        if ((linkText.includes('full review') || linkText.includes('read more')) && !href.includes('londonboxoffice.co.uk')) {
          currentUrl = href;
          break;
        }
      }

      // Clean excerpt — remove "Read the full review" suffix
      let excerpt = text.replace(/\s*Read the full review\.?\s*$/i, '').trim();
      excerpt = excerpt.replace(/\s*Read more\.?\s*$/i, '').trim();

      if (excerpt.length > 30) {
        currentExcerpt = excerpt;

        // Fallback critic extraction from inline patterns like "Name called it..."
        // Only if no Reviewer: line was found for this review
        if (!currentCritic) {
          const inlineMatch = excerpt.match(/^[""\u201C]?.{0,5}(?:[""\u201D]\s*)?([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:called|thought|was\s|said\s|wrote\s|praised\s|described\s|noted\s|found\s|felt\s|hailed\s|loved\s)/);
          if (inlineMatch) {
            const candidateCritic = inlineMatch[1];
            // Don't match outlet names (The Guardian, The Times, etc.)
            if (!/^The\s/i.test(candidateCritic) && candidateCritic.toLowerCase() !== currentOutlet.toLowerCase()) {
              currentCritic = candidateCritic;
            }
          }
        }
      }
    }
  }

  // Flush last review
  flushReview();

  // Also try: look for links that might be review URLs after excerpts
  // Some LBO pages put the review link as a separate <p><a>Read full review</a></p>
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().toLowerCase();
    if ((text.includes('full review') || text.includes('read more')) && !href.includes('londonboxoffice.co.uk')) {
      // Try to associate with nearest preceding review
      // (handled in main loop above, this is a backup)
    }
  });

  // Fallback: some URLs discovered as "roundups" (loose sitemap slug match,
  // or a stale curated/archive entry) are actually LBO's own single-critic
  // review page — a different template with no <h4>Outlet</h4> markers, so
  // the loop above legitimately finds nothing. That template is already
  // handled by extractIndividualReviewFromLBO; without this fallback the
  // page reports a false "parser drift" 0-row parse even though it has one
  // citable review (#1708).
  //
  // Gated on !sawOutletHeading (not just reviews.length === 0) deliberately:
  // "100% Honest Reviews" is LBO boilerplate present on EVERY LBO page,
  // roundup or individual, so it does not discriminate between templates.
  // If a genuine multi-outlet roundup's extraction broke for an unrelated
  // reason after finding real outlet headings, falling back here would
  // fabricate a bogus "London Box Office" row and mask a real regression
  // behind a fake success instead of correctly reporting 0 rows.
  if (reviews.length === 0 && !sawOutletHeading) {
    const individual = extractIndividualReviewFromLBO(html, showId);
    if (individual && (individual.excerpt || individual.stars !== null)) {
      reviews.push(individual);
    }
  }

  // Individual-fallback rows have no per-outlet link (the whole page IS the
  // review), so extractIndividualReviewFromLBO always returns url: ''.
  // Backfilling here — not per-caller — means every caller gets a real
  // citation URL for free; without it, callers that skip URL-less reviews
  // (opening-night-poller.js's processDiscoveredReviews) silently drop the
  // recovered review instead of ingesting it (#1708 review finding).
  if (sourceUrl) {
    for (const r of reviews) {
      if (!r.url) r.url = sourceUrl;
    }
  }

  return reviews;
}

function extractIndividualReviewFromLBO(html, showId) {
  const $ = cheerio.load(html);

  // Author from JSON-LD structured data
  let critic = 'Unknown';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      for (const ld of parseJsonLd($(el).text())) {
        if (!ld.author) continue;
        const name = Array.isArray(ld.author)
          ? (ld.author[0]?.name || '')
          : (ld.author.name || ld.author);
        if (typeof name === 'string' && name.length > 1 && name.length < 60) {
          critic = name.trim();
        }
      }
    } catch (e) {}
  });

  // Fallback: look for byline patterns in the page
  if (critic === 'Unknown') {
    const byline = $('[class*="author"], [class*="byline"], [rel="author"]').first().text().trim();
    if (byline && byline.length > 1 && byline.length < 60) {
      critic = byline;
    }
  }

  // Extract star rating from LBO's CSS class — bstars1..bstars5 wraps the
  // visible star icons on every byline review page. Without this, every
  // first-party LBO review (Stuart King + colleagues) gets ingested with
  // stars=null and the LLM scores from text alone, often disagreeing with
  // the critic's published rating. (Stuart King report 2026-04-26.)
  let stars = null;
  const starsMatch = html.match(/class="[^"]*\bbstars(\d)\b[^"]*"/);
  if (starsMatch) {
    const n = parseInt(starsMatch[1], 10);
    if (n >= 1 && n <= 5) stars = n;
  }
  const score = stars !== null ? Math.round((stars / 5) * 100) : null;

  // Extract first 500 chars of body text as excerpt. LBO's current template
  // wraps review paragraphs in .pctnt/.pmain, not article/.post-content/
  // .entry-content (those selectors matched an older template and silently
  // returned zero paragraphs — #1708 parser drift). Boilerplate disclaimer
  // paragraphs are >30 chars too, so they must be excluded explicitly.
  const boilerplateRe = /^100% Honest Reviews|^If you're interested in more|^Not every review published/i;
  const paragraphs = [];
  $('article p, .post-content p, .entry-content p, .pmain p, .pctnt p').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 30 && !boilerplateRe.test(text)) paragraphs.push(text);
  });
  const excerpt = paragraphs.slice(0, 3).join(' ').substring(0, 500);

  return {
    outlet: 'London Box Office',
    stars,
    score,
    critic,
    excerpt: excerpt || '',
    url: '', // will be set to the LBO page URL itself
    showId,
    isIndividual: true,
  };
}

module.exports = { extractReviewsFromLBO, extractIndividualReviewFromLBO };
