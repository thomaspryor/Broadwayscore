/**
 * Production Verifier Module
 *
 * Verifies that a review is for the correct production before saving.
 * Prevents off-Broadway, touring, West End, or wrong revival reviews
 * from being added to Broadway show folders.
 *
 * Used by:
 * - gather-reviews.js (pre-save hook)
 * - collect-review-texts.js (validation)
 */

const fs = require('fs');
const path = require('path');

// Known wrong-production indicators from audit-wrong-production-reviews.js
const KNOWN_WRONG_INDICATORS = {
  'our-town-2024': {
    expectedIndicators: ['2024', 'Barrymore Theatre', 'Jim Parsons', 'Zoey Deutch', 'Kenny Leon', 'Katie Holmes'],
    wrongIndicators: ['2002', 'Booth Theatre', 'Paul Newman', '2003', '1988', 'Spalding Gray', 'Lincoln Center'],
    minWrongIndicators: 1
  },
  'suffs-2024': {
    expectedIndicators: ['2024', 'Music Box Theatre', 'Broadway', 'Shaina Taub', 'Nikki M. James', 'Jenn Colella'],
    wrongIndicators: ['2022', 'Public Theater', 'off-Broadway', 'Off-Broadway', 'off Broadway', 'downtown'],
    minWrongIndicators: 2
  },
  'the-whos-tommy-2024': {
    expectedIndicators: ['2024', 'Nederlander Theatre', 'Ali Louis Bourzgui', 'Adam Jacobs', 'Alison Luff'],
    wrongIndicators: ['2019', 'Kennedy Center', 'Casey Cott', '1993', 'St. James Theatre', 'Michael Cerveris'],
    minWrongIndicators: 2
  },
  'cabaret-2024': {
    expectedIndicators: ['2024', 'August Wilson Theatre', 'Eddie Redmayne', 'Gayle Rankin', 'Kit Kat Club', 'Rebecca Frecknall'],
    wrongIndicators: ['1998', 'Studio 54', 'Alan Cumming', 'Natasha Richardson', 'Sam Mendes', 'Roundabout', '1966'],
    minWrongIndicators: 2
  },
  'merrily-we-roll-along-2023': {
    expectedIndicators: ['2023', 'Hudson Theatre', 'Jonathan Groff', 'Daniel Radcliffe', 'Lindsay Mendez', 'Maria Friedman'],
    wrongIndicators: ['1981', 'Alvin Theatre', 'Jim Walton', 'Lonny Price', 'Ann Morrison', 'Off-Broadway', 'York Theatre'],
    minWrongIndicators: 2
  },
  'hadestown-2019': {
    expectedIndicators: ['2019', 'Walter Kerr Theatre', 'Broadway', 'Reeve Carney', 'Eva Noblezada', 'Patrick Page'],
    wrongIndicators: ['2016', 'New York Theatre Workshop', 'NYTW', 'off-Broadway', 'Off-Broadway', 'Citadel Theatre', '2017'],
    minWrongIndicators: 1
  },
  'an-enemy-of-the-people-2024': {
    expectedIndicators: ['2024', 'Circle in the Square', 'Jeremy Strong', 'Sam Gold', 'Michael Imperioli'],
    wrongIndicators: ['2012', 'Samuel J. Friedman', 'Boyd Gaines', 'Richard Thomas'],
    minWrongIndicators: 1
  },
  'the-wiz-2024': {
    expectedIndicators: ['2024', 'Marquis Theatre', 'Wayne Brady', 'Deborah Cox', 'Amber Ruffin'],
    wrongIndicators: ['1975', 'Majestic Theatre', 'Stephanie Mills', 'Andre De Shields', 'Geoffrey Holder'],
    minWrongIndicators: 2
  },
  'purlie-victorious-2023': {
    expectedIndicators: ['2023', 'Music Box Theatre', 'Leslie Odom Jr.', 'Kara Young', 'Heather Headley'],
    wrongIndicators: ['1961', 'Cort Theatre', 'Ossie Davis', 'Ruby Dee', 'Godfrey Cambridge'],
    minWrongIndicators: 2
  },
  'doubt-2024': {
    expectedIndicators: ['2024', 'Todd Haimes Theatre', 'Amy Ryan', 'Liev Schreiber', 'Zoe Kazan'],
    wrongIndicators: ['2005', 'Walter Kerr Theatre', 'Cherry Jones', 'Brian F. O\'Byrne'],
    minWrongIndicators: 2
  },
  'appropriate-2023': {
    expectedIndicators: ['2023', '2024', 'Hayes Theater', 'Sarah Paulson', 'Corey Stoll', 'Lila Neugebauer'],
    wrongIndicators: ['2014', 'Signature Theatre', 'Off-Broadway'],
    minWrongIndicators: 2
  }
};

