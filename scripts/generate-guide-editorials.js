#!/usr/bin/env node

/**
 * Generate editorial introductions for guide pages using Claude API.
 * Runs monthly (1st of month) to create fresh, dated content for SEO guides.
 *
 * Safety guards:
 * - Output file size assertion (max 500KB)
 * - Schema validation on each editorial entry
 * - 3 retries with exponential backoff on API failures
 * - Preserves existing editorials on partial failure
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const REVIEWS_FILE = path.join(ROOT, 'data', 'reviews.json');
const CONSENSUS_FILE = path.join(ROOT, 'data', 'critic-consensus.json');
const OUTPUT_FILE = path.join(ROOT, 'data', 'guide-editorials.json');

const MAX_FILE_SIZE = 500 * 1024; // 500KB
const MAX_RETRIES = 3;

// Guide definitions (mirrors src/config/guide-pages.ts)
const GUIDE_DEFS = [
  { slug: 'best-broadway-shows', title: 'Best Broadway Shows', filter: (s) => s.status === 'open' && (s.criticScore?.score ?? 0) > 0, yearPages: [2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  { slug: 'best-broadway-musicals', title: 'Best Broadway Musicals', filter: (s) => s.status === 'open' && s.type === 'musical', yearPages: [2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  { slug: 'best-broadway-plays', title: 'Best Broadway Plays', filter: (s) => s.status === 'open' && s.type === 'play', yearPages: [2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  { slug: 'best-broadway-shows-for-kids', title: 'Best Broadway Shows for Kids', filter: (s) => {
    if (s.status !== 'open') return false;
    const tags = (s.tags || []).map(t => t.toLowerCase());
    const ageRec = (s.ageRecommendation || '').toLowerCase();
    return tags.includes('family') || tags.includes('accessible') || ageRec.includes('ages 6') || ageRec.includes('ages 8') || ageRec.includes('all ages');
  }},
  { slug: 'best-new-broadway-shows', title: 'Best New Broadway Shows', filter: (s) => {
    if (s.status !== 'open') return false;
    const now = new Date();
    const seasonStartYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    return new Date(s.openingDate) >= new Date(`${seasonStartYear}-09-01`);
  }},
  { slug: 'cheap-broadway-tickets', title: 'Cheap Broadway Tickets', filter: (s) => {
    if (s.status !== 'open') return false;
    const tags = (s.tags || []).map(t => t.toLowerCase());
    return tags.includes('lottery') || tags.includes('rush');
  }},
  { slug: 'broadway-shows-closing-soon', title: 'Broadway Shows Closing Soon', filter: (s) => {
    if (s.status !== 'open' || !s.closingDate) return false;
    const diffDays = Math.ceil((new Date(s.closingDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return diffDays > 0 && diffDays <= 60;
  }},
  { slug: 'highest-rated-broadway-shows', title: 'Highest Rated Broadway Shows of All Time', filter: (s) => (s.criticScore?.score ?? 0) >= 70 },
];

function getCurrentMonthYear() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const now = new Date();
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}

function getCurrentSeason() {
  const now = new Date();
  const year = now.getFullYear();
  if (now.getMonth() >= 8) return `${year}-${year + 1}`;
  return `${year - 1}-${year}`;
}

function getShowsForGuide(guideDef, shows, consensus, year) {
  let filtered = shows.filter(guideDef.filter);

  if (year) {
    filtered = filtered.filter(s => new Date(s.openingDate).getFullYear() === year);
    // For year pages, include all statuses (not just open)
    if (year < new Date().getFullYear()) {
      const baseFilter = guideDef.filter;
      filtered = shows.filter(s => {
        const openDate = new Date(s.openingDate);
        return openDate.getFullYear() === year && (s.criticScore?.score ?? 0) > 0;
      });
    }
  }

  filtered.sort((a, b) => (b.criticScore?.score ?? 0) - (a.criticScore?.score ?? 0));

  return filtered.slice(0, 10).map(s => ({
    title: s.title,
    score: s.criticScore?.score ? Math.round(s.criticScore.score) : null,
    reviewCount: s.criticScore?.reviewCount || 0,
    type: s.type,
    venue: s.venue,
    consensus: consensus.shows?.[s.id]?.text || null,
  }));
}

async function callClaudeWithRetry(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 500,
          temperature: 0.7,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`API ${res.status}: ${err.slice(0, 200)}`);
      }

      const data = await res.json();
      return data.content[0].text.trim();
    } catch (err) {
      console.error(`  Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function validateEditorialEntry(entry) {
  if (typeof entry.intro !== 'string' || entry.intro.length < 50) return false;
  if (typeof entry.lastUpdated !== 'string') return false;
  if (typeof entry.showCount !== 'number') return false;
  // No nested objects allowed
  for (const val of Object.values(entry)) {
    if (val !== null && typeof val === 'object') return false;
  }
  return true;
}

async function generateEditorial(guideDef, shows, monthYear, year) {
  const showSummaries = shows
    .map((s, i) => {
      const consensus = s.consensus ? ` — ${s.consensus.slice(0, 120)}` : '';
      return `${i + 1}. ${s.title} (${s.score ?? 'N/A'}/100, ${s.reviewCount} reviews)${consensus}`;
    })
    .join('\n');

  const avgScore = shows.length > 0
    ? Math.round(shows.reduce((sum, s) => sum + (s.score ?? 0), 0) / shows.length)
    : 0;

  const yearContext = year ? ` (specifically shows that opened in ${year})` : '';

  const prompt = `You are writing the editorial introduction for a Broadway guide page titled "${guideDef.title}" for ${monthYear}${yearContext}. This guide features ${shows.length} shows.

TOP SHOWS:
${showSummaries}

CONTEXT:
- ${shows.length} shows featured
- Average critic score: ${avgScore}/100
- Current: ${monthYear}

Write a 150-300 word editorial introduction that:
- Opens with the current time context
- Highlights 2-3 standout shows by name
- Is objective and informative (not promotional)
- Uses present tense
- Ends with a forward-looking or actionable sentence

Write only the editorial text. Maximum 300 words.`;

  return callClaudeWithRetry(prompt);
}

async function main() {
  console.log('Generating guide page editorials...\n');

  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
  const shows = showsData.shows;

  // Load reviews to get scores (shows.json may not have them)
  let reviewsData = { reviews: [] };
  try { reviewsData = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf-8')); } catch {}

  let consensus = { shows: {} };
  try { consensus = JSON.parse(fs.readFileSync(CONSENSUS_FILE, 'utf-8')); } catch {}

  // Merge review scores into shows
  const reviewsByShow = {};
  for (const r of reviewsData.reviews) {
    if (!reviewsByShow[r.showId]) reviewsByShow[r.showId] = [];
    reviewsByShow[r.showId].push(r);
  }
  for (const show of shows) {
    const showReviews = reviewsByShow[show.id] || [];
    if (showReviews.length > 0 && !show.criticScore) {
      const scores = showReviews.filter(r => r.assignedScore).map(r => r.assignedScore);
      if (scores.length > 0) {
        show.criticScore = {
          score: scores.reduce((a, b) => a + b, 0) / scores.length,
          reviewCount: scores.length,
        };
      }
    }
  }

  // Load existing editorials (preserve on partial failure)
  let editorials = { _meta: {}, guides: {} };
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      editorials = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    }
  } catch {}

  const monthYear = getCurrentMonthYear();
  let processed = 0;
  let errors = 0;

  // Process base guides
  for (const def of GUIDE_DEFS) {
    console.log(`\n${def.slug}`);
    try {
      const guideShows = getShowsForGuide(def, shows, consensus, null);
      if (guideShows.length === 0) {
        console.log('  Skipped — no matching shows');
        continue;
      }
      console.log(`  Generating from ${guideShows.length} shows...`);
      const intro = await generateEditorial(def, guideShows, monthYear, null);

      const entry = {
        intro,
        monthYear,
        lastUpdated: new Date().toISOString().split('T')[0],
        showCount: guideShows.length,
      };

      if (validateEditorialEntry(entry)) {
        editorials.guides[def.slug] = entry;
        console.log(`  OK: "${intro.slice(0, 60)}..."`);
        processed++;
      } else {
        console.error('  INVALID entry — skipped');
        errors++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      errors++;
    }
  }

  // Process year variants
  for (const def of GUIDE_DEFS) {
    if (!def.yearPages) continue;

    for (const year of def.yearPages) {
      const yearSlug = `${def.slug}-${year}`;
      console.log(`\n${yearSlug}`);
      try {
        const guideShows = getShowsForGuide(def, shows, consensus, year);
        if (guideShows.length === 0) {
          console.log('  Skipped — no matching shows');
          continue;
        }
        console.log(`  Generating from ${guideShows.length} shows for ${year}...`);
        const intro = await generateEditorial(def, guideShows, monthYear, year);

        const entry = {
          intro,
          year,
          lastUpdated: new Date().toISOString().split('T')[0],
          showCount: guideShows.length,
        };

        if (validateEditorialEntry(entry)) {
          editorials.guides[yearSlug] = entry;
          console.log(`  OK: "${intro.slice(0, 60)}..."`);
          processed++;
        } else {
          console.error('  INVALID entry — skipped');
          errors++;
        }

        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
        errors++;
      }
    }
  }

  // Update metadata
  editorials._meta = {
    lastGenerated: new Date().toISOString(),
    updatePolicy: 'Monthly on 1st of month',
  };

  // Save with size check
  const output = JSON.stringify(editorials, null, 2);
  if (Buffer.byteLength(output) > MAX_FILE_SIZE) {
    console.error(`\nFATAL: Output file exceeds ${MAX_FILE_SIZE / 1024}KB limit (${Buffer.byteLength(output)} bytes). Not saving.`);
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT_FILE, output);

  console.log(`\nDone! Processed: ${processed}, Errors: ${errors}`);
  console.log(`Saved to: data/guide-editorials.json (${Buffer.byteLength(output)} bytes)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
