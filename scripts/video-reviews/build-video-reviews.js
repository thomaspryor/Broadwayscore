#!/usr/bin/env node
/**
 * Build final video-reviews.json from scored transcripts.
 * Usage: node scripts/video-reviews/build-video-reviews.js
 */

const fs = require('fs');
const path = require('path');

const TRANSCRIPTS_DIR = path.join(__dirname, '../../data/video-reviews-transcripts');
const CREATORS_PATH = path.join(__dirname, '../../data/video-creators.json');
const OUTPUT_PATH = path.join(__dirname, '../../data/video-reviews.json');

function main() {
  const creators = JSON.parse(fs.readFileSync(CREATORS_PATH, 'utf8')).creators;
  const creatorMap = Object.fromEntries(creators.map(c => [c.id, c]));

  const output = {
    _meta: {
      description: 'Video critic reviews scored by LLM from transcripts',
      generatedAt: new Date().toISOString(),
      pipelineVersion: '1.0.0'
    }
  };

  const showDirs = fs.readdirSync(TRANSCRIPTS_DIR).filter(d =>
    d !== '.DS_Store' && fs.statSync(path.join(TRANSCRIPTS_DIR, d)).isDirectory());

  for (const showId of showDirs) {
    const showDir = path.join(TRANSCRIPTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    const reviews = [];

    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      if (data.score === undefined || data.scoreable === false) continue;
      const creator = creatorMap[data.creatorId];
      if (!creator) continue;

      reviews.push({
        creatorName: creator.name,
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
        publishedAt: data.publishedAt || null
      });
    }

    if (reviews.length > 0) {
      reviews.sort((a, b) => b.score - a.score);
      output[showId] = reviews;
      console.log(`${showId}: ${reviews.length} reviews — avg ${Math.round(reviews.reduce((s, r) => s + r.score, 0) / reviews.length)}`);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH}`);
}

main();