// London venues (for detecting UK reviews in Broadway/OB shows)
// Expanded to cover fringe, off-West End, and regional London venues
const WEST_END_VENUES = [
  // Major West End
  'Phoenix Theatre', 'Piccadilly Theatre', 'Prince Edward Theatre',
  'Prince of Wales Theatre', 'Dominion Theatre', 'Adelphi Theatre',
  'Gielgud Theatre', 'Savoy Theatre', 'Lyceum Theatre London',
  'London Palladium', 'Theatre Royal Drury Lane', 'Apollo Theatre',
  'Wyndham\'s Theatre', 'Noël Coward Theatre', 'Harold Pinter Theatre',
  'Vaudeville Theatre', 'Playhouse Theatre', 'Criterion Theatre',
  'Fortune Theatre', 'Garrick Theatre', 'Novello Theatre',
  'Duchess Theatre', 'Duke of York\'s Theatre', 'Tom Stoppard Theatre', 'Ambassadors Theatre',
  'Trafalgar Theatre', 'Gillian Lynne Theatre', '@sohoplace',
  // National/subsidized
  'National Theatre', 'Old Vic', 'Young Vic', 'Barbican',
  'Donmar Warehouse', 'Hampstead Theatre', 'Almeida Theatre',
  'Royal Court Theatre', 'Bush Theatre', 'Menier Chocolate Factory',
  // Fringe/Off-West End (where Edinburgh transfers land)
  'Arcola Theatre', 'Soho Theatre London', 'Gate Theatre London',
  'Southwark Playhouse', 'Park Theatre London', 'Kiln Theatre',
  'Lyric Hammersmith', 'Battersea Arts Centre', 'Riverside Studios',
  'Theatre503', 'Finborough Theatre', 'Jermyn Street Theatre',
  'Bridge Theatre', 'Hackney Empire', 'Wilton\'s Music Hall',
  'Sadler\'s Wells', 'Peacock Theatre', 'Ovalhouse', 'Camden People\'s Theatre'
];

// UK touring houses outside London (BRO-2278). A UK tour plays one city a week
// with the same cast, so SERP discovery for the London leg turns up reviews of
// other legs ("runs until 18 April at the Lowry, Salford" on the Queen
// Elizabeth Hall page, BRO-749). Merged with data/uk-regional-venues.json's
// producing houses below. London venues are deliberately NOT in this list:
// a West End review naming another London house is usually transfer history.
const UK_TOURING_VENUES = [
  'The Lowry', 'Lowry Theatre', 'Alhambra Theatre', 'Bradford Alhambra',
  'Wales Millennium Centre', 'Mayflower Theatre', 'Bristol Hippodrome',
  'Birmingham Hippodrome', 'Palace Theatre Manchester', 'Opera House Manchester',
  'Manchester Opera House', 'Edinburgh Playhouse', 'Festival Theatre Edinburgh',
  "King's Theatre Glasgow", 'Theatre Royal Glasgow', 'Liverpool Empire',
  'Sunderland Empire', 'Milton Keynes Theatre', 'New Victoria Theatre',
  'Grand Opera House Belfast', 'Leeds Grand Theatre', 'Grand Theatre Leeds',
  'Lyceum Theatre Sheffield', 'Sheffield Lyceum', 'Theatre Royal Nottingham',
  'Belgrade Theatre', 'Rose Theatre Kingston', 'Hall for Cornwall',
  'Winter Gardens Blackpool', 'Blackpool Grand', 'Congress Theatre',
  'Theatre Royal Plymouth', 'Theatre Royal Brighton', 'Theatre Royal Bath',
  'Theatre Royal Newcastle', 'Newcastle Theatre Royal', 'Theatre Royal Norwich',
  'Norwich Theatre Royal', 'Curve Leicester', 'Leicester Curve',
  'Marlowe Theatre', 'Cliffs Pavilion', 'Regent Theatre Stoke',
  'Hull New Theatre', 'Bord Gáis Energy Theatre', 'Aberdeen His Majesty',
  'Eden Court', 'Venue Cymru', 'Swansea Grand', 'Oxford Playhouse',
  'New Theatre Oxford', 'Cambridge Arts Theatre', 'Northern Stage',
  'Nuffield Southampton', 'Octagon Theatre Bolton', 'Storyhouse',
];

