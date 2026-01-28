/**
 * Review Normalization Module
 *
 * Centralizes all outlet and critic name normalization to prevent duplicate
 * review files from being created with slightly different names.
 *
 * Used by:
 * - scripts/gather-reviews.js (when creating review files)
 * - scripts/build-master-review-list.js (when deduplicating)
 * - scripts/cleanup-duplicate-reviews.js (for fixing existing duplicates)
 *
 * IMPORTANT: When adding new outlet variations, add them to OUTLET_ALIASES.
 * When adding known critic name variations, add them to CRITIC_ALIASES.
 */

/**
 * Canonical outlet IDs and all known variations/aliases.
 * The key is the canonical ID, values are all variations that should map to it.
 *
 * Format: 'canonical-id': ['variation1', 'variation2', ...]
 * Variations should be lowercase.
 */
const OUTLET_ALIASES = {
  'nytimes': [
    'nytimes', 'new york times', 'the new york times', 'ny times', 'nyt',
    'newyorktimes', 'new-york-times', 'the-new-york-times'
  ],
  'vulture': [
    'vulture', 'new york magazine / vulture', 'new york magazine/vulture',
    'ny mag', 'nymag', 'new york magazine', 'vult'
  ],
  'variety': [
    'variety', 'variety magazine'
  ],
  'hollywood-reporter': [
    'hollywood reporter', 'the hollywood reporter', 'thr', 'hollywoodreporter'
  ],
  'deadline': [
    'deadline', 'deadline hollywood', 'deadline.com'
  ],
  'timeout': [
    'timeout', 'time out', 'time out new york', 'timeout new york',
    'time out ny', 'timeout ny', 'timeout-ny', 'time-out-new-york'
  ],
  'guardian': [
    'guardian', 'the guardian', 'theguardian'
  ],
  'washpost': [
    'washpost', 'washington post', 'the washington post', 'wapo',
    'wash post', 'washingtonpost'
  ],
  'wsj': [
    'wsj', 'wall street journal', 'the wall street journal',
    'wallstreetjournal', 'wall-street-journal'
  ],
  'nypost': [
    'nypost', 'new york post', 'ny post', 'nyp', 'newyorkpost', 'new-york-post'
  ],
  'nydailynews': [
    'nydailynews', 'new york daily news', 'daily news', 'ny daily news',
    'nydn', 'newyorkdailynews', 'new-york-daily-news'
  ],
  'ew': [
    'ew', 'entertainment weekly', 'entertainmentweekly', 'entertainment-weekly'
  ],
  'theatermania': [
    'theatermania', 'theater mania', 'theatremania', 'theatre mania', 'tmania'
  ],
  'broadwaynews': [
    'broadwaynews', 'broadway news', 'broadway-news', 'bwaynews'
  ],
  'broadwayworld': [
    'broadwayworld', 'broadway world', 'bww', 'broadway-world'
  ],
  'playbill': [
    'playbill', 'play bill'
  ],
  'thewrap': [
    'thewrap', 'the wrap', 'wrap', 'the-wrap'
  ],
  'indiewire': [
    'indiewire', 'indie wire', 'indie-wire'
  ],
  'observer': [
    'observer', 'the observer', 'ny observer', 'new york observer'
  ],
  'newyorker': [
    'newyorker', 'the new yorker', 'new yorker', 'the-new-yorker', 'new-yorker'
  ],
  'ap': [
    'ap', 'associated press', 'the associated press', 'ap news'
  ],
  'reuters': [
    'reuters'
  ],
  'theatrely': [
    'theatrely', 'theater ly', 'thly'
  ],
  'nysr': [
    'nysr', 'new york stage review', 'ny stage review',
    'newyorkstagereview', 'new-york-stage-review', 'ny-stage-review'
  ],
  'nytg': [
    'nytg', 'new york theatre guide', 'ny theatre guide', 'nytheatreguide',
    'new-york-theatre-guide', 'new york theater guide'
  ],
  'nyt-theater': [
    'nyt-theater', 'new york theater', 'newyorktheater', 'ny theater',
    'new-york-theater'
  ],
  'cititour': [
    'cititour', 'citi tour', 'city tour'
  ],
  'stageandcinema': [
    'stageandcinema', 'stage and cinema', 'stage & cinema', 'stage-and-cinema'
  ],
  'talkinbroadway': [
    'talkinbroadway', 'talkin broadway', "talkin' broadway", 'talkin-broadway'
  ],
  'frontmezzjunkies': [
    'frontmezzjunkies', 'front mezz junkies', 'front-mezz-junkies', 'fmj'
  ],
  'dailybeast': [
    'dailybeast', 'the daily beast', 'daily beast', 'tdb', 'the-daily-beast'
  ],
  'usatoday': [
    'usatoday', 'usa today', 'usa-today'
  ],
  'forward': [
    'forward', 'the forward', 'jewish forward'
  ],
  'rollingstone': [
    'rollingstone', 'rolling stone', 'rolling-stone'
  ],
  'chicagotribune': [
    'chicagotribune', 'chicago tribune', 'chicago-tribune', 'chi tribune'
  ],
  'latimes': [
    'latimes', 'los angeles times', 'la times', 'los-angeles-times'
  ],
  'sfchronicle': [
    'sfchronicle', 'san francisco chronicle', 'sf chronicle'
  ],
  'thestage': [
    'thestage', 'the stage', 'stage', 'the-stage'
  ],
  'whatsonstage': [
    'whatsonstage', "what's on stage", 'whats on stage', 'whatson', 'whats-on-stage'
  ],
  'telegraph': [
    'telegraph', 'the telegraph', 'daily telegraph'
  ],
  'financialtimes': [
    'financialtimes', 'financial times', 'ft', 'the financial times'
  ],
  'billboard': [
    'billboard', 'bill board'
  ],
  'amny': [
    'amny', 'amnewyork', 'am new york', 'am-new-york', 'amnewsyork'
  ],
  'culturesauce': [
    'culturesauce', 'culture sauce', 'culture-sauce'
  ],
  'oneminutecritic': [
    'oneminutecritic', 'one minute critic', 'one-minute-critic', '1 minute critic'
  ],
  'artsfuse': [
    'artsfuse', 'the arts fuse', 'arts fuse', 'the-arts-fuse'
  ],
  'jitney': [
    'jitney', 'the jitney', 'the-jitney'
  ],
  'slantmagazine': [
    'slantmagazine', 'slant magazine', 'slant', 'slant-magazine'
  ],
  'buzzfeed': [
    'buzzfeed', 'buzz feed', 'buzz-feed'
  ],
  'vox': [
    'vox', 'vox media'
  ],
  'huffpost': [
    'huffpost', 'huffington post', 'the huffington post', 'huff post'
  ],
  'nbcnews': [
    'nbcnews', 'nbc news', 'nbc', 'nbc-news'
  ],
  'cbsnews': [
    'cbsnews', 'cbs news', 'cbs', 'cbs-news'
  ],
  'newsweek': [
    'newsweek', 'news week'
  ],
  'time': [
    'time', 'time magazine'
  ],
  'newyorkmagazine': [
    'newyorkmagazine', 'new york magazine', 'ny magazine', 'ny mag'
  ],
  // New outlets from BWW/DTLI extraction scripts
  'newsday': [
    'newsday', 'news day'
  ],
  'npr': [
    'npr', 'national public radio', 'n.p.r.'
  ],
  'njcom': [
    'njcom', 'nj.com', 'nj-com', 'nj dot com'
  ],
  'dctheatrescene': [
    'dctheatrescene', 'dc theatre scene', 'dc-theatre-scene', 'dc theater scene'
  ],
  'nbcny': [
    'nbcny', 'nbc new york', 'nbc-ny', 'nbc ny', 'nbc-new-york'
  ],
  'londontheatre': [
    'londontheatre', 'london theatre', 'london-theatre', 'london theater'
  ],
  'towncountry': [
    'towncountry', 'town & country', 'town-country', 'town and country', 'town-and-country'
  ],
  'vanityfair': [
    'vanityfair', 'vanity fair', 'vanity-fair'
  ],
  'vogue': [
    'vogue', 'vogue magazine'
  ],
  'artsdesk': [
    'artsdesk', 'the arts desk', 'arts-desk', 'arts desk', 'the-arts-desk'
  ],
};

