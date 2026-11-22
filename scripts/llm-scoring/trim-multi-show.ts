import { extractVenueBoxSectionForShowId } from './venue-box-sections';
const { getTitleVariants, trimByAsteriskDivider } = require('../lib/multi-show-asterisk-divider');
const { scoreTimeColumnSection } = require('../lib/column-section-extract');
const fs = require('fs');
const path = require('path');
/**
 * Multi-Show Text Trimmer
 *
 * Extracts the relevant section of a multi-show review article for a target show.
 * Uses deterministic section boundaries (no LLM). If no clear section boundary
 * is found, returns the original text with trimFailed: true.
 */

export interface TrimResult {
  text: string;
  trimmed: boolean;
  trimFailed: boolean;
  method: 'heading' | 'asterisk-divider' | 'venue-box' | 'column-section' | 'none';
  originalLength: number;
  trimmedLength: number;
}

export interface ReviewColumnSource {
  outletId?: string;
  criticName?: string;
  url?: string | null;
}

let cachedShows: any[] | null = null;
function loadShows(): any[] {
  if (cachedShows) return cachedShows;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/shows.json'), 'utf-8'));
    cachedShows = (raw.shows || raw) as any[];
  } catch { cachedShows = []; }
  return cachedShows;
}

/**
 * This show's section of a stored critic column on a column host (Vulture, Washington Post), from paragraph
 * openers that name the show (BRO-7877). null when the page is not such a column or cannot be split.
 */
export function trimByColumnSection(fullText: string, targetShowId: string, source?: ReviewColumnSource): TrimResult | null {
  if (!fullText || !targetShowId || !source?.url) return null;
  const shows = loadShows();
  const show = shows.find((s: any) => s && s.id === targetShowId);
  if (!show) return null;
  const r = scoreTimeColumnSection({ url: source.url, text: fullText, show, allShows: shows });
  if (!r.isolated || !r.text) return null;
  return {
    text: r.text,
    trimmed: true,
    trimFailed: false,
    method: 'column-section',
    originalLength: fullText.length,
    trimmedLength: r.text.length,
  };
}

/**
 * Check if a line looks like a section heading
 */
function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Markdown headings: ## Title, ### Title
  if (/^#{1,4}\s+/.test(trimmed)) return true;

  // HTML headings
  if (/<h[1-4][^>]*>/i.test(trimmed)) return true;

  // Bold text as heading: **Title** or __Title__
  if (/^\*\*[^*]+\*\*\s*$/.test(trimmed)) return true;

  // ALL CAPS line (at least 3 words, ≤100 chars — likely a heading)
  if (trimmed.length <= 100 && trimmed.length >= 5 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
    const words = trimmed.split(/\s+/).filter(w => w.length > 1);
    if (words.length >= 2) return true;
  }

  // Short standalone line that looks like a title (starts with capital, no trailing punct,
  // and is very short — under 50 chars). Only match if preceded/followed by blank lines
  // to reduce false positives on dialogue or short prose sentences.
  // This is checked at the caller level via context, so we keep this conservative.
  if (trimmed.length <= 50 && trimmed.length >= 5 && !/[.!?,;:"]$/.test(trimmed) && /^[A-Z"']/.test(trimmed)) {
    // Must look title-like: at least 2 capitalized words or contain quotes
    const capWords = trimmed.match(/\b[A-Z][a-z]+/g);
    if (capWords && capWords.length >= 2) return true;
  }

  return false;
}

/**
 * Check if a heading line contains any of the title variants
 */
function headingContainsTitle(heading: string, titleVariants: string[]): boolean {
  const lower = heading.toLowerCase();
  return titleVariants.some(variant => lower.includes(variant));
}

/**
 * Trim multi-show review text to the section about the target show.
 *
 * Strategy: Try source-specific dividers, then heading breaks with show titles,
 * extract the section for the target show. If no clear headings found,
 * returns original text with trimFailed: true.
 */
export function trimMultiShowText(
  fullText: string,
  targetShowTitle: string,
  targetShowId: string,
  source?: ReviewColumnSource,
): TrimResult {
  if (!fullText) {
    return { text: fullText, trimmed: false, trimFailed: true, method: 'none', originalLength: 0, trimmedLength: 0 };
  }
  const byDivider = trimByAsteriskDivider(fullText, targetShowTitle, source);
  if (byDivider.trimmed) return byDivider;
  const byHeading = trimByHeading(fullText, targetShowTitle);
  // A heading "trim" that keeps (nearly) the whole text removed nothing
  // (master-class-2011: 5693 -> 5693); let the box method try.
  const headingRemovedText = byHeading.trimmed && byHeading.trimmedLength < byHeading.originalLength * 0.95;
  if (headingRemovedText || !targetShowId) return byHeading;
  // WSJ-style columns carry no headings; each review has a production box (BRO-5294).
  const box = extractVenueBoxSectionForShowId(fullText, targetShowId);
  if (!box.ok || !box.text) return trimByColumnSection(fullText, targetShowId, source) || byHeading;
  return {
    text: box.text,
    trimmed: true,
    trimFailed: false,
    method: 'venue-box',
    originalLength: fullText.length,
    trimmedLength: box.text.length,
  };
}

function trimByHeading(
  fullText: string,
  targetShowTitle: string,
): TrimResult {
  const originalLength = fullText.length;
  const fail = { text: fullText, trimmed: false, trimFailed: true, method: 'none' as const, originalLength, trimmedLength: originalLength };

  if (!targetShowTitle || !fullText || fullText.length < 500) {
    return fail;
  }

  const titleVariants = getTitleVariants(targetShowTitle);
  const lines = fullText.split('\n');

  // Find heading lines that look like section breaks for different shows
  const headingIndices: Array<{ lineIndex: number; containsTarget: boolean }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (!isHeadingLine(lines[i])) continue;

    const containsTarget = headingContainsTitle(lines[i], titleVariants);

    // Only count headings that contain a show-like title (capitalized words, not generic)
    // We can't check all show titles here without loading shows.json, so we look for
    // headings that are short and title-cased (likely show names)
    const trimmed = lines[i].trim().replace(/^#{1,4}\s+/, '').replace(/\*\*/g, '');
    const looksLikeShowTitle = trimmed.length <= 80 && trimmed.length >= 3;

    if (containsTarget || looksLikeShowTitle) {
      headingIndices.push({ lineIndex: i, containsTarget });
    }
  }

  // Find the target show's heading
  const targetHeadingIdx = headingIndices.findIndex(h => h.containsTarget);
  if (targetHeadingIdx === -1) {
    return fail;
  }

  // Extract from target heading to next heading (or end of text)
  const startLine = headingIndices[targetHeadingIdx].lineIndex;
  const nextHeading = headingIndices[targetHeadingIdx + 1];
  const endLine = nextHeading ? nextHeading.lineIndex : lines.length;

  const section = lines.slice(startLine, endLine).join('\n').trim();

  // Validate: must be ≥500 chars and contain target title
  if (section.length < 500) {
    return fail;
  }

  const sectionLower = section.toLowerCase();
  const hasTitle = titleVariants.some(v => sectionLower.includes(v));
  if (!hasTitle) {
    return fail;
  }

  return {
    text: section,
    trimmed: true,
    trimFailed: false,
    method: 'heading',
    originalLength,
    trimmedLength: section.length,
  };
}