let _otherLegVenues = null;
function otherLegVenueNames() {
  if (_otherLegVenues) return _otherLegVenues;
  const names = new Set(UK_TOURING_VENUES);
  try {
    const regional = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'uk-regional-venues.json'), 'utf8'));
    for (const v of regional) {
      if (v.venue) names.add(v.venue);
      for (const a of v.aliases || []) names.add(a);
    }
  } catch { /* the hardcoded touring list still applies */ }
  _otherLegVenues = [...names];
  return _otherLegVenues;
}

const VENUE_FILLER_RE = /\b(the|theatre|theater|playhouse|hall|centre|center|main|stage|house)\b/g;
function venueCore(v) {
  return String(v || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9' ]+/g, ' ')
    .replace(VENUE_FILLER_RE, ' ').replace(/\s+/g, ' ').trim();
}

// "runs until 18 April at the Lowry", "at the Lowry, Salford until Saturday",
// "plays the Alhambra this week": present-tense run language tying the review
// to THAT venue's leg. A bare mention ("the tour visits the Lowry later") is
// not enough.
const CURRENT_RUN_RE = /\buntil\b|\bthis week\b|\b(?:runs|running|plays|playing|continues) (?:at|in)\b/;
// Tour framing around the OTHER venue: the review is of this leg and names
// where the tour goes next or came from.
const TOUR_FRAMING_RE = /\b(then tours?|tour continues|touring to|tours to|next stop|before touring|before heading|heads? to|moves? to|transfers? to|after (?:its|a) run|following (?:its|a) run|previously|last year|originally|first seen|premiered|on tour)\b/;

/**
 * BRO-2278: on a West End / Off-West End show, find a review that names a
 * DIFFERENT UK touring/regional venue as where the production is running now,
 * without ever naming the show's own venue. Returns the matched venue and its
 * context, or null. Pure; exported for the corpus audit and tests.
 */
function findOtherTourLegVenue(text, showVenue) {
  if (!text || !showVenue) return null;
  const textLower = text.toLowerCase();
  const ownCore = venueCore(showVenue);
  if (!ownCore) return null;
  // The show's own venue anywhere in the text: this review covers this leg
  // (it may also name the next stop). Every word of the core must appear.
  const ownWords = ownCore.split(' ').filter((w) => w.length > 2);
  if (ownWords.length && ownWords.every((w) => textLower.includes(w))) return null;

  for (const name of otherLegVenueNames()) {
    const lower = name.toLowerCase();
    const idx = textLower.indexOf(lower);
    if (idx === -1) continue;
    const otherCore = venueCore(name);
    if (!otherCore || ownCore.includes(otherCore) || otherCore.includes(ownCore)) continue;
    const context = textLower.substring(Math.max(0, idx - 120), Math.min(textLower.length, idx + lower.length + 120));
    if (TOUR_FRAMING_RE.test(context)) continue;
    if (!CURRENT_RUN_RE.test(context)) continue;
    return { venue: name, context };
  }
  return null;
}

// UK publication indicators
const UK_PUBLICATIONS = [
  'guardian', 'telegraph', 'independent.co.uk', 'standard.co.uk',
  'timeout.com/london', 'whatsonstage', 'thestage.co.uk', 'observer'
];

/**
 * Verify a review is for the correct production
 * @param {Object} params
 * @param {string} params.showId - Show ID (e.g., "hadestown-2019")
 * @param {string} params.url - Review URL
 * @param {string} params.publishDate - Publish date string
 * @param {string} params.text - Review text content (fullText or excerpt)
 * @param {Object} params.showData - Show metadata from shows.json (optional)
 * @param {string} params.category - Show category ('broadway', 'off-broadway', 'west-end', 'off-west-end')
 * @returns {Object} { isValid, issues, confidence, shouldReject }
 */
function verifyProduction({ showId, url, publishDate, text, showData, category }) {
  const issues = [];
  let confidence = 'low';
  const isOffBroadway = category === 'off-broadway';

  // Extract expected year from show ID
  const yearMatch = showId.match(/-(\d{4})$/);
  const expectedYear = yearMatch ? parseInt(yearMatch[1]) : null;

  // Get show-specific indicators — skip for off-Broadway shows since their
  // wrongIndicators include "off-Broadway", "Public Theater", etc. which are
  // CORRECT for off-Broadway productions
  const indicators = isOffBroadway ? null : KNOWN_WRONG_INDICATORS[showId];

  // NOTE: Do NOT extract years from URLs. URL patterns are inconsistent across outlets
  // (republished content, migrated URLs, article IDs that look like years, etc.).
  // Use publish date and review text content for production verification instead.

  // 1. Check publish date for wrong year
  if (publishDate && expectedYear) {
    const dateYearMatch = publishDate.match(/\b(20\d{2})\b/);
    if (dateYearMatch) {
      const dateYear = parseInt(dateYearMatch[1]);
      // Allow 1 year before expected (for previews)
      if (dateYear < expectedYear - 1) {
        issues.push({
          type: 'publish_date_mismatch',
          message: `Publish date year ${dateYear} doesn't match expected ${expectedYear}`,
          severity: 'high'
        });
        confidence = 'high';
      }
    }
  }

  // 3. Check for West End indicators (wrong geographic production)
  if (url) {
    const urlLower = url.toLowerCase();
    for (const ukPub of UK_PUBLICATIONS) {
      if (urlLower.includes(ukPub)) {
        // UK publication - check if show has had UK production
        issues.push({
          type: 'uk_publication',
          message: `URL appears to be from UK publication (${ukPub})`,
          severity: 'medium'
        });
        if (confidence === 'low') confidence = 'medium';
      }
    }
  }

  // 4. Check text for wrong production indicators
  if (text && indicators) {
    const textLower = text.toLowerCase();
    let wrongFound = 0;
    let expectedFound = 0;
    const wrongMatches = [];

    for (const wrong of indicators.wrongIndicators) {
      if (textLower.includes(wrong.toLowerCase())) {
        // Check context to avoid false positives
        const idx = textLower.indexOf(wrong.toLowerCase());
        const context = text.slice(Math.max(0, idx - 100), Math.min(text.length, idx + wrong.length + 100));

        // Skip if in comparison context
        const comparisonPatterns = [
          'originally', 'first production', 'premiere', 'debut',
          'in the original', 'previous revival', 'last revival',
          'transferred to', 'moving to', 'prior to'
        ];

        const isComparison = comparisonPatterns.some(p => context.toLowerCase().includes(p));
        if (!isComparison) {
          wrongFound++;
          wrongMatches.push(wrong);
        }
      }
    }

    for (const expected of indicators.expectedIndicators) {
      if (textLower.includes(expected.toLowerCase())) {
        expectedFound++;
      }
    }

    // Flag if wrong indicators found without expected indicators
    if (wrongFound >= (indicators.minWrongIndicators || 2)) {
      if (expectedFound === 0) {
        issues.push({
          type: 'wrong_production_text',
          message: `Found wrong production indicators: ${wrongMatches.join(', ')}`,
          severity: 'high'
        });
        confidence = 'high';
      } else {
        issues.push({
          type: 'mixed_production_text',
          message: `Found both wrong (${wrongMatches.join(', ')}) and expected indicators`,
          severity: 'low'
        });
      }
    }
  }

  // 5. Check for London venues in text (strong wrongProduction signal for Broadway/OB)
  if (text) {
    const textLower = text.toLowerCase();
    for (const venue of WEST_END_VENUES) {
      const venueLower = venue.toLowerCase();
      const venueIdx = textLower.indexOf(venueLower);
      if (venueIdx === -1) continue;

      const isUSShow = category === 'broadway' || category === 'off-broadway';
      if (!isUSShow) {
        // For WE shows, London venues are expected — low severity info only
        issues.push({
          type: 'london_venue',
          message: `Found London venue: ${venue}`,
          severity: 'low'
        });
        continue;
      }

      // For US shows, check if it's a transfer/origin mention vs reviewing the London production
      // Look at the ~150 chars around the venue mention for transfer context
      const contextStart = Math.max(0, venueIdx - 150);
      const contextEnd = Math.min(textLower.length, venueIdx + venueLower.length + 150);
      const context = textLower.substring(contextStart, contextEnd);

      const transferPatterns = [
        // Direct transfer language
        'transferred from', 'transfer from', 'transferred to',
        'originated at', 'originated in', 'premiered at', 'premiered in',
        'premiering at', 'premiering in',  // present tense
        'presented at', 'presented by',
        'debuted at', 'debuted in',
        // Historical context about London runs
        'played in london', 'has played in london', 'played at london',
        'run in london', 'run at london',  // catches "2024 run in London" / "run at London's"
        'london premiere', 'west end premiere', 'off-west end premiere',
        'london debut', 'london run',
        // Co-production / import language
        'is presenting', 'co-production with', 'in association with',
        'imported by', 'imported from',
        // Following / after language (broader)
        'following a run', 'following its run', 'following a successful',
        'after its run', 'after a run',
        // Arrival language (BRO-2278 review: "comes to the Booth Theatre after
        // starting at the Donmar Warehouse" was rejected as a London review).
        'after starting at', 'after starting in', 'fresh from', 'arrives from',
        'arriving from', 'comes from',
      ];
      // Also check with regex for "after a [year/adjective] run" patterns
      const transferRegexes = [
        /after a\s+\w+\s+run\b/,       // "after a 2024 run", "after a successful run", "after a sold-out run"
        /after a\s+\w+-\w+\s+run\b/,   // "after a well-received run"
        /following a\s+\w+\s+run\b/,    // "following a limited run"
      ];
      const isTransferMention = transferPatterns.some(p => context.includes(p))
        || transferRegexes.some(r => r.test(context));

      if (isTransferMention) {
        // Review mentions the London venue as historical context — low severity
        issues.push({
          type: 'london_venue_transfer_mention',
          message: `London venue "${venue}" mentioned in transfer/origin context (safe)`,
          severity: 'low'
        });
      } else {
        // No transfer context — likely reviewing the London production
        issues.push({
          type: 'london_venue_in_us_show',
          message: `Found London venue "${venue}" in ${category} show review without transfer context`,
          severity: 'high'
        });
        confidence = 'high';
      }
    }
  }

  // 6. Wrong tour leg (BRO-2278): a West End / Off-West End show page getting
  // a review of another UK leg of the same tour. Only when the caller passes
  // the show's category AND declared venue; Broadway/off-Broadway are untouched.
  if (text && (category === 'west-end' || category === 'off-west-end') && showData && showData.venue) {
    const otherLeg = findOtherTourLegVenue(text, showData.venue);
    if (otherLeg) {
      issues.push({
        type: 'uk_tour_leg_venue_mismatch',
        message: `Review places the production at "${otherLeg.venue}", not this show's venue "${showData.venue}" (another tour leg)`,
        severity: 'high'
      });
      confidence = 'high';
    }
  }

  // Determine if we should reject
  const highSeverityIssues = issues.filter(i => i.severity === 'high');
  const shouldReject = highSeverityIssues.length > 0;

  return {
    isValid: issues.length === 0,
    issues,
    confidence,
    shouldReject,
    showId,
    expectedYear
  };
}

/**
 * Quick check for date mismatch (fast, no text analysis)
 * @returns {boolean} True if dates look OK
 */
function quickDateCheck(showId, url, publishDate, openingDate) {
  const yearMatch = showId.match(/-(\d{4})$/);
  if (!yearMatch) return true;

  const expectedYear = parseInt(yearMatch[1]);

  // NOTE: Do NOT check URL patterns for year. URL structure is unreliable.

  // Tight check: if we have both publishDate and openingDate, reject reviews
  // published more than 30 days before opening. Catches wrong-production SERP
  // results (e.g., 2019 review for a 2026 revival) that year-only check misses.
  if (publishDate && openingDate) {
    const pubDate = new Date(require('./date-utils').toDateMs(publishDate));
    const openDate = new Date(openingDate);
    if (!isNaN(pubDate.getTime()) && !isNaN(openDate.getTime())) {
      const daysBefore = (openDate - pubDate) / (1000 * 60 * 60 * 24);
      if (daysBefore > 30) return false;
    }
  }

  // Loose fallback: year-based check when openingDate not available
  if (publishDate) {
    const dateYearMatch = publishDate.match(/\b(20\d{2})\b/);
    if (dateYearMatch) {
      const dateYear = parseInt(dateYearMatch[1]);
      if (dateYear < expectedYear - 1) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Load shows.json and return show data for a show ID
 */
function getShowData(showId) {
  try {
    const showsPath = path.join(__dirname, '..', '..', 'data', 'shows.json');
    const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    const shows = showsData.shows || showsData;
    return shows.find(s => s.id === showId);
  } catch (e) {
    return null;
  }
}

module.exports = {
  verifyProduction,
  findOtherTourLegVenue,
  UK_TOURING_VENUES,
  quickDateCheck,
  getShowData,
  KNOWN_WRONG_INDICATORS,
  WEST_END_VENUES,
  UK_PUBLICATIONS
};
