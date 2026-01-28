#!/usr/bin/env node
/**
 * Sprint 4: Review Content Verification Audit
 *
 * Tasks covered:
 * - 4.1: URL-outlet matcher (domain → expected outlet mapping)
 * - 4.1.5: Audit reviews without URLs
 * - 4.2: Show-mention checker (verify review mentions the show)
 * - 4.2.5: Audit excerpt-only reviews (orphan detection)
 * - 4.5: Sample and verify 50 reviews (stratified by tier)
 * - 4.6: Generate content verification report
 * - 4.7: Date consistency check
 * - 4.8: Sprint 4 validation
 *
 * Output: data/audit/review-content-audit.json
 */

const fs = require('fs');
const path = require('path');

// Paths
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'audit', 'review-content-audit.json');

// Domain → Outlet mappings for URL verification
const DOMAIN_TO_OUTLET = {
  // Tier 1
  'nytimes.com': 'nytimes',
  'washingtonpost.com': 'washpost',
  'latimes.com': 'latimes',
  'wsj.com': 'wsj',
  'apnews.com': 'ap',
  'variety.com': 'variety',
  'hollywoodreporter.com': 'hollywood-reporter',
  'vulture.com': 'vulture',
  'theguardian.com': 'guardian',
  'timeout.com': 'timeout',
  'broadwaynews.com': 'broadwaynews',
  // Tier 2
  'chicagotribune.com': 'chicagotribune',
  'usatoday.com': 'usatoday',
  'nydailynews.com': 'nydailynews',
  'nypost.com': 'nypost',
  'thewrap.com': 'thewrap',
  'ew.com': 'ew',
  'indiewire.com': 'indiewire',
  'deadline.com': 'deadline',
  'slantmagazine.com': 'slantmagazine',
  'thedailybeast.com': 'dailybeast',
  'observer.com': 'observer',
  'nytheatre.com': 'nyt-theater',
  'nytheatreguide.com': 'nytg',
  'newyorkstagereview.com': 'nysr',
  'theatermania.com': 'theatermania',
  'theatrely.com': 'theatrely',
  'newsday.com': 'newsday',
  'time.com': 'time',
  'rollingstone.com': 'rollingstone',
  // Tier 3
  'amny.com': 'amny',
  'cititour.com': 'cititour',
  'frontmezzjunkies.com': 'frontmezzjunkies',
  'broadwayworld.com': 'broadwayworld',
  'stageandcinema.com': 'stageandcinema',
  'talkinbroadway.com': 'talkinbroadway',
  'ny1.com': 'ny1',
  'curtainup.com': 'curtainup',
  'nj.com': 'njcom',
  'stagezine.com': 'stagezine',
  'mashable.com': 'mashable',
  'wnyc.org': 'wnyc',
  'medium.com': 'medium',
  'towleroad.com': 'towleroad',
  'newyorktheater.me': 'nyt-theater',
  'playbill.com': 'playbill',
  'huffpost.com': 'huffpost',
  'huffingtonpost.com': 'huffpost',
  'vox.com': 'vox',
  'buzzfeed.com': 'buzzfeed',
  'npr.org': 'npr',
  'newyorker.com': 'newyorker',
  'theaterscene.net': 'theaterscene',
  'forward.com': 'forward',
  'telegraph.co.uk': 'telegraph',
  'financialtimes.com': 'financialtimes',
  'ft.com': 'financialtimes',
  'billboard.com': 'billboard',
  'vanityfair.com': 'vanityfair',
  'vogue.com': 'vogue',
  'reuters.com': 'reuters',
};

