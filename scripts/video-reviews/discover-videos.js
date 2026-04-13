#!/usr/bin/env node
/**
 * Video Review Discovery Script
 *
 * Scans registered video creators' feeds to find review-candidate videos.
 * Analogous to gather-reviews.js for text reviews — this is step 1 of the
 * video review pipeline.
 *
 * Pipeline: discover-videos → collect-transcripts → classify-reviews → score-video-reviews → build-video-reviews
 *
 * Process:
 * 1. Read creator registry (data/video-creators.json)
 * 2. For each creator, fetch their video feed via yt-dlp
 * 3. Filter to review-candidate videos (title heuristics)
 * 4. Output discovery results to data/video-reviews-discovery/
 *
 * Usage:
 *   node scripts/video-reviews/discover-videos.js                    # All creators
 *   node scripts/video-reviews/discover-videos.js --creator=broadwayben  # Single creator
 *   node scripts/video-reviews/discover-videos.js --limit=200        # Max videos per creator (default 300)
 *   node scripts/video-reviews/discover-videos.js --refresh          # Re-scan even if recent data exists
 *
 * Output: data/video-reviews-discovery/{handle}.json (structured, not raw text)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CREATORS_PATH = path.join(__dirname, '../../data/video-creators.json');
const DISCOVERY_DIR = path.join(__dirname, '../../data/video-reviews-discovery');

// Title patterns that suggest review content
const REVIEW_SIGNALS = /review|★|thoughts on|i saw|we saw|i went|we went|my take|first preview|rated|ranked|#theatrereview|#broadwayreview|#theatrereview/i;
// Title patterns that suggest non-review content (tea, casting news)
const NON_REVIEW_SIGNALS = /^(BREAKING|EXCLUSIVE|URGENT|WILD|UPSETTING).*tea|casting rumor|new cast announce|replacement announce/i;

function scanCreator(creator, limit) {
  const handle = creator.platforms.tiktok?.handle || creator.platforms.youtube?.channelHandle;
  const platform = creator.primaryPlatform;

  let url;
  if (platform === 'youtube') {
    url = `https://www.youtube.com/@${handle}/videos`;
  } else {
    url = `https://www.tiktok.com/@${handle}`;
  }

  console.log(`  Fetching up to ${limit} videos from ${url}...`);

  try {
    const cmd = `yt-dlp --flat-playlist --print "%(id)s\t%(title)s\t%(upload_date)s\t%(duration_string)s\t%(view_count)s" "${url}" --playlist-items 1-${limit} --sleep-interval 1 2>&1`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 300000 });

    const videos = output.split('\n')
      .filter(l => !l.match(/WARNING|ERROR|Downloading|Extracting/) && l.includes('\t'))
      .map(line => {
        const [id, title, date, duration, views] = line.split('\t');
        return { id: id?.trim(), title: title?.trim(), date: date?.trim(), duration: duration?.trim(), views: views?.trim() };
      })
      .filter(v => v.id && v.title);

    // Classify each video
    const classified = videos.map(v => {
      const isReviewCandidate = REVIEW_SIGNALS.test(v.title);
      const isNonReview = NON_REVIEW_SIGNALS.test(v.title);
      return {
        ...v,
        isReviewCandidate: isReviewCandidate && !isNonReview,
        classification: isReviewCandidate && !isNonReview ? 'review-candidate' : isNonReview ? 'non-review' : 'unclassified'
      };
    });

    return {
      handle, platform, scannedAt: new Date().toISOString(),
      totalVideos: classified.length,
      reviewCandidates: classified.filter(v => v.isReviewCandidate).length,
      videos: classified
    };
  } catch (err) {
    console.error(`  Error scanning ${handle}:`, err.message?.substring(0, 200));
    return null;
  }
}

function main() {
  const creatorFilter = process.argv.find(a => a.startsWith('--creator='))?.split('=')[1];
  const limit = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '300');
  const refresh = process.argv.includes('--refresh');

  if (!fs.existsSync(DISCOVERY_DIR)) fs.mkdirSync(DISCOVERY_DIR, { recursive: true });

  const creators = JSON.parse(fs.readFileSync(CREATORS_PATH, 'utf8')).creators;

  for (const creator of creators) {
    if (creatorFilter && creator.id !== creatorFilter) continue;

    const outFile = path.join(DISCOVERY_DIR, `${creator.id}.json`);

    // Skip if recent data exists (< 24h) unless --refresh
    if (!refresh && fs.existsSync(outFile)) {
      const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const age = Date.now() - new Date(existing.scannedAt).getTime();
      if (age < 24 * 60 * 60 * 1000) {
        console.log(`\n${creator.name} (@${creator.id}): skipped (scanned ${Math.round(age / 3600000)}h ago)`);
        continue;
      }
    }

    console.log(`\n=== ${creator.name} (@${creator.id}) ===`);
    const result = scanCreator(creator, limit);

    if (result) {
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
      console.log(`  ${result.totalVideos} total, ${result.reviewCandidates} review candidates`);
    }

    // Rate limit between creators
    if (creators.indexOf(creator) < creators.length - 1) {
      console.log('  (waiting 5s between creators...)');
      execSync('sleep 5');
    }
  }

  // Summary
  console.log('\n=== Discovery Summary ===');
  const files = fs.readdirSync(DISCOVERY_DIR).filter(f => f.endsWith('.json'));
  let totalCandidates = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DISCOVERY_DIR, file), 'utf8'));
    const candidates = data.reviewCandidates || data.videos?.filter(v => v.isReviewCandidate)?.length || 0;
    totalCandidates += candidates;
    console.log(`  ${data.handle}: ${data.totalVideos} total, ${candidates} review candidates`);
  }
  console.log(`\nTotal review candidates: ${totalCandidates}`);
}

main();
