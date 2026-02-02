#!/usr/bin/env node
/**
 * Extract embedded grades/ratings and designations from review text
 *
 * SCORES: Looks for patterns like:
 * - "Grade: A-", "Grade: B+"
 * - "Rating: 4/5", "Rating: 3.5 out of 5"
 * - Star ratings in text (including outlet-specific formats)
 * - Outlet-specific score formats
 *
 * DESIGNATIONS: Extracts for score bumps:
 * - NYT "Critic's Pick" (+3) — HTML structure only, not text matching
 * - Time Out "Critics' Choice" (+2)
 * NOTE: "Recommended" was removed — no outlet uses it as a real designation
 *
 * Score bumps are applied during final scoring calculation (see src/config/scoring.ts)
 */

const fs = require('fs');
const path = require('path');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');

// Letter grade conversions (same as other scripts)
const LETTER_GRADES = {
  'a+': 98, 'a': 95, 'a-': 92,
  'b+': 88, 'b': 85, 'b-': 82,
  'c+': 78, 'c': 75, 'c-': 72,
  'd+': 68, 'd': 65, 'd-': 62,
  'f': 40
};

// Designation patterns for score bumps
const DESIGNATION_PATTERNS = {
  'Critics_Pick': [
    /critic['']s?\s*pick/i,
    /nyt\s*critic['']s?\s*pick/i,
    /new\s*york\s*times\s*critic['']s?\s*pick/i,
  ],
  'Critics_Choice': [
    /critic['']s?\s*choice/i,
    /time\s*out\s*critic['']s?\s*choice/i,
  ],
  // "Recommended" removed — no outlet uses it as a real designation
  'Editors_Choice': [
    /editor['']s?\s*choice/i,
    /editor['']s?\s*pick/i,
  ],
  'Must_See': [
    /\bmust[\s-]see\b/i,
    /\bmust\s*see\s*show\b/i,
    /\bunmissable\b/i,
    /\bdon['']t\s*miss\b/i,
  ],
  'Top_Pick': [
    /\btop\s*pick\b/i,
    /\bhighly\s*recommended\b/i,
  ],
};

// Outlet-specific score patterns
const OUTLET_SCORE_PATTERNS = {
  // Entertainment Weekly uses letter grades
  'entertainment-weekly': {
    patterns: [
      /EW\s*grade:\s*([A-Fa-f][+-]?)/i,
      /grade:\s*([A-Fa-f][+-]?)/i,
    ],
    type: 'letter'
  },
  // Time Out uses star ratings (1-5)
  'time-out': {
    patterns: [
      /(\d+)\s*(?:\/\s*5\s*)?stars?/i,
      /★{1,5}/,
    ],
    type: 'stars',
    max: 5
  },
  // Rolling Stone uses star ratings (1-5)
  'rolling-stone': {
    patterns: [
      /(\d+(?:\.\d)?)\s*(?:out\s*of\s*5|\/\s*5)/i,
      /★{1,5}/,
    ],
    type: 'stars',
    max: 5
  },
  // The Guardian uses star ratings (1-5)
  'guardian': {
    patterns: [
      /(\d+)\s*(?:\/\s*5\s*)?stars?/i,
      /★{1,5}/,
    ],
    type: 'stars',
    max: 5
  },
};

/**
 * Extract designation (Critics' Pick, etc.) from review text
 */
function extractDesignation(text, outletId) {
  if (!text || text.length < 20) return null;

  const lower = text.toLowerCase();

  // Check each designation type
  for (const [designation, patterns] of Object.entries(DESIGNATION_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return designation;
      }
    }
  }

  // Outlet-specific designation detection
  if (outletId) {
    const outletLower = outletId.toLowerCase();

    // NYT: Only check HTML structure, not review text (text matching causes false positives)
    // Real extraction should use score-extractors.js which checks JSON-LD, CSS classes, badge markup
    // This legacy function should not be used for NYT Critics' Pick detection

    // Time Out: Check for Critics' Choice
    if (outletLower.includes('time-out') || outletLower.includes('timeout')) {
      if (/critic['']?s?\s*choice/i.test(text)) {
        return 'Critics_Choice';
      }
    }
  }

  return null;
}

/**
 * Extract outlet-specific scores
 */
