#!/usr/bin/env node
/**
 * Extract transcripts from video review sources using yt-dlp.
 * Supports YouTube (auto-captions) and TikTok (eng-US subs).
 *
 * Usage:
 *   node scripts/video-reviews/extract-transcripts.js [--show show-id]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SOURCES_PATH = path.join(__dirname, '../../data/video-reviews-sources.json');
const TRANSCRIPTS_DIR = path.join(__dirname, '../../data/video-reviews-transcripts');

function parseVTT(vttText) {
  const lines = vttText.split('\n')
    .filter(l => !l.match(/^(WEBVTT|Kind:|Language:|NOTE|$|\d{2}:\d{2})/))
    .filter(l => l.trim())
    .map(l => l.replace(/<[^>]+>/g, '').trim())
    .filter(l => l);
  const deduped = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
  return deduped.join(' ');
}

function extractTranscript(videoUrl, platform, videoId) {
  const tmpDir = '/tmp/videoscore-transcripts';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, videoId);

  // Clean up previous files
  const existing = fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId));
  existing.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));

  let cmd;
  if (platform === 'youtube') {
    cmd = `yt-dlp --write-auto-sub --sub-lang en --skip-download --sub-format vtt -o "${outPath}" "${videoUrl}" 2>&1`;
  } else if (platform === 'tiktok') {
    cmd = `yt-dlp --write-subs --sub-lang eng-US --skip-download --sub-format vtt -o "${outPath}" "${videoUrl}" 2>&1`;
  } else {
    return null;
  }

  try {
    execSync(cmd, { encoding: 'utf8', timeout: 60000 });

    // Find the VTT file
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId) && f.endsWith('.vtt'));
    if (files.length === 0) {
      // Retry TikTok with available lang
      if (platform === 'tiktok') {
        const listCmd = `yt-dlp --list-subs "${videoUrl}" 2>&1`;
        const listOutput = execSync(listCmd, { encoding: 'utf8', timeout: 30000 });
        const langMatch = listOutput.match(/^(\S+)\s+vtt/m);
        if (langMatch) {
          const retryCmd = `yt-dlp --write-subs --sub-lang "${langMatch[1]}" --skip-download --sub-format vtt -o "${outPath}" "${videoUrl}" 2>&1`;
          execSync(retryCmd, { encoding: 'utf8', timeout: 60000 });
          const retryFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith(videoId) && f.endsWith('.vtt'));
          if (retryFiles.length > 0) {
            return parseVTT(fs.readFileSync(path.join(tmpDir, retryFiles[0]), 'utf8'));
          }
        }
      }
      return null;
    }

    return parseVTT(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
  } catch (err) {
    console.error(`  Error extracting ${videoId}:`, err.message?.substring(0, 200));
    return null;
  }
}

function main() {
  const showFilter = process.argv.find(a => a.startsWith('--show='))?.split('=')[1];
  const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  const shows = Object.keys(sources).filter(k => k !== '_meta');

  for (const showId of shows) {
    if (showFilter && showId !== showFilter) continue;
    const showDir = path.join(TRANSCRIPTS_DIR, showId);
    if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });

    const videos = sources[showId];
    console.log(`\n=== ${showId} (${videos.length} videos) ===`);

    for (const video of videos) {
      const outFile = path.join(showDir, `${video.creatorId}.json`);
      if (fs.existsSync(outFile)) {
        console.log(`  ${video.creatorId}: already extracted, skipping`);
        continue;
      }

      console.log(`  Extracting: ${video.creatorId} (${video.platform}) — ${video.videoId}`);
      const transcript = extractTranscript(video.videoUrl, video.platform, video.videoId);

      if (transcript) {
        const wordCount = transcript.split(/\s+/).length;
        console.log(`  ✓ ${wordCount} words`);
        fs.writeFileSync(outFile, JSON.stringify({
          creatorId: video.creatorId, platform: video.platform,
          videoId: video.videoId, videoUrl: video.videoUrl,
          title: video.title, publishedAt: video.publishedAt,
          views: video.views, duration: video.duration,
          transcript, wordCount,
          transcriptSource: video.platform === 'youtube' ? 'youtube-auto-captions' : 'tiktok-subs',
          extractedAt: new Date().toISOString()
        }, null, 2));
      } else {
        console.log(`  ✗ No transcript available`);
      }
    }
  }
  console.log('\nDone.');
}

main();