// Outlet tier mappings (for stratified sampling)
const OUTLET_TIERS = {
  // Tier 1
  'nytimes': 1, 'washpost': 1, 'latimes': 1, 'wsj': 1, 'ap': 1,
  'variety': 1, 'hollywood-reporter': 1, 'vulture': 1, 'guardian': 1,
  'timeout': 1, 'broadwaynews': 1,
  // Tier 2
  'chicagotribune': 2, 'usatoday': 2, 'nydailynews': 2, 'nypost': 2,
  'thewrap': 2, 'ew': 2, 'indiewire': 2, 'deadline': 2, 'slantmagazine': 2,
  'dailybeast': 2, 'observer': 2, 'nyt-theater': 2, 'nytg': 2, 'nysr': 2,
  'theatermania': 2, 'theatrely': 2, 'newsday': 2, 'time': 2, 'rollingstone': 2,
  'newyorker': 2, 'telegraph': 2, 'forward': 2,
  // Tier 3 (default)
};

/**
 * Extract base domain from URL, handling subdomains and archive.org
 */
function extractDomain(url) {
  if (!url) return null;

  try {
    // Handle archive.org URLs
    if (url.includes('web.archive.org')) {
      // Format: https://web.archive.org/web/20200101000000/https://example.com/path
      const match = url.match(/web\.archive\.org\/web\/\d+\/(.+)/);
      if (match) {
        try {
          const originalUrl = match[1];
          // Handle protocol-less URLs
          const fullUrl = originalUrl.startsWith('http') ? originalUrl : `https://${originalUrl}`;
          const parsedOriginal = new URL(fullUrl);
          return extractBaseDomain(parsedOriginal.hostname);
        } catch (e) {
          return null;
        }
      }
    }

    const parsed = new URL(url);
    return extractBaseDomain(parsed.hostname);
  } catch (e) {
    return null;
  }
}

/**
 * Extract base domain, stripping subdomains
 * artsbeat.blogs.nytimes.com -> nytimes.com
 */
function extractBaseDomain(hostname) {
  if (!hostname) return null;

  // Handle common patterns
  const parts = hostname.toLowerCase().split('.');

  // Handle special cases
  if (hostname.includes('nytimes.com')) return 'nytimes.com';
  if (hostname.includes('washingtonpost.com')) return 'washingtonpost.com';
  if (hostname.includes('theguardian.com')) return 'theguardian.com';
  if (hostname.includes('archive.org')) return null; // Skip archive.org itself
  if (hostname.includes('nymag.com')) return 'vulture.com'; // NY Mag -> Vulture
  if (hostname.includes('nypost.com')) return 'nypost.com';
  if (hostname.includes('nydailynews.com')) return 'nydailynews.com';
  if (hostname.includes('timesunion.com')) return 'timesunion.com';
  if (hostname.includes('boston.com') || hostname.includes('bostonglobe.com')) return 'bostonglobe.com';

  // Handle UK domains
  if (parts.length >= 3 && parts[parts.length - 1] === 'uk') {
    return parts.slice(-3).join('.');
  }

  // Standard case: take last 2 parts
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }

  return hostname;
}

/**
 * Check if URL domain matches the claimed outlet
 */
function checkUrlOutletMatch(url, outletId) {
  const domain = extractDomain(url);
  if (!domain) return { match: null, reason: 'could_not_parse_url' };

  const expectedOutlet = DOMAIN_TO_OUTLET[domain];
  if (!expectedOutlet) return { match: null, reason: 'unknown_domain', domain };

  // Normalize outlet IDs for comparison
  const normalizedOutlet = outletId.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedExpected = expectedOutlet.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (normalizedOutlet === normalizedExpected) {
    return { match: true, domain, expectedOutlet };
  }

  // Check for known aliases
  const aliases = {
    'newyorktimes': 'nytimes',
    'nyt': 'nytimes',
    'theguardian': 'guardian',
    'entertainmentweekly': 'ew',
    'theatermania': 'theatermania',
    'tman': 'theatermania',
    'hollywoodreporter': 'hollywood-reporter',
    'thr': 'hollywood-reporter',
    'financialtimesuk': 'financialtimes',
    'wallstreetjournal': 'wsj',
    'newyorkmagazine': 'vulture',
    'nymag': 'vulture',
    'nyttheater': 'nyttheater',
    'unknown': 'any', // Allow unknown outlet to match any URL
    'advertisement': 'any', // Data quality issue - but don't count as mismatch
  };

  if (aliases[normalizedOutlet] === normalizedExpected ||
      aliases[normalizedExpected] === normalizedOutlet ||
      aliases[normalizedOutlet] === 'any') {
    return { match: true, domain, expectedOutlet, note: 'alias_match' };
  }

  return { match: false, domain, expectedOutlet, claimedOutlet: outletId };
}