function extractOutletSpecificScore(text, outletId) {
  if (!text || !outletId) return null;

  const outletLower = outletId.toLowerCase();
  for (const [outlet, config] of Object.entries(OUTLET_SCORE_PATTERNS)) {
    if (outletLower.includes(outlet.replace('-', ''))) {
      for (const pattern of config.patterns) {
        const match = text.match(pattern);
        if (match) {
          if (config.type === 'letter') {
            const grade = match[1].toLowerCase();
            if (LETTER_GRADES[grade]) {
              return {
                score: LETTER_GRADES[grade],
                method: `${outlet}-letter-grade`,
                originalRating: match[1]
              };
            }
          } else if (config.type === 'stars') {
            // Handle unicode stars
            if (match[0].includes('★')) {
              const stars = (match[0].match(/★/g) || []).length;
              const score = Math.round((stars / config.max) * 100);
              return {
                score,
                method: `${outlet}-stars`,
                originalRating: `${stars}/${config.max} stars`
              };
            }
            // Handle numeric stars
            const stars = parseFloat(match[1]);
            if (stars <= config.max) {
              const score = Math.round((stars / config.max) * 100);
              return {
                score,
                method: `${outlet}-stars`,
                originalRating: `${stars}/${config.max} stars`
              };
            }
          }
        }
      }
    }
  }

  return null;
}

function extractGradeFromText(text, outletId = null) {
  if (!text || text.length < 20) return null;

  const lower = text.toLowerCase();

  // First try outlet-specific patterns
  const outletScore = extractOutletSpecificScore(text, outletId);
  if (outletScore) return outletScore;

  // Pattern 1: "Grade: X" or "grade: X"
  const gradeMatch = text.match(/grade:\s*([A-Fa-f][+-]?)\b/i);
  if (gradeMatch) {
    const grade = gradeMatch[1].toLowerCase();
    if (LETTER_GRADES[grade]) {
      return { score: LETTER_GRADES[grade], method: 'extracted-grade', grade: gradeMatch[1] };
    }
  }

  // Pattern 2: "Rating: X/5" or "X out of 5"
  const ratingMatch = text.match(/(?:rating:?\s*)?(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+)/i);
  if (ratingMatch) {
    const rating = parseFloat(ratingMatch[1]);
    const max = parseFloat(ratingMatch[2]);
    if (max > 0 && rating <= max) {
      const normalized = Math.round((rating / max) * 100);
      return { score: normalized, method: 'extracted-rating', rating: `${rating}/${max}` };
    }
  }

  // Pattern 3: Star patterns like "★★★★" or "4 stars"
  const starMatch = text.match(/(\d+(?:\.\d+)?)\s*stars?\b/i);
  if (starMatch) {
    const stars = parseFloat(starMatch[1]);
    // Assume 5-star scale unless otherwise indicated
    if (stars <= 5) {
      const normalized = Math.round((stars / 5) * 100);
      return { score: normalized, method: 'extracted-stars', stars: stars };
    }
  }

  // Pattern 4: Unicode stars followed by rating
  const unicodeStars = text.match(/[★☆]{2,5}/);
  if (unicodeStars) {
    const filled = (unicodeStars[0].match(/★/g) || []).length;
    const total = unicodeStars[0].length;
    if (total >= 2) {
      const normalized = Math.round((filled / total) * 100);
      return { score: normalized, method: 'extracted-unicode-stars', stars: `${filled}/${total}` };
    }
  }

  // Pattern 5: "thumbs up" / "thumbs down" in text
  if (lower.includes('thumbs up') || lower.includes('recommended')) {
    return { score: 75, method: 'extracted-thumbs-up', confidence: 'low' };
  }
  if (lower.includes('thumbs down') || lower.includes('not recommended')) {
    return { score: 45, method: 'extracted-thumbs-down', confidence: 'low' };
  }

  // Pattern 6: Strong sentiment phrases we might have missed
  const strongPositives = ['must-see', 'must see', 'don\'t miss', 'unmissable',
    'standing ovation', 'critical raves', 'raves', 'rave reviews'];
  const strongNegatives = ['avoid', 'skip it', 'skip this', 'don\'t bother',
    'waste of time', 'waste of money'];

  for (const phrase of strongPositives) {
    if (lower.includes(phrase)) {
      return { score: 85, method: 'extracted-strong-positive', phrase };
    }
  }

  for (const phrase of strongNegatives) {
    if (lower.includes(phrase)) {
      return { score: 35, method: 'extracted-strong-negative', phrase };
    }
  }

  return null;
}

