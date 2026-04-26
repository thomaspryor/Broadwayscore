#!/usr/bin/env node
/**
 * Pre-2005 Wrong Production Audit
 *
 * Identifies reviews on pre-2005 Broadway shows that are likely about a different
 * production (usually a revival). Uses multiple detection signals:
 *
 * 1. Publish date proximity to a revival's opening
 * 2. Revival-specific cast/director mentions in review text
 * 3. Text signals: "revival", "new production", "returns to Broadway"
 * 4. Year references in text that match a revival, not the original
 *
 * Output: data/audit/pre2005-wrong-production.json
 *
 * Does NOT modify any review files — audit only. Use --apply to write
 * auditSuggested flags to review-text files.
 */

const fs = require('fs');
const path = require('path');
const { shouldSkipWrongProductionAudit } = require('./lib/review-guards');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'audit', 'pre2005-wrong-production.json');

const applyMode = process.argv.includes('--apply');

// Load shows
const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const shows = showsData.shows;

// Build Broadway shows indexed by ID
const showById = new Map(shows.map(s => [s.id, s]));

// Build title → production families (all markets)
const titleFamilies = new Map();
shows.forEach(s => {
  const baseTitle = s.title.toLowerCase().replace(/['']/g, "'").trim();
  if (!titleFamilies.has(baseTitle)) titleFamilies.set(baseTitle, []);
  titleFamilies.get(baseTitle).push(s);
});

// Get pre-2005 Broadway shows that have review-text directories
const pre2005Shows = shows.filter(s => {
  if (s.category) return false;
  if (!s.openingDate) return false;
  const year = new Date(s.openingDate).getFullYear();
  return year < 2005;
});

console.log(`Found ${pre2005Shows.length} pre-2005 Broadway shows`);

// Known cast/director data for major revivals (the most common wrong-production targets)
const REVIVAL_CAST_DIRECTORS = {
  // Cats
  'cats-2016': {
    year: 2016,
    signals: ['Andy Huntington Jones', 'Leona Lewis', 'Mamie Parris', 'Tyler Hanes', 'Ricky Ubeda', '2016', 'revival'],
    director: 'Andy Blankenbuehler'
  },
  // Phantom
  'the-phantom-of-the-opera-2024': {
    year: 2024,
    signals: ['2024'],
    director: null
  },
  // Evita
  'evita-2012': {
    year: 2012,
    signals: ['Ricky Martin', 'Elena Roger', 'Michael Cerveris', 'Marquis Theatre', '2012', 'revival'],
    director: 'Michael Grandage'
  },
  // Gypsy
  'gypsy-2008': {
    year: 2008,
    signals: ['Patti LuPone', 'Laura Benanti', 'Boyd Gaines', 'St. James', '2008'],
    director: 'Arthur Laurents'
  },
  'gypsy-2024': {
    year: 2024,
    signals: ['Audra McDonald', 'Camille A. Brown', 'Danny Burstein', 'Majestic Theatre', '2024', 'revival'],
    director: 'George C. Wolfe'
  },
  // My Fair Lady
  'my-fair-lady-2018': {
    year: 2018,
    signals: ['Lauren Ambrose', 'Harry Hadden-Paton', 'Norbert Leo Butz', 'Diana Rigg', 'Lincoln Center', '2018', 'revival'],
    director: 'Bartlett Sher'
  },
  // Jesus Christ Superstar
  'jesus-christ-superstar-2012': {
    year: 2012,
    signals: ['Des McAnuff', 'Paul Nolan', 'Josh Young', 'Chilina Kennedy', 'Stratford', '2012', 'revival', 'Arena Stage'],
    director: 'Des McAnuff'
  },
  // Chicago (1996 revival — reviews on chicago-1996 could be original 1975 or this revival)
  // The 1996 production IS the revival, so reviews should be on chicago-1996

  // Les Miserables
  'les-miserables-2014': {
    year: 2014,
    signals: ['Ramin Karimloo', 'Will Swenson', 'Caissie Levy', 'Imperial Theatre', '2014', 'new staging', 'new production', 'revival'],
    director: 'Laurence Connor'
  },
  // Sweeney Todd
  'sweeney-todd-2005': {
    year: 2005,
    signals: ['Patti LuPone', 'Michael Cerveris', 'John Doyle', '2005', 'revival'],
    director: 'John Doyle'
  },
  'sweeney-todd-2023': {
    year: 2023,
    signals: ['Josh Groban', 'Annaleigh Ashford', 'Lunt-Fontanne', '2023', 'revival'],
    director: 'Thomas Kail'
  },
  // Fiddler on the Roof
  'fiddler-on-the-roof-2015': {
    year: 2015,
    signals: ['Danny Burstein', 'Jessica Hecht', 'Broadway Theatre', '2015', 'revival'],
    director: 'Bartlett Sher'
  },
  // A Raisin in the Sun
  'a-raisin-in-the-sun-2014': {
    year: 2014,
    signals: ['Denzel Washington', 'LaTanya Richardson', 'Sophie Okonedo', '2014', 'revival'],
    director: 'Kenny Leon'
  },
  // Merrily We Roll Along
  'merrily-we-roll-along-2023': {
    year: 2023,
    signals: ['Jonathan Groff', 'Daniel Radcliffe', 'Lindsay Mendez', 'Hudson Theatre', '2023', 'revival'],
    director: 'Maria Friedman'
  },
  // Follies
  'follies-2001': {
    year: 2001,
    signals: ['Blythe Danner', 'Gregory Harrison', 'Judith Ivey', 'Belasco Theatre', '2001', 'revival'],
    director: 'Matthew Warchus'
  },
  'follies-2011': {
    year: 2011,
    signals: ['Bernadette Peters', 'Jan Maxwell', 'Danny Burstein', 'Marquis Theatre', '2011', 'Kennedy Center', 'revival'],
    director: 'Eric Schaeffer'
  },
  // The King and I
  'the-king-and-i-2015': {
    year: 2015,
    signals: ['Kelli O\'Hara', 'Ken Watanabe', 'Lincoln Center', 'Beaumont', '2015', 'revival'],
    director: 'Bartlett Sher'
  },
  // Into the Woods
  'into-the-woods-2022': {
    year: 2022,
    signals: ['Sara Bareilles', 'Brian d\'Arcy James', 'St. James Theatre', '2022', 'revival', 'Lear deBessonet'],
    director: 'Lear deBessonet'
  },
  // Once on This Island
  'once-on-this-island-2017': {
    year: 2017,
    signals: ['Hailey Kilgore', 'Lea Salonga', 'Circle in the Square', '2017', '2018', 'revival'],
    director: 'Michael Arden'
  },
  // Sunday in the Park with George
  'sunday-in-the-park-with-george-2017': {
    year: 2017,
    signals: ['Jake Gyllenhaal', 'Annaleigh Ashford', 'Hudson Theatre', '2017', 'revival'],
    director: 'Sarna Lapine'
  },
  // La Cage aux Folles
  'la-cage-aux-folles-2004': {
    year: 2004,
    signals: ['Gary Beach', 'Robert Goulet', 'Daniel Davis', 'Marquis Theatre', '2004', 'revival'],
    director: 'Jerry Zaks'
  },
  'la-cage-aux-folles-2010': {
    year: 2010,
    signals: ['Kelsey Grammer', 'Douglas Hodge', 'Longacre Theatre', '2010', 'revival'],
    director: 'Terry Johnson'
  },
};