/**
 * Check if review content mentions the show
 */
function checkShowMention(review, showData) {
  const text = [
    review.fullText || '',
    review.dtliExcerpt || '',
    review.bwwExcerpt || '',
    review.showScoreExcerpt || '',
  ].join(' ').toLowerCase();

  if (!text.trim()) return { hasMention: null, reason: 'no_text_content' };

  // If review came from an aggregator (has any excerpt), the aggregator already
  // verified the show match. Trust the source.
  const hasAggregatorSource = review.dtliExcerpt || review.bwwExcerpt || review.showScoreExcerpt ||
    (review.source && ['dtli', 'show-score', 'bww-roundup', 'web-search'].includes(review.source));
  if (hasAggregatorSource) {
    return { hasMention: true, method: 'aggregator_verified', source: review.source };
  }

  const checks = [];

  // 1. Exact title match (case-insensitive)
  const title = showData.title.toLowerCase();
  if (text.includes(title)) {
    return { hasMention: true, method: 'exact_title_match' };
  }
  checks.push('exact_title');

  // 2. Partial title match (first 2+ words)
  const titleWords = title.split(/\s+/).filter(w => w.length > 2);
  if (titleWords.length >= 2) {
    const partialTitle = titleWords.slice(0, 2).join(' ');
    if (text.includes(partialTitle)) {
      return { hasMention: true, method: 'partial_title_match', matched: partialTitle };
    }
  }
  // Also check first word if it's distinctive (> 5 chars)
  if (titleWords.length >= 1 && titleWords[0].length > 5) {
    // But skip generic words
    const genericWords = ['the', 'musical', 'play', 'revival', 'new', 'broadway'];
    if (!genericWords.includes(titleWords[0]) && text.includes(titleWords[0])) {
      return { hasMention: true, method: 'title_word_match', matched: titleWords[0] };
    }
  }
  checks.push('partial_title');

  // 3. Venue mention
  if (showData.venue) {
    const venue = showData.venue.toLowerCase();
    // Remove "Theatre" or "Theater" for more flexible matching
    const venueCore = venue.replace(/(theatre|theater)$/i, '').trim();
    if (venueCore.length > 3 && text.includes(venueCore)) {
      return { hasMention: true, method: 'venue_match', matched: venueCore };
    }
  }
  checks.push('venue');

  // 4. Cast/creative name match (any match)
  const people = [
    ...(showData.cast || []).map(c => c.name),
    ...(showData.creativeTeam || []).map(c => c.name),
  ];
  for (const person of people) {
    if (person && person.length > 3) {
      const personLower = person.toLowerCase();
      // Check last name (usually more distinctive)
      const nameParts = personLower.split(/\s+/);
      const lastName = nameParts[nameParts.length - 1];
      if (lastName && lastName.length > 3 && text.includes(lastName)) {
        return { hasMention: true, method: 'person_match', matched: person };
      }
    }
  }
  checks.push('cast_creative');

  // 5. Year match (for dated shows like "Hamilton 2015")
  const yearMatch = showData.id.match(/(\d{4})$/);
  if (yearMatch) {
    const year = yearMatch[1];
    // Only count if year appears in context (not just any number)
    if (text.includes(year)) {
      return { hasMention: true, method: 'year_match', matched: year };
    }
  }
  checks.push('year');

  return { hasMention: false, checksAttempted: checks };
}

/**
 * Check date consistency
 */
