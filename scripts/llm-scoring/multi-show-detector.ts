/**
 * Multi-Show Detector
 *
 * Detects reviews that discuss multiple Broadway shows (roundup articles,
 * season previews, etc.) which should not be scored as a single-show review.
 *
 * Loads show titles dynamically from data/shows.json.
 */

import * as fs from 'fs';
import * as path from 'path';

// ========================================
// TYPES
// ========================================

export interface MultiShowDetectionResult {
  isMultiShowReview: boolean;
  otherShows: Array<{ title: string; mentions: number }>;
  recommendation: 'score' | 'warn' | 'skip';
  reason?: string;
}

interface ShowEntry {
  id: string;
  title: string;
  slug: string;
}

// ========================================
// SHOW TITLE LOADING
// ========================================

let cachedShowTitles: Map<string, string> | null = null;

/**
 * Load show titles from data/shows.json
 * Returns a Map of lowercase title -> show ID
 */
function loadShowTitles(): Map<string, string> {
  if (cachedShowTitles) return cachedShowTitles;

  const showsPath = path.join(__dirname, '../../data/shows.json');

  try {
    const raw = JSON.parse(fs.readFileSync(showsPath, 'utf-8'));
    const shows: ShowEntry[] = raw.shows || raw;

    cachedShowTitles = new Map();

    for (const show of shows) {
      if (show.title && show.title.length > 2) {
        cachedShowTitles.set(show.title.toLowerCase(), show.id || show.slug);
      }
    }

    return cachedShowTitles;
  } catch {
    // Fallback: empty map (detection will be a no-op)
    cachedShowTitles = new Map();
    return cachedShowTitles;
  }
}

// ========================================
// DETECTION
// ========================================

/**
 * Words too common/short to use as show title matches
 */
const SKIP_TITLES = new Set([
  'six', 'cats', 'rent', 'hair', 'fame', 'nine', 'once', 'annie', 'grease',
  'chicago', 'oliver', 'company', 'pippin',
]);

/**
 * Count word-boundary mentions of a title in text
 */
function countMentions(text: string, title: string): number {
  // Skip very short titles (3 chars or less) — too many false positives
  if (title.length <= 3) return 0;

  // Skip common words that happen to be show titles
  if (SKIP_TITLES.has(title.toLowerCase())) return 0;

  // Escape regex special chars in title
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Word boundary match (case insensitive)
  const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

/**
 * Detect if a review discusses multiple shows
 *
 * @param text - The review text to analyze
 * @param targetShowId - The show this review is supposed to be about
 * @returns Detection result with recommendation
 */
export function detectMultiShow(
  text: string,
  targetShowId: string
): MultiShowDetectionResult {
  if (!text || text.length < 200) {
    return { isMultiShowReview: false, otherShows: [], recommendation: 'score' };
  }

  const showTitles = loadShowTitles();
  const lowerText = text.toLowerCase();

  // Get the target show's title to exclude it
  const targetTitle = [...showTitles.entries()]
    .find(([, id]) => id === targetShowId)?.[0];

  // Also extract key words from the target show ID for fuzzy exclusion
  const targetIdWords = targetShowId
    .replace(/-\d{4}$/, '')
    .split('-')
    .filter(w => w.length > 3);

  const otherShows: Array<{ title: string; mentions: number }> = [];

  for (const [title, showId] of showTitles) {
    // Skip the target show itself
    if (showId === targetShowId) continue;
    if (title === targetTitle) continue;

    // Skip if title words overlap significantly with target
    const titleWords = title.split(/\s+/).filter(w => w.length > 3);
    const overlap = titleWords.filter(w => targetIdWords.includes(w)).length;
    if (overlap > 0 && overlap >= titleWords.length * 0.5) continue;

    const mentions = countMentions(lowerText, title);

    if (mentions >= 3) {
      otherShows.push({ title, mentions });
    }
  }

  // Sort by mention count descending
  otherShows.sort((a, b) => b.mentions - a.mentions);

  if (otherShows.length === 0) {
    return { isMultiShowReview: false, otherShows: [], recommendation: 'score' };
  }

  // If 2+ other shows have 3+ mentions each, this is likely a roundup
  if (otherShows.length >= 2) {
    return {
      isMultiShowReview: true,
      otherShows,
      recommendation: 'skip',
      reason: `Roundup article: ${otherShows.length} other shows mentioned 3+ times (${otherShows.slice(0, 3).map(s => s.title).join(', ')})`
    };
  }

  // If 1 other show has 5+ mentions, likely a comparison article
  if (otherShows[0].mentions >= 5) {
    return {
      isMultiShowReview: true,
      otherShows,
      recommendation: 'warn',
      reason: `Comparison article: "${otherShows[0].title}" mentioned ${otherShows[0].mentions} times`
    };
  }

  // 1 other show with 3-4 mentions — just warn
  return {
    isMultiShowReview: false,
    otherShows,
    recommendation: 'warn',
    reason: `"${otherShows[0].title}" mentioned ${otherShows[0].mentions} times (may be comparison)`
  };
}
