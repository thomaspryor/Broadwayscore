#!/usr/bin/env npx ts-node
/**
 * Review Collection Status
 * Shows which shows need reviews and their current state
 */

import * as fs from 'fs';
import * as path from 'path';

interface Show {
  id: string;
  title: string;
  status: string;
  openingDate?: string;
}

interface Review {
  showId: string;
  assignedScore?: number;
  bucket?: string;
}

const dataDir = path.join(__dirname, '../../data');

function loadJSON<T>(filename: string): T {
  const filepath = path.join(dataDir, filename);
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

function main() {
  const showsData = loadJSON<{ shows: Show[] }>('shows.json');
  const reviewsData = loadJSON<{ reviews: Review[] }>('reviews.json');

  // Get open shows
  const openShows = showsData.shows.filter(s => s.status === 'open');

  console.log('=== REVIEW COLLECTION STATUS ===\n');
  console.log(`Open Shows: ${openShows.length}\n`);

  const showStats: Array<{
    title: string;
    id: string;
    reviewCount: number;
    avg: number | null;
    pctPositive: number | null;
    status: string;
  }> = [];

  for (const show of openShows) {
    const reviews = reviewsData.reviews.filter(
      r => r.showId === show.id && r.assignedScore !== undefined
    );

    const scores = reviews.map(r => r.assignedScore!);
    const avg = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null;

    const positive = reviews.filter(r =>
      r.bucket === 'Rave' || r.bucket === 'Positive'
    ).length;
    const pctPositive = reviews.length > 0
      ? Math.round((positive / reviews.length) * 100)
      : null;

    let status = '❌ No reviews';
    if (reviews.length >= 15) {
      status = '✅ Complete';
    } else if (reviews.length >= 10) {
      status = '🟡 Partial';
    } else if (reviews.length > 0) {
      status = '🟠 Started';
    }

    showStats.push({
      title: show.title,
      id: show.id,
      reviewCount: reviews.length,
      avg,
      pctPositive,
      status
    });
  }

  // Sort by review count (least first)
  showStats.sort((a, b) => a.reviewCount - b.reviewCount);

  // Print table
  console.log('Show                          | Reviews | Avg  | %Pos | Status');
  console.log('------------------------------|---------|------|------|--------');

  for (const s of showStats) {
    const title = s.title.substring(0, 29).padEnd(29);
    const count = String(s.reviewCount).padStart(7);
    const avg = s.avg ? s.avg.toFixed(1).padStart(4) : '  - ';
    const pct = s.pctPositive !== null ? `${s.pctPositive}%`.padStart(4) : '  - ';
    console.log(`${title} | ${count} | ${avg} | ${pct} | ${s.status}`);
  }

  // Summary
  const needsWork = showStats.filter(s => s.reviewCount < 15);
  const complete = showStats.filter(s => s.reviewCount >= 15);

  console.log('\n--- SUMMARY ---');
  console.log(`Complete (15+ reviews): ${complete.length}`);
  console.log(`Needs work: ${needsWork.length}`);

  if (needsWork.length > 0) {
    console.log('\nShows needing reviews (run /collect-reviews for each):');
    needsWork.forEach(s => {
      console.log(`  - ${s.title} (${s.id}): ${s.reviewCount} reviews`);
    });
  }
}

main();