/**
 * Known critic name variations and typos.
 * Maps variations to canonical names.
 * Format: 'canonical-name': ['variation1', 'variation2', ...]
 */
const CRITIC_ALIASES = {
  // IMPORTANT: Only include FULL NAME variations and KNOWN TYPOS.
  // Do NOT include first-name-only aliases (e.g., 'jesse', 'ben') as they
  // will incorrectly match other critics with the same first name.
  'jesse-green': ['jesse green', 'j. green'],
  'ben-brantley': ['ben brantley', 'b. brantley'],
  'charles-isherwood': ['charles isherwood', 'c. isherwood'],
  'johnny-oleksinski': ['johnny oleksinski', 'johnny oleksinki', 'john oleksinski'], // Note: 'oleksinki' typo
  'sara-holdren': ['sara holdren', 's. holdren'],
  'helen-shaw': ['helen shaw', 'h. shaw'],
  'adam-feldman': ['adam feldman', 'a. feldman'],
  'david-rooney': ['david rooney', 'd. rooney'],
  'frank-scheck': ['frank scheck', 'f. scheck'],
  'greg-evans': ['greg evans', 'g. evans'],
  'dalton-ross': ['dalton ross', 'd. ross'],
  'aramide-tinubu': ['aramide tinubu', 'aramide timubu'], // Note: 'timubu' typo
  'juan-a-ramirez': ['juan a ramirez', 'juan a. ramirez', 'juan ramirez'],
  'zachary-stewart': ['zachary stewart', 'zach stewart', 'z. stewart'],
  'brittani-samuel': ['brittani samuel', 'b. samuel'],
  'chris-jones': ['chris jones', 'c. jones', 'christopher jones'],
  'gillian-russo': ['gillian russo', 'g. russo'],
  'jd-knapp': ['jd knapp', 'j.d. knapp', 'j d knapp'],
  'vinson-cunningham': ['vinson cunningham', 'v. cunningham'],
  'naveen-kumar': ['naveen kumar', 'n. kumar'],
  'jonathan-mandell': ['jonathan mandell', 'j. mandell', 'jon mandell'],
  'brian-scott-lipton': ['brian scott lipton', 'brian lipton', 'b. lipton'],
  'melissa-rose-bernardo': ['melissa rose bernardo', 'melissa bernardo', 'm. bernardo'],
  'david-finkle': ['david finkle', 'd. finkle'],
  'david-cote': ['david cote', 'd. cote'],
  'tim-teeman': ['tim teeman', 't. teeman'],
  'kristen-baldwin': ['kristen baldwin', 'k. baldwin'],
  'adrian-horton': ['adrian horton', 'a. horton'],
  'lane-williamson': ['lane williamson', 'l. williamson'],
  'linda-winer': ['linda winer', 'l. winer'],
  'michael-kuchwara': ['michael kuchwara', 'm. kuchwara'],
  'rex-reed': ['rex reed', 'r. reed'],
  'elysa-gardner': ['elysa gardner', 'e. gardner'],
  'peter-marks': ['peter marks', 'p. marks'],
  'matt-windman': ['matt windman', 'm. windman', 'matthew windman'],
  'robert-hofler': ['robert hofler', 'r. hofler', 'bob hofler'],
  'steven-suskin': ['steven suskin', 's. suskin', 'steve suskin'],
};

