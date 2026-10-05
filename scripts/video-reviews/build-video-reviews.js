#!/usr/bin/env node
/**
 * Build final video-reviews.json from scored transcripts.
 * Usage: node scripts/video-reviews/build-video-reviews.js
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('../lib/list-show-dirs');
const { filterPublishableReviews, isPaidPromotion, creatorLookup } = require('../lib/video-review-guards');

const TRANSCRIPTS_DIR = path.join(__dirname, '../../data/video-reviews-transcripts');
const CREATORS_PATH = path.join(__dirname, '../../data/video-creators.json');
const OUTPUT_PATH = path.join(__dirname, '../../data/video-reviews.json');
const SHOWS_PATH = path.join(__dirname, '../../data/shows.json');

function main() {
  const creators = JSON.parse(fs.readFileSync(CREATORS_PATH, 'utf8')).creators;
  const findCreator = creatorLookup(creators);


  const output = {
    _meta: {
      description: 'Video critic reviews scored by LLM from transcripts',
      generatedAt: new Date().toISOString(),
      pipelineVersion: '1.0.0'
    }
  };

  if (!fs.existsSync(SHOWS_PATH)) {
    console.error(`Missing ${SHOWS_PATH} (private core data); in CI run .github/actions/checkout-core-data first.`);
    process.exit(1);
  }
  const knownShowIds = new Set(JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows.map(s => s.id));

  const showDirs = listShowDirs(TRANSCRIPTS_DIR).filter(d => d !== 'raw' && d !== 'classified');
  const reviewsByShow = {};

  for (const showId of showDirs) {
    const showDir = path.join(TRANSCRIPTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    const reviews = [];

    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      if (data.score === undefined || data.scoreable === false) continue;
      // Skip transcripts flagged as wrong production (e.g. movie reviews ending up
      // on the stage show, casting-announcement videos, reply-to-comments videos).
      if (data.wrongProduction === true) continue;
      if (isPaidPromotion(data)) { console.log(`  skipped ${showId}/${file}: paid promotion`); continue; }
      const creator = findCreator(data.creatorId);
      if (!creator) continue;

      reviews.push({
        creatorName: creator.name,
        creatorId: creator.id, // profile slug; handle keeps the platform's casing (thumbnail paths use it)
        handle: data.creatorId,
        platform: data.platform,
        videoUrl: data.videoUrl,
        score: data.score,
        views: data.views,
        bucket: data.bucket,
        confidence: data.confidence,
        reasoning: data.reasoning,
        keyQuote: data.keyQuote,
        thumbnail: data.thumbnail || null,
        // yt-dlp's flat-playlist "NA" means unknown; consumers (site, iOS export pd) expect null
        publishedAt: (data.publishedAt && data.publishedAt !== 'NA') ? data.publishedAt : null
      });
    }

    if (reviews.length) reviewsByShow[showId] = reviews;
  }

  const { kept, dropped } = filterPublishableReviews(reviewsByShow, knownShowIds);
  for (const d of dropped) console.log(`  dropped ${d.showId} ${d.videoUrl}: ${d.reason}`);

  // Show any show with 1+ reviews. Single-review shows still display — the
  // VideoReviewsShelf header and profile pages show "N reviews" which is
  // honest about sample size. Filtering to 2+ hid ~86 legit reviews because
  // tylernabinger covers niche OB that other creators skip.
  for (const [showId, reviews] of Object.entries(kept)) {
    reviews.sort((a, b) => b.score - a.score);
    output[showId] = reviews;
    console.log(`${showId}: ${reviews.length} reviews — avg ${Math.round(reviews.reduce((s, r) => s + r.score, 0) / reviews.length)}`);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH}`);
}

main();
