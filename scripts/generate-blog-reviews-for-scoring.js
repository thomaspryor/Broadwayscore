#!/usr/bin/env node
/**
 * Generate blog-reviews-for-scoring.json from content/reviews/*.md
 *
 * Only includes reviews that have a showSlug matching a show in shows.json.
 * Output format matches RawReview interface so data-core.ts can inject
 * blog reviews as Tier 3 critic reviews into the scoring engine.
 *
 * Run as part of prebuild.
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const REVIEWS_DIR = path.join(__dirname, '../content/reviews');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const OUTPUT_PATH = path.join(__dirname, '../data/blog-reviews-for-scoring.json');

function main() {
  // Load shows for slug→id mapping
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const slugToId = new Map();
  for (const show of showsData.shows) {
    slugToId.set(show.slug, show.id);
  }

  if (!fs.existsSync(REVIEWS_DIR)) {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ reviews: [] }, null, 2));
    console.log('[blog-scoring] No reviews directory, wrote empty file');
    return;
  }

  const files = fs.readdirSync(REVIEWS_DIR).filter(
    f => f.endsWith('.md') && !f.startsWith('_')
  );

  const reviews = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(REVIEWS_DIR, file), 'utf8');
      const { data } = matter(raw);

      // Must have showSlug to be injected into scoring
      if (!data.showSlug) continue;

      const showId = slugToId.get(data.showSlug);
      if (!showId) {
        console.warn(`[blog-scoring] Skipping ${file}: showSlug "${data.showSlug}" not found in shows.json`);
        continue;
      }

      const score = Number(data.score);
      if (isNaN(score) || score < 0 || score > 100) {
        console.warn(`[blog-scoring] Skipping ${file}: invalid score ${data.score}`);
        continue;
      }

      reviews.push({
        showId,
        outlet: 'Broadway Scorecard',
        outletId: 'broadway-scorecard',
        criticName: 'Tom Pryor',
        url: `https://broadwayscorecard.com/reviews/${file.replace(/\.md$/, '')}`,
        publishDate: data.publishDate || data.dateAttended || '',
        assignedScore: score,
      });
    } catch (err) {
      console.warn(`[blog-scoring] Skipping ${file}: ${err.message}`);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ reviews }, null, 2));
  console.log(`[blog-scoring] Generated ${reviews.length} reviews for scoring`);
}

main();
