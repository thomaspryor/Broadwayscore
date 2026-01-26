#!/usr/bin/env node
/**
 * Extract embedded grades/ratings from review text
 * Looks for patterns like:
 * - "Grade: A-", "Grade: B+"
 * - "Rating: 4/5", "Rating: 3.5 out of 5"
 * - Star ratings in text
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

function extractGradeFromText(text) {
  if (!text || text.length < 20) return null;

  const lower = text.toLowerCase();

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
  stillUnscored: 0
};

const newlyScored = [];

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

      // Skip if already has valid score
      if (data.scoreStatus !== 'TO_BE_CALCULATED') {
        stats.alreadyScored++;
        return;
      }

      // Get all possible text sources
      const textsToCheck = [
        data.bwwExcerpt,
        data.dtliExcerpt,
        data.showScoreExcerpt,
        data.fullText
      ].filter(Boolean);

      for (const text of textsToCheck) {
        const result = extractGradeFromText(text);
        if (result) {
          data.assignedScore = result.score;
          data.scoreSource = result.method;
          data.scoreConfidence = result.confidence || 'medium';
          if (result.grade) data.extractedGrade = result.grade;
          if (result.rating) data.extractedRating = result.rating;
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
            detail: result.grade || result.rating || result.stars || result.phrase
          });
          console.log(`✓ ${showId}/${file}: ${result.score} (${result.method}: ${result.grade || result.rating || result.stars || result.phrase || ''})`);
          return;
        }
      }

      stats.stillUnscored++;

    } catch(e) {
      console.error(`Error: ${file}: ${e.message}`);
    }
  });
});

console.log('\n=== SUMMARY ===');
console.log(`Total files: ${stats.total}`);
console.log(`Already scored: ${stats.alreadyScored}`);
console.log(`Newly scored: ${stats.newlyScored}`);
console.log(`Still unscored: ${stats.stillUnscored}`);

if (newlyScored.length > 0) {
  console.log('\n=== NEWLY SCORED ===');
  newlyScored.forEach(r => {
    console.log(`  ${r.showId}: ${r.outlet} → ${r.score} (${r.detail})`);
  });
}

console.log('\n=== NEXT STEP ===');
console.log('Run: node scripts/rebuild-all-reviews.js');
