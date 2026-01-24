#!/usr/bin/env node

/**
 * Fix data quality issues:
 * 1. Remove entries with score=0 (these are bugs)
 * 2. Remove duplicate reviews (same outlet+critic, keep best one)
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = 'data/review-texts';

// Track changes
const deleted = [];
const kept = [];

// Normalize for matching
function normalize(str) {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/^the\s+/i, '')
    .replace(/[^a-z0-9]/g, '');
}

// Get all shows
const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
  .filter(f => fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory());

for (const showId of shows) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  // Load all reviews
  const reviews = [];
  for (const file of files) {
    const filepath = path.join(showDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      reviews.push({ file, filepath, data });
    } catch (e) {
      console.log(`Error reading ${filepath}: ${e.message}`);
    }
  }

  // Step 1: Remove score=0 entries
  for (const r of reviews) {
    if (r.data.assignedScore === 0) {
      fs.unlinkSync(r.filepath);
      deleted.push({ file: r.filepath, reason: 'score=0' });
      r.deleted = true;
    }
  }

  // Step 2: Find and remove duplicates
  const byKey = {};
  for (const r of reviews) {
    if (r.deleted) continue;

    const key = normalize(r.data.outlet) + '|' + normalize(r.data.criticName);
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(r);
  }

  for (const key of Object.keys(byKey)) {
    const group = byKey[key];
    if (group.length <= 1) continue;

    // Sort by quality: prefer hasFullText, then higher score, then non-null score
    group.sort((a, b) => {
      // Prefer full text
      const aHasText = a.data.fullText && a.data.fullText.length > 100 ? 1 : 0;
      const bHasText = b.data.fullText && b.data.fullText.length > 100 ? 1 : 0;
      if (bHasText !== aHasText) return bHasText - aHasText;

      // Prefer non-null score
      const aHasScore = a.data.assignedScore !== null && a.data.assignedScore !== undefined ? 1 : 0;
      const bHasScore = b.data.assignedScore !== null && b.data.assignedScore !== undefined ? 1 : 0;
      if (bHasScore !== aHasScore) return bHasScore - aHasScore;

      // Prefer higher score (more positive = likely more accurate for positive reviews)
      // Actually, prefer the score closer to 70 (middle ground)
      const aScore = a.data.assignedScore || 50;
      const bScore = b.data.assignedScore || 50;
      return bScore - aScore; // Higher score first
    });

    // Keep first, delete rest
    kept.push({
      file: group[0].filepath,
      outlet: group[0].data.outlet,
      critic: group[0].data.criticName,
      score: group[0].data.assignedScore
    });

    for (let i = 1; i < group.length; i++) {
      fs.unlinkSync(group[i].filepath);
      deleted.push({
        file: group[i].filepath,
        reason: `duplicate of ${group[0].file}`,
        outlet: group[i].data.outlet,
        critic: group[i].data.criticName,
        score: group[i].data.assignedScore
      });
    }
  }
}

console.log('=== DELETED ===');
for (const d of deleted) {
  console.log(`  ${d.reason.padEnd(40)} ${d.file}`);
}

console.log('\n=== SUMMARY ===');
console.log(`Deleted: ${deleted.length} files`);
console.log(`  - score=0: ${deleted.filter(d => d.reason === 'score=0').length}`);
console.log(`  - duplicates: ${deleted.filter(d => d.reason !== 'score=0').length}`);
