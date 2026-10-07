#!/usr/bin/env node
/**
 * Video Transcript Collection Script
 *
 * Extracts transcripts from review-candidate videos using yt-dlp.
 * Analogous to collect-review-texts.js for text reviews — step 2 of the pipeline.
 *
 * Pipeline: discover-videos → collect-transcripts → classify-reviews → score-video-reviews → build-video-reviews
 *
 * Process:
 * 1. Read discovery data (output of discover-videos.js)
 * 2. For each review-candidate video, extract transcript via yt-dlp
 *    - YouTube: auto-captions (--write-auto-sub --sub-lang en)
 *    - TikTok: eng-US subtitles (--write-subs --sub-lang eng-US)
 * 3. Save raw transcripts to data/video-reviews-transcripts/raw/{videoId}.json
 *
 * Usage:
 *   node scripts/video-reviews/collect-transcripts.js                    # All creators
 *   node scripts/video-reviews/collect-transcripts.js --creator=broadwayben
 *   node scripts/video-reviews/collect-transcripts.js --refresh          # Re-extract even if exists
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { detectTranscriptOutages, isVideoSpecificError } = require('../lib/video-pipeline-health');
const { fetchYouTubeTranscript, backfillPublishedDates } = require('../lib/youtube-captions');

// YouTube bot-walls yt-dlp on GitHub runner IPs (BRO-4343). When a paid
// provider is configured, fall back to Scrapingdog's YouTube transcripts API
// (BRO-4665), then the watch page + caption track through fetchPage().
const YOUTUBE_FETCHPAGE_FALLBACK = !!(process.env.SCRAPINGDOG_API_KEY || process.env.BRIGHTDATA_TOKEN || process.env.SCRAPINGBEE_API_KEY);

async function youtubeFallback(videoId, needDate) {
  try {
    const r = await fetchYouTubeTranscript(videoId, {}, { needDate });
    return { transcript: r.transcript || null, publishedAt: r.publishedAt, error: null }; // '' = no captions
  } catch (err) {
    const msg = String(err.message || err);
    return { transcript: null, publishedAt: null, error: (msg.startsWith('ERROR:') ? msg : `ERROR: [youtube-fetchpage] ${videoId}: ${msg}`).substring(0, 300) };
  }
}

// Exit code for "a whole platform's extractor is broken" (BRO-4323): the
// workflow keeps publishing what the healthy platform produced, then fails
// the job at the end. A crash still exits 1.
const OUTAGE_EXIT_CODE = 3;

const DISCOVERY_DIR = path.join(__dirname, '../../data/video-reviews-discovery');
const RAW_TRANSCRIPTS_DIR = path.join(__dirname, '../../data/video-reviews-transcripts/raw');

function parseVTT(vttText) {
  const lines = vttText.split('\n')
    .filter(l => !l.match(/^(WEBVTT|Kind:|Language:|NOTE|$|\d{2}:\d{2})/))
    .filter(l => l.trim())
    .map(l => l.replace(/<[^>]+>/g, '').trim())
    .filter(l => l);
  return lines.filter((l, i) => i === 0 || l !== lines[i - 1]).join(' ');
}

// Last yt-dlp ERROR line seen, so a failure says why instead of just "no subs".
let lastError = null;

function errorLine(output) {
  const lines = String(output || '').split('\n').filter(l => /ERROR:/.test(l));
  return lines.length ? lines[lines.length - 1].trim().substring(0, 300) : null;
}

function extractTranscript(videoId, platform, handle) {
  lastError = null;
  const tmpDir = '/tmp/videoscore-collect';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, videoId);

  // Clean previous
  fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId)).forEach(f => fs.unlinkSync(path.join(tmpDir, f)));

  let url, cmd;
  if (platform === 'youtube') {
    url = `https://www.youtube.com/watch?v=${videoId}`;
    cmd = `yt-dlp --write-auto-sub --sub-lang en --skip-download --sub-format vtt -o "${outPath}" "${url}" 2>&1`;
  } else {
    url = `https://www.tiktok.com/@${handle}/video/${videoId}`;
    cmd = `yt-dlp --write-subs --sub-lang eng-US --skip-download --sub-format vtt -o "${outPath}" "${url}" 2>&1`;
  }

  try {
    execSync(cmd, { encoding: 'utf8', timeout: 60000 });

    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId) && f.endsWith('.vtt'));
    if (files.length === 0) {
      // Retry TikTok with available language
      if (platform === 'tiktok') {
        const listCmd = `yt-dlp --list-subs "${url}" 2>&1`;
        const listOutput = execSync(listCmd, { encoding: 'utf8', timeout: 30000 });
        const langMatch = listOutput.match(/^(\S+)\s+vtt/m);
        if (langMatch) {
          const retryCmd = `yt-dlp --write-subs --sub-lang "${langMatch[1]}" --skip-download --sub-format vtt -o "${outPath}" "${url}" 2>&1`;
          execSync(retryCmd, { encoding: 'utf8', timeout: 60000 });
          const retryFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId) && f.endsWith('.vtt'));
          if (retryFiles.length > 0) return parseVTT(fs.readFileSync(path.join(tmpDir, retryFiles[0]), 'utf8'));
        }
      }
      return null;
    }
    return parseVTT(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
  } catch (err) {
    lastError = errorLine(err.stdout) || errorLine(err.stderr) || String(err.message || err).substring(0, 300);
    return null;
  }
}

async function main() {
  const creatorFilter = process.argv.find(a => a.startsWith('--creator='))?.split('=')[1];
  const refresh = process.argv.includes('--refresh');

  if (!fs.existsSync(RAW_TRANSCRIPTS_DIR)) fs.mkdirSync(RAW_TRANSCRIPTS_DIR, { recursive: true });

  const discoveryFiles = fs.readdirSync(DISCOVERY_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  let extracted = 0, skipped = 0, failed = 0;
  const byPlatform = {}; // platform -> { attempted, extracted, errored, sampleError }

  for (const file of discoveryFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(DISCOVERY_DIR, file), 'utf8'));
    if (creatorFilter && data.handle.toLowerCase() !== creatorFilter.toLowerCase()) continue;

    // Collect videos flagged as review candidates (by title heuristics OR by LLM pre-classification)
    const candidates = data.videos.filter(v => v.isReviewCandidate || v.llmFlagged);
    console.log(`\n=== ${data.handle} (${candidates.length} candidates out of ${data.videos.length} total) ===`);

    for (const video of candidates) {
      const outFile = path.join(RAW_TRANSCRIPTS_DIR, `${video.id}.json`);

      if (!refresh && fs.existsSync(outFile)) {
        skipped++;
        continue;
      }

      process.stdout.write(`  ${video.id} "${video.title?.substring(0, 50)}..." `);
      let transcript = extractTranscript(video.id, data.platform, data.handle);
      let publishedAt = null;
      if (!transcript && data.platform === 'youtube' && YOUTUBE_FETCHPAGE_FALLBACK) {
        const fb = await youtubeFallback(video.id, !video.date || video.date === 'NA');
        transcript = fb.transcript;
        publishedAt = fb.publishedAt;
        // Report the fallback's outcome: a caption-less video is "no subs",
        // not the yt-dlp bot wall we already routed around.
        lastError = fb.error;
      }
      const stats = byPlatform[data.platform] || (byPlatform[data.platform] = { attempted: 0, extracted: 0, errored: 0, sampleError: null });
      stats.attempted++;
      if (transcript) stats.extracted++;
      else if (lastError && !isVideoSpecificError(lastError)) {
        stats.errored++;
        if (!stats.sampleError) stats.sampleError = lastError;
      }

      if (transcript) {
        const wordCount = transcript.split(/\s+/).length;
        fs.writeFileSync(outFile, JSON.stringify({
          videoId: video.id,
          creatorId: data.handle,
          platform: data.platform,
          title: video.title,
          // flat-playlist listing has no upload date for YouTube ("NA"); the
          // watch page does.
          date: (video.date && video.date !== 'NA') ? video.date : (publishedAt || video.date),
          duration: video.duration,
          views: video.views,
          transcript,
          wordCount,
          collectedAt: new Date().toISOString()
        }, null, 2));
        extracted++;
        console.log(`✓ ${wordCount}w`);
      } else {
        failed++;
        console.log(lastError ? `✗ ${lastError}` : '✗ no subs');
      }

      // Rate limit
      execSync('sleep 2');
    }
  }

  // BRO-4760: re-date published YouTube reviews stored with "NA" (5 credits each).
  if (YOUTUBE_FETCHPAGE_FALLBACK && process.env.SCRAPINGDOG_API_KEY) {
    const bf = await backfillPublishedDates({
      transcriptsDir: path.dirname(RAW_TRANSCRIPTS_DIR),
      creatorFilter,
      max: Number(process.env.YT_DATE_BACKFILL_MAX || 250),
    });
    console.log(`\nYouTube date backfill: ${bf.dated}/${bf.attempted} dated (${bf.candidates} undated published reviews)`);
  }

  console.log(`\n=== Collection Summary ===`);
  console.log(`Extracted: ${extracted}, Skipped (cached): ${skipped}, Failed: ${failed}`);
  console.log(`Total raw transcripts: ${fs.readdirSync(RAW_TRANSCRIPTS_DIR).filter(f => f.endsWith('.json')).length}`);

  for (const [platform, s] of Object.entries(byPlatform)) {
    console.log(`  ${platform}: ${s.extracted}/${s.attempted} extracted, ${s.errored} yt-dlp errors${s.sampleError ? ` (e.g. ${s.sampleError})` : ''}`);
  }
  const outages = detectTranscriptOutages(byPlatform);
  if (outages.length) {
    console.error(`\n::error::Transcript extraction is failing for ${outages.join(', ')}: 0 successes. yt-dlp is likely missing a dependency or blocked; see the sample error above.`);
    process.exit(OUTAGE_EXIT_CODE);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
