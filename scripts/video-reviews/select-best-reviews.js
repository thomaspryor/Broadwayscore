#!/usr/bin/env node
/**
 * Select Best Review Per Creator Per Show
 *
 * When a creator has multiple videos about the same show, picks the best one:
 * 1. Must have 100+ word transcript
 * 2. Must be about the current production (not off-Broadway, tour, or movie)
 * 3. Among qualifying videos, pick the one closest to the show's opening date
 * 4. If dates unavailable, fall back to longest transcript
 *
 * Pipeline: discover → pre-classify → collect → classify → SELECT-BEST → score → build
 *
 * Usage:
 *   node scripts/video-reviews/select-best-reviews.js
 *   node scripts/video-reviews/select-best-reviews.js --show=chess-2025
 */

const fs = require('fs');
const path = require('path');

const CLASSIFIED_DIR = path.join(__dirname, '../../data/video-reviews-transcripts/classified');
const SHOW_DIR = path.join(__dirname, '../../data/video-reviews-transcripts');
const SHOWS_PATH = path.join(__dirname, '../../data/shows.json');

const MIN_WORDS = 100;

function getOpeningDate(showId) {
  try {
    const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const show = data.shows.find(s => s && s.id === showId);
    return show?.openingDate || null;
  } catch {
    return null;
  }
}

function parseDate(dateStr) {
  if (!dateStr || dateStr === 'NA') return null;
  const normalized = dateStr.length === 8 && /^\d{8}$/.test(dateStr)
    ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
    : dateStr;
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(d1, d2) {
  if (!d1 || !d2) return Infinity;
  return Math.abs(d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24);
}

function main() {
  const showFilter = process.argv.find(a => a.startsWith('--show='))?.split('=')[1];

  if (!fs.existsSync(CLASSIFIED_DIR)) {
    console.error('No classified directory found');
    process.exit(1);
  }

  const files = fs.readdirSync(CLASSIFIED_DIR).filter(f => f.endsWith('.json'));

  // Group by showId + creatorId
  const groups = {};
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(CLASSIFIED_DIR, f), 'utf8'));
    if (d.reviewType !== 'review' || !d.showId || d.wordCount < MIN_WORDS) continue;
    if (showFilter && d.showId !== showFilter) continue;

    const key = `${d.showId}/${d.creatorId}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ file: f, ...d });
  }

  let selected = 0, multiChoice = 0;

  for (const [key, candidates] of Object.entries(groups)) {
    const [showId, creatorId] = key.split('/');
    const showDir = path.join(SHOW_DIR, showId);

    // Pick best candidate
    let best;
    if (candidates.length === 1) {
      best = candidates[0];
    } else {
      multiChoice++;
      const openingDate = parseDate(getOpeningDate(showId));

      // Sort by closeness to opening date, then by word count as tiebreaker
      candidates.sort((a, b) => {
        const dateA = parseDate(a.date);
        const dateB = parseDate(b.date);
        const distA = daysBetween(dateA, openingDate);
        const distB = daysBetween(dateB, openingDate);

        if (distA !== distB) return distA - distB; // closer to opening wins
        return b.wordCount - a.wordCount; // longer transcript as tiebreaker
      });

      best = candidates[0];
      if (candidates.length > 1) {
        const bestDate = parseDate(best.date);
        const dist = openingDate && bestDate ? Math.round(daysBetween(bestDate, openingDate)) : '?';
        console.log(`  ${key}: ${candidates.length} candidates → picked ${best.file} (${dist} days from opening, ${best.wordCount}w)`);
      }
    }

    // Write to show directory (only if not already scored there)
    if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });
    const outFile = path.join(showDir, `${creatorId}.json`);

    if (fs.existsSync(outFile)) {
      const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      if (existing.score !== undefined && existing.videoId === best.videoId) continue; // already scored, same video
    }

    const out = {
      creatorId: best.creatorId,
      platform: best.platform,
      videoId: best.videoId,
      videoUrl: best.platform === 'youtube'
        ? `https://www.youtube.com/watch?v=${best.videoId}`
        : `https://www.tiktok.com/@${best.creatorId}/video/${best.videoId}`,
      title: best.title,
      publishedAt: best.date || null,
      views: best.views || null,
      duration: best.duration || null,
      transcript: best.transcript,
      wordCount: best.wordCount,
      transcriptSource: best.platform === 'youtube' ? 'youtube-auto-captions' : 'tiktok-subs',
      extractedAt: best.collectedAt,
    };

    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    selected++;
  }

  console.log(`\nSelected ${selected} reviews (${multiChoice} had multiple candidates)`);
}

main();