/**
 * Normalize an outlet name to its canonical ID.
 * Returns the canonical outlet ID (lowercase, hyphenated).
 */
function normalizeOutlet(outletName) {
  if (!outletName) return 'unknown';

  const lower = outletName.toLowerCase().trim();

  // Check against all aliases
  for (const [canonical, aliases] of Object.entries(OUTLET_ALIASES)) {
    if (aliases.some(alias => {
      // Exact match
      if (lower === alias) return true;
      // Remove "the " prefix and check
      if (lower.replace(/^the\s+/, '') === alias) return true;
      if (alias.replace(/^the\s+/, '') === lower) return true;
      return false;
    })) {
      return canonical;
    }
  }

  // Not found in aliases - create a slug from the name
  return slugify(outletName);
}

/**
 * Normalize a critic name to its canonical form.
 * Returns the canonical critic name (lowercase, hyphenated).
 */
function normalizeCritic(criticName) {
  if (!criticName) return 'unknown';

  const lower = criticName.toLowerCase().trim();

  // Check against all aliases
  for (const [canonical, aliases] of Object.entries(CRITIC_ALIASES)) {
    if (aliases.some(alias => {
      // Exact match only - no partial/first-name matching
      // (first-name matching was causing Jesse Oxfeld → jesse-green)
      if (lower === alias) return true;
      return false;
    })) {
      return canonical;
    }
  }

  // Not found in aliases - create a slug from the full name
  // But first, ensure we have a reasonable name (at least 2 chars)
  if (lower.length < 2) return 'unknown';

  return slugify(criticName);
}

