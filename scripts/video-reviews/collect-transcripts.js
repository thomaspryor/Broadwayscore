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

function extractTranscript(videoId, platform, handle) {
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
    return null;
  }
}

function main() {
  const creatorFilter = process.argv.find(a => a.startsWith('--creator='))?.split('=')[1];
  const refresh = process.argv.includes('--refresh');

  if (!fs.existsSync(RAW_TRANSCRIPTS_DIR)) fs.mkdirSync(RAW_TRANSCRIPTS_DIR, { recursive: true });

  const discoveryFiles = fs.readdirSync(DISCOVERY_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  let extracted = 0, skipped = 0, failed = 0;

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
      const transcript = extractTranscript(video.id, data.platform, data.handle);

      if (transcript) {
        const wordCount = transcript.split(/\s+/).length;
        fs.writeFileSync(outFile, JSON.stringify({
          videoId: video.id,
          creatorId: data.handle,
          platform: data.platform,
          title: video.title,
          date: video.date,
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
        console.log('✗ no subs');
      }

      // Rate limit
      execSync('sleep 2');
    }
  }

  console.log(`\n=== Collection Summary ===`);
  console.log(`Extracted: ${extracted}, Skipped (cached): ${skipped}, Failed: ${failed}`);
  console.log(`Total raw transcripts: ${fs.readdirSync(RAW_TRANSCRIPTS_DIR).filter(f => f.endsWith('.json')).length}`);
}

main();