// Generic text signals that suggest a review is about a revival
const REVIVAL_TEXT_SIGNALS = [
  'revival', 'revived', 'new production', 'returns to broadway', 'back on broadway',
  'new staging', 'restaged', 'reimagined', 'reinvented', 'fresh take',
  'new interpretation', 'transfer from', 'transferred from', 'this production',
  'current production', 'latest production', 'new revival',
];

// Modern references that wouldn't appear in pre-2005 original reviews
const MODERN_SIGNALS = [
  'instagram', 'tiktok', 'twitter', 'social media', 'streaming', 'netflix',
  'pandemic', 'covid', 'post-pandemic', 'masks', 'vaccination',
  'hamilton', // post-2015 cultural reference
];

function getReviewText(reviewData) {
  return [
    reviewData.fullText || '',
    reviewData.bwwExcerpt || '',
    reviewData.dtliExcerpt || '',
    reviewData.showScoreExcerpt || '',
    reviewData.pullQuote || '',
  ].join(' ');
}

function getPublishYear(reviewData) {
  if (!reviewData.publishDate) return null;
  const d = new Date(reviewData.publishDate);
  if (isNaN(d.getTime())) return null;
  return d.getFullYear();
}

function findYearsInText(text) {
  const matches = text.match(/\b(19[5-9]\d|20[0-2]\d)\b/g);
  return matches ? [...new Set(matches.map(Number))] : [];
}

// For a pre-2005 show, find all revivals in the database
function findRevivals(show) {
  const baseTitle = show.title.toLowerCase().replace(/['']/g, "'").trim();
  const family = titleFamilies.get(baseTitle) || [];
  return family
    .filter(s => s.id !== show.id && s.openingDate)
    .sort((a, b) => a.openingDate.localeCompare(b.openingDate));
}