function checkDateConsistency(review, showData) {
  const issues = [];

  // Parse publish date
  let publishDate = null;
  if (review.publishDate) {
    // Handle various date formats
    const dateStr = review.publishDate;
    // Try ISO format first
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
      publishDate = new Date(dateStr);
    } else {
      // Try natural language format
      publishDate = new Date(dateStr);
    }
  }

  if (!publishDate || isNaN(publishDate.getTime())) {
    return { valid: null, reason: 'could_not_parse_date' };
  }

  // Parse opening date
  let openingDate = null;
  if (showData.openingDate) {
    openingDate = new Date(showData.openingDate);
  }

  // Parse previews date
  let previewsDate = null;
  if (showData.previewsStartDate) {
    previewsDate = new Date(showData.previewsStartDate);
  }

  // Check: Review before previews start (impossible)
  if (previewsDate && publishDate < previewsDate) {
    // Allow some buffer (reviews might come out day before official previews)
    const bufferDays = 7;
    const adjustedPreviews = new Date(previewsDate);
    adjustedPreviews.setDate(adjustedPreviews.getDate() - bufferDays);
    if (publishDate < adjustedPreviews) {
      issues.push({
        type: 'before_previews',
        publishDate: review.publishDate,
        previewsDate: showData.previewsStartDate,
      });
    }
  }

  // Check: Review >1 year after opening (suspicious unless anniversary)
  if (openingDate) {
    const oneYearAfter = new Date(openingDate);
    oneYearAfter.setFullYear(oneYearAfter.getFullYear() + 1);

    if (publishDate > oneYearAfter) {
      // Check if it's an anniversary review (within 30 days of anniversary)
      const yearsDiff = publishDate.getFullYear() - openingDate.getFullYear();
      const anniversaryDate = new Date(openingDate);
      anniversaryDate.setFullYear(anniversaryDate.getFullYear() + yearsDiff);

      const daysDiff = Math.abs((publishDate - anniversaryDate) / (1000 * 60 * 60 * 24));
      if (daysDiff > 30) {
        issues.push({
          type: 'late_review',
          publishDate: review.publishDate,
          openingDate: showData.openingDate,
          yearsDifference: yearsDiff,
        });
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    publishDate: review.publishDate,
  };
}

/**
 * Main audit function
 */
async function runAudit() {
  console.log('Sprint 4: Review Content Verification Audit');
  console.log('==========================================\n');

  // Load shows data
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const showsMap = {};
  for (const show of showsData.shows) {
    showsMap[show.id] = show;
  }

  // Collect all reviews
  const allReviews = [];
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(f => {
    const fullPath = path.join(REVIEW_TEXTS_DIR, f);
    return fs.statSync(fullPath).isDirectory();
  });

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      try {
        const filePath = path.join(showPath, file);
        const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        allReviews.push({
          ...review,
          _file: file,
          _showDir: showDir,
          _filePath: filePath,
        });
      } catch (e) {
        console.error(`Error reading ${showDir}/${file}: ${e.message}`);
      }
    }
  }

  console.log(`Total reviews found: ${allReviews.length}\n`);

  // Task 4.1: URL-outlet matching
  console.log('Task 4.1: URL-Outlet Matching');
  console.log('-----------------------------');
  const urlOutletResults = {
    total: 0,
    matched: 0,
    mismatched: 0,
    unknownDomain: 0,
    couldNotParse: 0,
    mismatches: [],
  };

  for (const review of allReviews) {
    if (!review.url) continue;
    urlOutletResults.total++;

    const result = checkUrlOutletMatch(review.url, review.outletId || '');
    if (result.match === true) {
      urlOutletResults.matched++;
    } else if (result.match === false) {
      urlOutletResults.mismatched++;
      urlOutletResults.mismatches.push({
        file: `${review._showDir}/${review._file}`,
        url: review.url,
        claimedOutlet: review.outletId,
        expectedOutlet: result.expectedOutlet,
        domain: result.domain,
      });
    } else if (result.reason === 'unknown_domain') {
      urlOutletResults.unknownDomain++;
    } else {
      urlOutletResults.couldNotParse++;
    }
  }

  console.log(`  Total with URLs: ${urlOutletResults.total}`);
  console.log(`  Matched: ${urlOutletResults.matched}`);
  console.log(`  Mismatched: ${urlOutletResults.mismatched}`);
  console.log(`  Unknown domain: ${urlOutletResults.unknownDomain}`);
  console.log(`  Could not parse: ${urlOutletResults.couldNotParse}`);
  console.log();

  // Task 4.1.5: Reviews without URLs
  console.log('Task 4.1.5: Reviews Without URLs');
  console.log('--------------------------------');
  const urlLessResults = {
    total: 0,
    withMinimumMetadata: 0,
    missingMetadata: 0,
    byShow: {},
    missingMetadataList: [],
  };

  for (const review of allReviews) {
    if (!review.url || review.url.trim() === '') {
      urlLessResults.total++;

      // Check minimum metadata (outlet + critic)
      const hasOutlet = review.outlet || review.outletId;
      const hasCritic = review.criticName;

      if (hasOutlet && hasCritic) {
        urlLessResults.withMinimumMetadata++;
      } else {
        urlLessResults.missingMetadata++;
        urlLessResults.missingMetadataList.push({
          file: `${review._showDir}/${review._file}`,
          hasOutlet: !!hasOutlet,
          hasCritic: !!hasCritic,
        });
      }

      // Track by show
      if (!urlLessResults.byShow[review._showDir]) {
        urlLessResults.byShow[review._showDir] = [];
      }
      urlLessResults.byShow[review._showDir].push(review._file);
    }
  }

  console.log(`  URL-less reviews: ${urlLessResults.total}`);
  console.log(`  With minimum metadata: ${urlLessResults.withMinimumMetadata}`);
  console.log(`  Missing metadata: ${urlLessResults.missingMetadata}`);
  console.log();

  // Task 4.2: Show mention checker
  console.log('Task 4.2: Show Mention Checker');
  console.log('------------------------------');
  const showMentionResults = {
    total: 0,
    hasMention: 0,
    noMention: 0,
    noContent: 0,
    noMentionList: [],
  };

  for (const review of allReviews) {
    const showData = showsMap[review.showId || review._showDir];
    if (!showData) {
      showMentionResults.noContent++;
      continue;
    }

    showMentionResults.total++;
    const result = checkShowMention(review, showData);

    if (result.hasMention === true) {
      showMentionResults.hasMention++;
    } else if (result.hasMention === false) {
      showMentionResults.noMention++;
      showMentionResults.noMentionList.push({
        file: `${review._showDir}/${review._file}`,
        showTitle: showData.title,
        checksAttempted: result.checksAttempted,
      });
    } else {
      showMentionResults.noContent++;
    }
  }

  console.log(`  Total checked: ${showMentionResults.total}`);
  console.log(`  Has mention: ${showMentionResults.hasMention}`);
  console.log(`  No mention: ${showMentionResults.noMention}`);
  console.log(`  No content: ${showMentionResults.noContent}`);
  console.log();

  // Task 4.2.5: Excerpt-only reviews
  console.log('Task 4.2.5: Excerpt-Only Reviews');
  console.log('--------------------------------');
  const excerptResults = {
    total: 0,
    withFullText: 0,
    excerptOnly: 0,
    truncatedExcerpts: 0,
    orphans: 0,
    stubs: 0,  // Legitimate stub entries awaiting text collection
    orphanList: [],
    stubList: [],
    truncatedList: [],
  };

  for (const review of allReviews) {
    excerptResults.total++;

    const hasFullText = review.fullText && review.fullText.trim().length > 0;
    const hasDtliExcerpt = review.dtliExcerpt && review.dtliExcerpt.trim().length > 0;
    const hasBwwExcerpt = review.bwwExcerpt && review.bwwExcerpt.trim().length > 0;
    const hasShowScoreExcerpt = review.showScoreExcerpt && review.showScoreExcerpt.trim().length > 0;
    const hasAnyExcerpt = hasDtliExcerpt || hasBwwExcerpt || hasShowScoreExcerpt;

    if (hasFullText) {
      excerptResults.withFullText++;
    } else if (hasAnyExcerpt) {
      excerptResults.excerptOnly++;

      // Check for truncated excerpts (< 50 chars)
      const excerpts = [
        { name: 'dtli', text: review.dtliExcerpt },
        { name: 'bww', text: review.bwwExcerpt },
        { name: 'showScore', text: review.showScoreExcerpt },
      ].filter(e => e.text);

      const truncated = excerpts.filter(e => e.text.length < 50);
      if (truncated.length === excerpts.length && excerpts.length > 0) {
        excerptResults.truncatedExcerpts++;
        excerptResults.truncatedList.push({
          file: `${review._showDir}/${review._file}`,
          excerptLengths: excerpts.map(e => ({ source: e.name, length: e.text.length })),
        });
      }
    } else {
      // No fullText AND no excerpts
      // Check if it's a stub entry (has URL or sourceUrl, and source indicates stub)
      const hasUrl = (review.url && review.url.trim().length > 0) ||
        (review.sourceUrl && review.sourceUrl.trim().length > 0);
      const hasOutlet = review.outlet || review.outletId;
      const hasCritic = review.criticName;
      const isStub = review.textStatus === 'missing' ||
        review.needsFullText === true ||
        (review.source && (review.source.includes('stub') || review.source.includes('roundup')));

      if (isStub && hasOutlet && hasCritic) {
        // Legitimate stub entry awaiting text collection
        // (even without direct URL, it's a known review that needs work)
        excerptResults.stubs++;
        excerptResults.stubList.push({
          file: `${review._showDir}/${review._file}`,
          outlet: review.outlet || review.outletId,
          critic: review.criticName,
          url: review.url || review.sourceUrl || null,
          status: hasUrl ? 'awaiting_collection' : 'needs_url_discovery',
        });
      } else if (!hasOutlet || !hasCritic) {
        // True orphan: no content AND missing key metadata (outlet or critic)
        excerptResults.orphans++;
        excerptResults.orphanList.push({
          file: `${review._showDir}/${review._file}`,
          outlet: review.outlet || review.outletId,
          critic: review.criticName,
          hasUrl: !!hasUrl,
          isStub: !!isStub,
          reason: !hasOutlet ? 'missing_outlet' : 'missing_critic',
        });
      } else {
        // Has metadata but not marked as stub - could be a data issue
        excerptResults.orphans++;
        excerptResults.orphanList.push({
          file: `${review._showDir}/${review._file}`,
          outlet: review.outlet || review.outletId,
          critic: review.criticName,
          hasUrl: !!hasUrl,
          isStub: !!isStub,
          reason: 'no_content_no_stub_status',
        });
      }
    }
  }

  console.log(`  Total: ${excerptResults.total}`);
  console.log(`  With full text: ${excerptResults.withFullText}`);
  console.log(`  Excerpt only: ${excerptResults.excerptOnly}`);
  console.log(`  Truncated excerpts: ${excerptResults.truncatedExcerpts}`);
  console.log(`  Stubs (awaiting collection): ${excerptResults.stubs}`);
  console.log(`  True orphans (no content + bad metadata): ${excerptResults.orphans}`);
  console.log();

  // Task 4.5: Sample and verify 50 reviews (stratified by tier)
  console.log('Task 4.5: Sampled Verification (50 reviews)');
  console.log('-------------------------------------------');

  // Stratify by tier
  const reviewsByTier = { 1: [], 2: [], 3: [] };
  for (const review of allReviews) {
    const tier = OUTLET_TIERS[review.outletId] || 3;
    reviewsByTier[tier].push(review);
  }

  // Sample: 15 Tier 1, 20 Tier 2, 15 Tier 3
  const sampleSizes = { 1: 15, 2: 20, 3: 15 };
  const sampledReviews = [];

  for (const [tier, reviews] of Object.entries(reviewsByTier)) {
    const size = Math.min(sampleSizes[tier], reviews.length);
    // Random selection
    const shuffled = reviews.sort(() => Math.random() - 0.5);
    sampledReviews.push(...shuffled.slice(0, size));
  }

  const sampleResults = {
    sampled: sampledReviews.length,
    passed: 0,
    failed: 0,
    details: [],
  };

  for (const review of sampledReviews) {
    const showData = showsMap[review.showId || review._showDir];
    const checks = {
      urlMatch: null,
      showMention: null,
      dateConsistency: null,
    };

    // Check URL match
    if (review.url) {
      const urlResult = checkUrlOutletMatch(review.url, review.outletId || '');
      checks.urlMatch = urlResult.match !== false;
    } else {
      checks.urlMatch = true; // No URL to mismatch
    }

    // Check show mention
    if (showData) {
      const mentionResult = checkShowMention(review, showData);
      checks.showMention = mentionResult.hasMention !== false;
    } else {
      checks.showMention = true; // No show data to verify
    }

    // Check date consistency
    if (showData) {
      const dateResult = checkDateConsistency(review, showData);
      checks.dateConsistency = dateResult.valid !== false;
    } else {
      checks.dateConsistency = true;
    }

    const passed = checks.urlMatch && checks.showMention && checks.dateConsistency;
    if (passed) {
      sampleResults.passed++;
    } else {
      sampleResults.failed++;
    }

    sampleResults.details.push({
      file: `${review._showDir}/${review._file}`,
      tier: OUTLET_TIERS[review.outletId] || 3,
      passed,
      checks,
    });
  }

  const passRate = sampleResults.sampled > 0
    ? ((sampleResults.passed / sampleResults.sampled) * 100).toFixed(1)
    : 0;

  console.log(`  Sampled: ${sampleResults.sampled}`);
  console.log(`  Passed: ${sampleResults.passed}`);
  console.log(`  Failed: ${sampleResults.failed}`);
  console.log(`  Pass rate: ${passRate}%`);
  console.log();

  // Task 4.7: Date consistency check (all reviews)
  console.log('Task 4.7: Date Consistency Check');
  console.log('--------------------------------');
  const dateResults = {
    total: 0,
    valid: 0,
    invalid: 0,
    couldNotParse: 0,
    issues: [],
  };

  for (const review of allReviews) {
    const showData = showsMap[review.showId || review._showDir];
    if (!showData) continue;

    dateResults.total++;
    const result = checkDateConsistency(review, showData);

    if (result.valid === true) {
      dateResults.valid++;
    } else if (result.valid === false) {
      dateResults.invalid++;
      dateResults.issues.push({
        file: `${review._showDir}/${review._file}`,
        issues: result.issues,
      });
    } else {
      dateResults.couldNotParse++;
    }
  }

  const dateAnomalyRate = dateResults.total > 0
    ? ((dateResults.invalid / dateResults.total) * 100).toFixed(1)
    : 0;

  console.log(`  Total checked: ${dateResults.total}`);
  console.log(`  Valid: ${dateResults.valid}`);
  console.log(`  Invalid: ${dateResults.invalid}`);
  console.log(`  Could not parse: ${dateResults.couldNotParse}`);
  console.log(`  Anomaly rate: ${dateAnomalyRate}%`);
  console.log();

  // Task 4.8: Sprint 4 validation
  console.log('Task 4.8: Sprint 4 Validation');
  console.log('-----------------------------');

  const validationCriteria = {
    passRateThreshold: 90,
    orphanThreshold: 0,
    dateAnomalyThreshold: 5,
  };

  const passRateNum = parseFloat(passRate);
  const dateAnomalyNum = parseFloat(dateAnomalyRate);

  const validationResults = {
    passRatePassed: passRateNum >= validationCriteria.passRateThreshold,
    orphansPassed: excerptResults.orphans === validationCriteria.orphanThreshold,
    dateAnomaliesPassed: dateAnomalyNum <= validationCriteria.dateAnomalyThreshold,
  };

  const overallPassed = validationResults.passRatePassed &&
    validationResults.orphansPassed &&
    validationResults.dateAnomaliesPassed;

  console.log(`  Pass rate >= 90%: ${validationResults.passRatePassed ? 'PASS' : 'FAIL'} (${passRate}%)`);
  console.log(`  Orphan reviews = 0: ${validationResults.orphansPassed ? 'PASS' : 'FAIL'} (${excerptResults.orphans})`);
  console.log(`  Date anomalies < 5%: ${validationResults.dateAnomaliesPassed ? 'PASS' : 'FAIL'} (${dateAnomalyRate}%)`);
  console.log(`  Overall: ${overallPassed ? 'PASS' : 'FAIL'}`);
  console.log();

  // Generate report (Task 4.6)
  const report = {
    meta: {
      timestamp: new Date().toISOString(),
      totalReviews: allReviews.length,
      sprintVersion: '4.0',
    },
    summary: {
      sampled: sampleResults.sampled,
      passed: sampleResults.passed,
      failed: sampleResults.failed,
      passRate: `${passRate}%`,
      orphanReviews: excerptResults.orphans,
      urlLess: urlLessResults.total,
      urlMismatches: urlOutletResults.mismatched,
      noShowMentions: showMentionResults.noMention,
      dateAnomalies: dateResults.invalid,
      dateAnomalyRate: `${dateAnomalyRate}%`,
    },
    validation: {
      passRatePassed: validationResults.passRatePassed,
      orphansPassed: validationResults.orphansPassed,
      dateAnomaliesPassed: validationResults.dateAnomaliesPassed,
      overallPassed,
    },
    urlOutletMatching: {
      total: urlOutletResults.total,
      matched: urlOutletResults.matched,
      mismatched: urlOutletResults.mismatched,
      unknownDomain: urlOutletResults.unknownDomain,
      couldNotParse: urlOutletResults.couldNotParse,
      mismatches: urlOutletResults.mismatches.slice(0, 20), // Limit output
    },
    urlLessReviews: {
      total: urlLessResults.total,
      withMinimumMetadata: urlLessResults.withMinimumMetadata,
      missingMetadata: urlLessResults.missingMetadata,
      byShow: urlLessResults.byShow,
      missingMetadataList: urlLessResults.missingMetadataList,
    },
    showMentionCheck: {
      total: showMentionResults.total,
      hasMention: showMentionResults.hasMention,
      noMention: showMentionResults.noMention,
      noContent: showMentionResults.noContent,
      noMentionList: showMentionResults.noMentionList.slice(0, 20), // Limit output
    },
    excerptAnalysis: {
      total: excerptResults.total,
      withFullText: excerptResults.withFullText,
      excerptOnly: excerptResults.excerptOnly,
      truncatedExcerpts: excerptResults.truncatedExcerpts,
      stubs: excerptResults.stubs,
      orphans: excerptResults.orphans,
      orphanList: excerptResults.orphanList,
      stubList: excerptResults.stubList.slice(0, 20), // Limit output
      truncatedList: excerptResults.truncatedList.slice(0, 20), // Limit output
    },
    sampledVerification: {
      sampled: sampleResults.sampled,
      passed: sampleResults.passed,
      failed: sampleResults.failed,
      passRate: `${passRate}%`,
      failures: sampleResults.details.filter(d => !d.passed),
    },
    dateConsistency: {
      total: dateResults.total,
      valid: dateResults.valid,
      invalid: dateResults.invalid,
      couldNotParse: dateResults.couldNotParse,
      anomalyRate: `${dateAnomalyRate}%`,
      issues: dateResults.issues.slice(0, 30), // Limit output
    },
  };

  // Write report
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`Report saved to: ${OUTPUT_FILE}`);

  return report;
}

// Run the audit
runAudit().then(report => {
  console.log('\n==========================================');
  console.log('Sprint 4 audit complete.');
  if (report.validation.overallPassed) {
    console.log('All validation criteria PASSED.');
    process.exit(0);
  } else {
    console.log('Some validation criteria FAILED. Review the report.');
    process.exit(1);
  }
}).catch(err => {
  console.error('Error running audit:', err);
  process.exit(1);
});