// Stats
const stats = {
  total: 0,
  alreadyScored: 0,
  newlyScored: 0,
  stillUnscored: 0,
  designationsFound: 0
};

const newlyScored = [];
const designationsExtracted = [];

// Process all shows
const showDirs = fs.readdirSync(reviewTextsDir).filter(f =>
  fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
);

console.log('=== EXTRACTING EMBEDDED GRADES/RATINGS ===\n');

showDirs.forEach(showId => {
  const showDir = path.join(reviewTextsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  files.forEach(file => {
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      stats.total++;

      let modified = false;

      // Get all possible text sources
      const textsToCheck = [
        data.bwwExcerpt,
        data.dtliExcerpt,
        data.showScoreExcerpt,
        data.fullText
      ].filter(Boolean);

      // Extract designation (always, even if already scored)
      if (!data.designation) {
        for (const text of textsToCheck) {
          const designation = extractDesignation(text, data.outletId);
          if (designation) {
            data.designation = designation;
            modified = true;
            stats.designationsFound++;
            designationsExtracted.push({
              showId,
              file,
              outlet: data.outlet,
              designation
            });
            console.log(`✓ ${showId}/${file}: designation=${designation}`);
            break;
          }
        }
      }

      // Skip score extraction if already has valid score
      if (data.scoreStatus !== 'TO_BE_CALCULATED' && data.assignedScore) {
        stats.alreadyScored++;
        if (modified) {
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }
        return;
      }

      for (const text of textsToCheck) {
        const result = extractGradeFromText(text, data.outletId);
        if (result) {
          data.assignedScore = result.score;
          data.scoreSource = result.method;
          data.scoreConfidence = result.confidence || 'medium';
          if (result.grade) data.extractedGrade = result.grade;
          if (result.rating) data.extractedRating = result.rating;
          if (result.originalRating) data.originalRating = result.originalRating;
          if (result.stars) data.extractedStars = result.stars;
          if (result.phrase) data.extractedPhrase = result.phrase;
          delete data.scoreStatus;
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          stats.newlyScored++;
          newlyScored.push({
            showId,
            file,
            outlet: data.outlet,
            score: result.score,
            method: result.method,
            detail: result.grade || result.rating || result.stars || result.phrase || result.originalRating
          });
          console.log(`✓ ${showId}/${file}: ${result.score} (${result.method}: ${result.grade || result.rating || result.stars || result.phrase || result.originalRating || ''})`);
          return;
        }
      }

      stats.stillUnscored++;

      // Save if designation was extracted even without score
      if (modified) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      }

    } catch(e) {
      console.error(`Error: ${file}: ${e.message}`);
    }
  });
});

console.log('\n=== SUMMARY ===');
console.log(`Total files: ${stats.total}`);
console.log(`Already scored: ${stats.alreadyScored}`);
console.log(`Newly scored: ${stats.newlyScored}`);
console.log(`Designations found: ${stats.designationsFound}`);
console.log(`Still unscored: ${stats.stillUnscored}`);

if (newlyScored.length > 0) {
  console.log('\n=== NEWLY SCORED ===');
  newlyScored.forEach(r => {
    console.log(`  ${r.showId}: ${r.outlet} → ${r.score} (${r.detail})`);
  });
}

if (designationsExtracted.length > 0) {
  console.log('\n=== DESIGNATIONS EXTRACTED ===');
  const byDesignation = {};
  designationsExtracted.forEach(d => {
    if (!byDesignation[d.designation]) byDesignation[d.designation] = [];
    byDesignation[d.designation].push(d);
  });
  for (const [designation, reviews] of Object.entries(byDesignation)) {
    console.log(`\n  ${designation} (${reviews.length}):`);
    reviews.slice(0, 5).forEach(r => {
      console.log(`    - ${r.showId}: ${r.outlet}`);
    });
    if (reviews.length > 5) {
      console.log(`    ... and ${reviews.length - 5} more`);
    }
  }
}

console.log('\n=== NEXT STEP ===');
console.log('Run: node scripts/rebuild-all-reviews.js');