/**
 * Generate a standardized filename for a review.
 * Format: {outlet}--{critic}.json
 */
function generateReviewFilename(outlet, critic) {
  const normalizedOutlet = normalizeOutlet(outlet);
  const normalizedCritic = normalizeCritic(critic);
  return `${normalizedOutlet}--${normalizedCritic}.json`;
}

/**
 * Generate a unique review key for deduplication.
 * This is used to identify the same review across different sources.
 */
function generateReviewKey(outlet, critic) {
  return `${normalizeOutlet(outlet)}|${normalizeCritic(critic)}`;
}

/**
 * Create a slug from text (lowercase, hyphenated, no special chars)
 */
function slugify(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/['']/g, '')           // Remove apostrophes
    .replace(/[&]/g, 'and')         // Replace & with and
    .replace(/[^\w\s-]/g, '')       // Remove special chars except spaces and hyphens
    .replace(/\s+/g, '-')           // Replace spaces with hyphens
    .replace(/-+/g, '-')            // Collapse multiple hyphens
    .replace(/^-+|-+$/g, '');       // Trim hyphens from ends
}

/**
 * Check if two reviews are duplicates based on outlet and critic.
 * Returns true if they represent the same review.
 */
function areReviewsDuplicates(review1, review2) {
  const key1 = generateReviewKey(review1.outlet, review1.criticName);
  const key2 = generateReviewKey(review2.outlet, review2.criticName);
  return key1 === key2;
}

/**
 * Calculate Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Check if two critic names are similar enough to be the same person.
 * Handles cases like "Jesse Green" vs "Jesse" or typos.
 */
function areCriticsSimilar(critic1, critic2) {
  if (!critic1 || !critic2) return false;

  const c1 = critic1.toLowerCase().trim();
  const c2 = critic2.toLowerCase().trim();

  // Exact match
  if (c1 === c2) return true;

  // Normalize both
  const n1 = normalizeCritic(critic1);
  const n2 = normalizeCritic(critic2);
  if (n1 === n2) return true;

  // First name match (for "Jesse" vs "Jesse Green")
  const firstName1 = c1.split(/\s+/)[0];
  const firstName2 = c2.split(/\s+/)[0];
  if (firstName1 === firstName2 && firstName1.length > 2) {
    // If first names match, check if one is a subset of the other
    if (c1.startsWith(firstName2) || c2.startsWith(firstName1)) {
      return true;
    }
  }

  // Levenshtein distance for typos (threshold: 2 chars difference for names > 5 chars)
  if (c1.length > 5 && c2.length > 5) {
    const distance = levenshteinDistance(c1, c2);
    if (distance <= 2) return true;
  }

  return false;
}

/**
 * Check if two outlet names refer to the same outlet.
 */
function areOutletsSame(outlet1, outlet2) {
  if (!outlet1 || !outlet2) return false;
  return normalizeOutlet(outlet1) === normalizeOutlet(outlet2);
}

/**
 * Merge two review objects, keeping the best data from each.
 * Prefers: longer text, more complete URLs, original scores, etc.
 */
function mergeReviews(existing, incoming) {
  const merged = { ...existing };

  // Prefer longer/more complete fullText
  if (incoming.fullText) {
    if (!existing.fullText || incoming.fullText.length > existing.fullText.length) {
      merged.fullText = incoming.fullText;
    }
  }

  // Prefer valid URLs
  if (incoming.url && (!existing.url || existing.url.includes('undefined'))) {
    merged.url = incoming.url;
  }

  // Keep all excerpts
  if (incoming.dtliExcerpt && !existing.dtliExcerpt) {
    merged.dtliExcerpt = incoming.dtliExcerpt;
  }
  if (incoming.bwwExcerpt && !existing.bwwExcerpt) {
    merged.bwwExcerpt = incoming.bwwExcerpt;
  }
  if (incoming.showScoreExcerpt && !existing.showScoreExcerpt) {
    merged.showScoreExcerpt = incoming.showScoreExcerpt;
  }

  // Keep thumb data
  if (incoming.dtliThumb && !existing.dtliThumb) {
    merged.dtliThumb = incoming.dtliThumb;
  }
  if (incoming.bwwThumb && !existing.bwwThumb) {
    merged.bwwThumb = incoming.bwwThumb;
  }

  // Prefer original scores
  if (incoming.originalScore && !existing.originalScore) {
    merged.originalScore = incoming.originalScore;
    merged.originalRating = incoming.originalRating;
  }

  // Keep better publish date
  if (incoming.publishDate && !existing.publishDate) {
    merged.publishDate = incoming.publishDate;
  }

  // Track all sources
  const sources = new Set();
  if (existing.source) sources.add(existing.source);
  if (incoming.source) sources.add(incoming.source);
  if (existing.sources) existing.sources.forEach(s => sources.add(s));
  if (incoming.sources) incoming.sources.forEach(s => sources.add(s));
  merged.sources = Array.from(sources);
  merged.source = merged.sources[0]; // Keep primary source

  return merged;
}

