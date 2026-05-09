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
  // Short/ambiguous titles (<=5 chars or common names)
  'six', 'cats', 'rent', 'hair', 'fame', 'nine', 'once', 'annie', 'grease',
  'chicago', 'oliver', 'company', 'pippin',
  // Common English words that are also show titles — cause massive false positives
  // Verified: each word below caused 1+ actual false-positive skip in production data
  'well', 'good', 'home', 'high', 'spring', 'summer', 'november',
  'broadway', 'giant', 'molly',
  'baby', 'brothers', 'doubt', 'dream', 'race', 'rain', 'rose',
  'the audience', 'the performers', 'the news', 'the price', 'the visit',
  // Common words/names that are also show titles — verified false positives in Mar 2026 audit (710 files)
  'the first', 'parade', 'just in time', 'english', 'holiday', 'care',
  'dorothy', 'working', 'emily', 'wanted', 'buddy', 'stanley', 'jackie',
  'fosse', 'sugar', 'irene', 'data', 'brooklyn', 'mail', 'marilyn',
  'legend', 'bent', 'contact', 'stomp', 'stages', 'raisin', 'betty',
  'lenny', 'sylvia', 'carrie',
]);

/**
 * Count word-boundary mentions of a title in text.
 *
 * Uses alphanumeric-character lookbehind/lookahead instead of `\b` so titles
 * ending in punctuation (`Schmigadoon!`, `Hello, Dolly!`, `Oklahoma!`,
 * `Oh, Mary!`) are matched correctly. The `\b` token requires a word ↔ non-word
 * transition; for `Schmigadoon!` followed by space, the trailing `\b` looks for
 * a word character after `!` (a non-word char), finds whitespace (also non-word),
 * and fails — silently returning 0 mentions for ~90 shows in the catalogue
 * (issue #316: New Yorker joint Schmigadoon!/Lost Boys review missed detection
 * with 7 Schmigadoon! mentions because of this bug).
 */
function countMentions(text: string, title: string): number {
  // Skip very short titles (3 chars or less) — too many false positives
  if (title.length <= 3) return 0;

  // Skip common words that happen to be show titles
  if (SKIP_TITLES.has(title.toLowerCase())) return 0;

  // Escape regex special chars in title
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Punctuation-tolerant boundary: require non-alphanumeric (or string edge)
  // immediately before/after the title. Works whether the title ends in a
  // letter (`The Lost Boys`), digit (`9 to 5`), or punctuation (`Schmigadoon!`).
  const regex = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi');
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

    if (mentions >= 5) {
      otherShows.push({ title, mentions });
    }
  }

  // Sort by mention count descending
  otherShows.sort((a, b) => b.mentions - a.mentions);

  if (otherShows.length === 0) {
    return { isMultiShowReview: false, otherShows: [], recommendation: 'score' };
  }

  // If 2+ other shows have 5+ mentions each, this is likely a roundup
  if (otherShows.length >= 2) {
    return {
      isMultiShowReview: true,
      otherShows,
      recommendation: 'skip',
      reason: `Roundup article: ${otherShows.length} other shows mentioned 5+ times (${otherShows.slice(0, 3).map(s => s.title).join(', ')})`
    };
  }

  // If 1 other show has 7+ mentions, likely a comparison article
  if (otherShows[0].mentions >= 7) {
    return {
      isMultiShowReview: true,
      otherShows,
      recommendation: 'warn',
      reason: `Comparison article: "${otherShows[0].title}" mentioned ${otherShows[0].mentions} times`
    };
  }

  // 1 other show with 5-6 mentions — just warn
  return {
    isMultiShowReview: false,
    otherShows,
    recommendation: 'warn',
    reason: `"${otherShows[0].title}" mentioned ${otherShows[0].mentions} times (may be comparison)`
  };
}