function auditShow(show) {
  const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
  if (!fs.existsSync(showDir)) return [];

  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) return [];

  const showYear = new Date(show.openingDate).getFullYear();
  const revivals = findRevivals(show);
  const results = [];

  for (const file of files) {
    const filePath = path.join(showDir, file);
    let reviewData;
    try {
      reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch { continue; }

    // Skip already flagged
    if (reviewData.wrongProduction || reviewData.wrongShow) continue;

    const text = getReviewText(reviewData);
    if (!text || text.trim().length < 20) continue;

    const textLower = text.toLowerCase();
    const pubYear = getPublishYear(reviewData);
    const yearsInText = findYearsInText(text);
    const signals = [];
    let confidence = 'low';
    let suggestedShowId = null;

    // Check 1: Publish date matches a revival, not the original
    if (pubYear) {
      for (const revival of revivals) {
        const revivalYear = new Date(revival.openingDate).getFullYear();
        if (Math.abs(pubYear - revivalYear) <= 1) {
          signals.push(`publishDate ${pubYear} matches revival ${revival.id} (opened ${revivalYear})`);
          suggestedShowId = revival.id;
          confidence = 'high';
        }
      }
      // Published way after the original but no matching revival — 10+ years is suspicious
      if (pubYear > showYear + 10 && !suggestedShowId) {
        signals.push(`publishDate ${pubYear} is ${pubYear - showYear} years after original opening ${showYear}`);
        confidence = confidence === 'low' ? 'medium' : confidence;
      }
    }

    // Check 2: Known revival cast/director mentions — ONLY check revivals of the SAME show
    const relatedRevivalIds = new Set(revivals.map(r => r.id));
    for (const [revivalId, revivalData] of Object.entries(REVIVAL_CAST_DIRECTORS)) {
      if (!relatedRevivalIds.has(revivalId)) continue; // Only check revivals of this title
      // Only match on specific names/venues, not generic terms like "revival" or year strings
      const specificSignals = revivalData.signals.filter(s => s.length > 4 && !/^\d{4}$/.test(s) && s !== 'revival');
      const matchedSpecific = specificSignals.filter(s => textLower.includes(s.toLowerCase()));
      const directorMatch = revivalData.director && textLower.includes(revivalData.director.toLowerCase());
      if (matchedSpecific.length >= 2 || (matchedSpecific.length >= 1 && directorMatch)) {
        signals.push(`revival cast/director match for ${revivalId}: ${matchedSpecific.join(', ')}${directorMatch ? ', director: ' + revivalData.director : ''}`);
        suggestedShowId = suggestedShowId || revivalId;
        confidence = 'high';
      } else if (directorMatch) {
        signals.push(`revival director match for ${revivalId}: ${revivalData.director}`);
        suggestedShowId = suggestedShowId || revivalId;
        if (confidence === 'low') confidence = 'medium';
      }
    }

    // Check 3: Generic revival text signals — require 2+ matches to flag (one word alone is too noisy)
    const revivalTextMatches = REVIVAL_TEXT_SIGNALS.filter(s => textLower.includes(s));
    if (revivalTextMatches.length >= 2) {
      signals.push(`revival text signals: ${revivalTextMatches.join(', ')}`);
      if (confidence === 'low') confidence = 'medium';
    }

    // Check 4: Year references that match a revival
    for (const yearInText of yearsInText) {
      if (yearInText === showYear) continue; // Expected
      for (const revival of revivals) {
        const revivalYear = new Date(revival.openingDate).getFullYear();
        if (Math.abs(yearInText - revivalYear) <= 1) {
          signals.push(`year ${yearInText} in text matches revival ${revival.id}`);
          suggestedShowId = suggestedShowId || revival.id;
          if (confidence === 'low') confidence = 'medium';
        }
      }
    }

    // Check 5: Modern references in pre-2005 reviews
    const modernMatches = MODERN_SIGNALS.filter(s => textLower.includes(s));
    if (modernMatches.length > 0) {
      signals.push(`modern references: ${modernMatches.join(', ')}`);
      if (confidence === 'low') confidence = 'medium';
    }

    // Check 6: No publish date + multiple revival text signals = suspicious
    if (!pubYear && revivalTextMatches.length >= 2 && revivals.length > 0) {
      signals.push('no publishDate + revival signals + revivals exist');
      if (confidence === 'low') confidence = 'medium';
    }

    if (signals.length > 0) {
      results.push({
        showId: show.id,
        showTitle: show.title,
        showYear,
        file,
        outlet: reviewData.outlet || reviewData.outletId || file.replace('.json', ''),
        criticName: reviewData.criticName || null,
        publishDate: reviewData.publishDate || null,
        confidence,
        suggestedShowId,
        signals,
        textSnippet: text.slice(0, 200),
      });
    }
  }

  return results;
}