/**
 * Get the canonical display name for an outlet ID.
 */
function getOutletDisplayName(outletId) {
  const displayNames = {
    'nytimes': 'The New York Times',
    'vulture': 'Vulture',
    'variety': 'Variety',
    'hollywood-reporter': 'The Hollywood Reporter',
    'deadline': 'Deadline',
    'timeout': 'Time Out New York',
    'guardian': 'The Guardian',
    'washpost': 'The Washington Post',
    'wsj': 'The Wall Street Journal',
    'nypost': 'New York Post',
    'nydailynews': 'New York Daily News',
    'ew': 'Entertainment Weekly',
    'theatermania': 'TheaterMania',
    'broadwaynews': 'Broadway News',
    'broadwayworld': 'BroadwayWorld',
    'playbill': 'Playbill',
    'thewrap': 'The Wrap',
    'indiewire': 'IndieWire',
    'observer': 'Observer',
    'newyorker': 'The New Yorker',
    'ap': 'Associated Press',
    'theatrely': 'Theatrely',
    'nysr': 'New York Stage Review',
    'nytg': 'New York Theatre Guide',
    'nyt-theater': 'New York Theater',
    'cititour': 'Cititour',
    'stageandcinema': 'Stage and Cinema',
    'talkinbroadway': "Talkin' Broadway",
    'frontmezzjunkies': 'Front Mezz Junkies',
    'dailybeast': 'The Daily Beast',
    'usatoday': 'USA Today',
    'forward': 'The Forward',
    'rollingstone': 'Rolling Stone',
    'thestage': 'The Stage',
    'chicagotribune': 'Chicago Tribune',
    'latimes': 'Los Angeles Times',
    'sfchronicle': 'San Francisco Chronicle',
    'whatsonstage': "What's On Stage",
    'telegraph': 'The Telegraph',
    'financialtimes': 'Financial Times',
    'billboard': 'Billboard',
    'amny': 'amNewYork',
    'culturesauce': 'Culture Sauce',
    'oneminutecritic': 'One Minute Critic',
    'artsfuse': 'The Arts Fuse',
    'jitney': 'The Jitney',
    'slantmagazine': 'Slant Magazine',
    'buzzfeed': 'BuzzFeed',
    'vox': 'Vox',
    'huffpost': 'HuffPost',
    'nbcnews': 'NBC News',
    'cbsnews': 'CBS News',
    'newsweek': 'Newsweek',
    'time': 'Time',
    'newyorkmagazine': 'New York Magazine',
    // New outlets from BWW/DTLI
    'newsday': 'Newsday',
    'npr': 'NPR',
    'njcom': 'NJ.com',
    'dctheatrescene': 'DC Theatre Scene',
    'nbcny': 'NBC New York',
    'londontheatre': 'London Theatre',
    'towncountry': 'Town & Country',
    'vanityfair': 'Vanity Fair',
    'vogue': 'Vogue',
    'artsdesk': 'The Arts Desk',
  };

  return displayNames[outletId] || outletId;
}

module.exports = {
  normalizeOutlet,
  normalizeCritic,
  generateReviewFilename,
  generateReviewKey,
  slugify,
  areReviewsDuplicates,
  areCriticsSimilar,
  areOutletsSame,
  mergeReviews,
  getOutletDisplayName,
  levenshteinDistance,
  OUTLET_ALIASES,
  CRITIC_ALIASES,
};
