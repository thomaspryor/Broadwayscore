#!/usr/bin/env node
/**
 * Select Best Review Per Creator Per Show
 *
 * When a creator has multiple videos about the same show, picks the best one:
 * 1. Must have 100+ word transcript
 * 2. Must be published AFTER previews started (not before — would be anticipation/different production)
 * 3. Must be published BEFORE closing (not after — would be retrospective)
 * 4. Among qualifying videos, pick the one closest to the show's opening date
 * 5. If dates unavailable, fall back to longest transcript
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

// Cache shows data
let _showsCache = null;
function getShowData(showId) {
  if (!_showsCache) {
    try { _showsCache = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows; } catch { _showsCache = []; }
  }
  return _showsCache.find(s => s && s.id === showId) || null;
}

function getShowDates(showId) {
  const show = getShowData(showId);
  if (!show) return { opening: null, earliest: null, closing: null };

  const opening = show.openingDate || null;
  // Earliest valid date: previewsStartDate, or 30 days before opening as fallback
  let earliest = show.previewsStartDate || null;
  if (!earliest && opening) {
    const d = new Date(opening);
    d.setDate(d.getDate() - 30);
    earliest = d.toISOString().slice(0, 10);
  }
  const closing = show.closingDate || null;

  return { opening, earliest, closing };
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

  let selected = 0, multiChoice = 0, filtered = 0;

  for (const [key, allCandidates] of Object.entries(groups)) {
    const [showId, creatorId] = key.split('/');
    const showDir = path.join(SHOW_DIR, showId);
    const dates = getShowDates(showId);
    const openingDate = parseDate(dates.opening);
    const earliestDate = parseDate(dates.earliest);
    const closingDate = parseDate(dates.closing);

    // Filter by date window: after previews start, before closing
    const candidates = allCandidates.filter(c => {
      const pubDate = parseDate(c.date);
      if (!pubDate) return true; // keep if no date (can't filter)
      if (earliestDate && pubDate < earliestDate) {
        return false; // published before previews — likely different production or anticipation
      }
      if (closingDate && pubDate > closingDate) {
        return false; // published after closing — retrospective
      }
      return true;
    });

    const filteredOut = allCandidates.length - candidates.length;
    if (filteredOut > 0) {
      filtered += filteredOut;
      console.log(`  ${key}: filtered out ${filteredOut}/${allCandidates.length} (outside preview→close window)`);
    }

    if (candidates.length === 0) continue;

    // Pick best candidate
    let best;
    if (candidates.length === 1) {
      best = candidates[0];
    } else {
      multiChoice++;
      candidates.sort((a, b) => {
        const dateA = parseDate(a.date);
        const dateB = parseDate(b.date);
        const distA = daysBetween(dateA, openingDate);
        const distB = daysBetween(dateB, openingDate);
        if (distA !== distB) return distA - distB;
        return b.wordCount - a.wordCount;
      });

      best = candidates[0];
      if (candidates.length > 1) {
        const bestDate = parseDate(best.date);
        const dist = openingDate && bestDate ? Math.round(daysBetween(bestDate, openingDate)) : '?';
        console.log(`  ${key}: ${candidates.length} candidates → picked ${best.file} (${dist} days from opening, ${best.wordCount}w)`);
      }
    }

    // Write to show directory
    if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });
    const outFile = path.join(showDir, `${creatorId}.json`);

    if (fs.existsSync(outFile)) {
      const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      if (existing.score !== undefined && existing.videoId === best.videoId) continue;
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

  console.log(`\nSelected ${selected} reviews (${multiChoice} had multiple candidates, ${filtered} filtered by date window)`);
}

main();