// Run the audit
console.log('Auditing pre-2005 shows...\n');

const allResults = [];
let showsWithReviews = 0;
let showsAudited = 0;

for (const show of pre2005Shows) {
  const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
  if (fs.existsSync(showDir)) {
    showsWithReviews++;
    const results = auditShow(show);
    if (results.length > 0) {
      showsAudited++;
      allResults.push(...results);
    }
  }
}

// Summarize
const highConf = allResults.filter(r => r.confidence === 'high');
const medConf = allResults.filter(r => r.confidence === 'medium');
const lowConf = allResults.filter(r => r.confidence === 'low');
const reassignable = allResults.filter(r => r.suggestedShowId && showById.has(r.suggestedShowId));

console.log('=== AUDIT SUMMARY ===');
console.log(`Pre-2005 shows with review-texts: ${showsWithReviews}`);
console.log(`Shows with flagged reviews: ${showsAudited}`);
console.log(`Total flagged reviews: ${allResults.length}`);
console.log(`  High confidence: ${highConf.length}`);
console.log(`  Medium confidence: ${medConf.length}`);
console.log(`  Low confidence: ${lowConf.length}`);
console.log(`  Reassignable (target show exists): ${reassignable.length}`);
console.log('');

// Show high-confidence results grouped by show
const byShow = {};
highConf.forEach(r => {
  if (!byShow[r.showId]) byShow[r.showId] = [];
  byShow[r.showId].push(r);
});

console.log('=== HIGH CONFIDENCE FLAGS ===');
for (const [showId, results] of Object.entries(byShow)) {
  console.log(`\n${showId} (${results[0].showTitle}, ${results[0].showYear}):`);
  results.forEach(r => {
    console.log(`  ${r.file} → ${r.suggestedShowId || '?'} | ${r.signals[0]}`);
  });
}

// Write output
const output = {
  _meta: {
    generatedAt: new Date().toISOString(),
    description: 'Pre-2005 wrong-production audit results',
    totalFlagged: allResults.length,
    highConfidence: highConf.length,
    mediumConfidence: medConf.length,
    lowConfidence: lowConf.length,
    reassignable: reassignable.length,
  },
  results: allResults,
};

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
console.log(`\nWrote audit results to ${OUTPUT_PATH}`);

// Apply mode: write auditSuggested to high-confidence review files
if (applyMode) {
  console.log('\n=== APPLYING FLAGS (high confidence only) ===');
  let applied = 0;
  let moved = 0;

  for (const result of highConf) {
    const filePath = path.join(REVIEW_TEXTS_DIR, result.showId, result.file);
    if (!fs.existsSync(filePath)) continue;

    const reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Honor manual clears — don't re-flag a human-verified review.
    if (shouldSkipWrongProductionAudit(reviewData)) continue;

    if (result.suggestedShowId && showById.has(result.suggestedShowId)) {
      // Move to correct show directory
      const targetDir = path.join(REVIEW_TEXTS_DIR, result.suggestedShowId);
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, result.file);

      // Update showId in the review data
      reviewData.showId = result.suggestedShowId;
      reviewData.movedFrom = result.showId;
      reviewData.movedReason = 'pre2005-audit: ' + result.signals[0];

      // Check if target already has this file — if so, flag source as wrongProduction
      if (fs.existsSync(targetPath)) {
        reviewData.wrongProduction = true;
        reviewData.auditSuggested = 'wrongProduction';
        reviewData.auditReason = 'pre2005-audit: duplicate exists at ' + result.suggestedShowId;
        reviewData.auditConfidence = result.confidence;
        reviewData.auditDate = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(filePath, JSON.stringify(reviewData, null, 2));
        applied++;
        console.log(`  FLAGGED ${result.showId}/${result.file} (dup at ${result.suggestedShowId})`);
        continue;
      }

      fs.writeFileSync(targetPath, JSON.stringify(reviewData, null, 2));
      fs.unlinkSync(filePath);
      moved++;
      console.log(`  MOVED ${result.showId}/${result.file} → ${result.suggestedShowId}/`);
    } else {
      // Flag as wrongProduction with audit trail
      reviewData.auditSuggested = 'wrongProduction';
      reviewData.auditReason = result.signals[0];
      reviewData.auditConfidence = result.confidence;
      reviewData.auditDate = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(filePath, JSON.stringify(reviewData, null, 2));
      applied++;
      console.log(`  FLAGGED ${result.showId}/${result.file}`);
    }
  }

  console.log(`\nApplied: ${applied} flagged, ${moved} moved`);
}
