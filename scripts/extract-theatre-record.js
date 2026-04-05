#!/usr/bin/env node
/**
 * Extract reviews from Theatre Record (theatrerecord.com)
 *
 * Logs in with subscriber credentials, searches for shows, extracts
 * full review text from HTML production pages (post-2022 content).
 *
 * Usage:
 *   node scripts/extract-theatre-record.js --show=les-miserables-west-end-2021
 *   node scripts/extract-theatre-record.js --open-we          # All open WE shows
 *   node scripts/extract-theatre-record.js --open-we --dry-run
 *   node scripts/extract-theatre-record.js --long-running      # Open WE, opened before 2025
 *   node scripts/extract-theatre-record.js --browse-we         # Browse /listings/current-west-end (preferred for WE)
 *   node scripts/extract-theatre-record.js --browse-london     # Browse /listings/current-london (Off-WE)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { isLikelyWrongProduction, isLikelyTourReview } = require('./lib/review-guards');

// ─── PDF review parser ───
// Parses reviews from pdftotext output. Reviews follow pattern:
// OUTLET NAME (ALL CAPS) → date line → critic name → review text
// Date formats: "18 May 2021" (post-2019) or "21.12.17" (pre-2019)
const DATE_LONG = /^\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}$/;
const DATE_SHORT = /^\d{1,2}\.\d{1,2}\.\d{2,4}$/;
const isDateLine = (line) => DATE_LONG.test(line) || DATE_SHORT.test(line);

function parseShortDate(dateStr) {
  // "21.12.17" → "2017-12-21", "15.03.99" → "1999-03-15"
  const [d, m, y] = dateStr.split('.');
  const yearNum = parseInt(y, 10);
  const fullYear = yearNum >= 80 ? 1900 + yearNum : (yearNum > 30 ? 1900 + yearNum : 2000 + yearNum);
  return `${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function parsePdfReviews(text, showTitle) {
  const lines = text.split('\n');
  const reviews = [];

  const titleUpper = showTitle.toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Step 1: Find the reviews section for THIS production
  // Pattern: "Reviews" right-aligned, then show title, then first outlet+date
  let reviewsStart = -1;
  let reviewsEnd = lines.length;

  for (let j = 0; j < lines.length; j++) {
    const trimmed = lines[j].trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (trimmed === titleUpper || trimmed === 'THE ' + titleUpper) {
      // Check if preceded by "Reviews" marker (within 5 lines)
      for (let k = Math.max(0, j - 5); k < j; k++) {
        if (lines[k].trim() === 'Reviews') {
          reviewsStart = j + 1;
          break;
        }
      }
      if (reviewsStart > -1) break;
    }
  }

  // Fallback: find first outlet+date pattern after "Reviews" text
  if (reviewsStart === -1) {
    for (let j = 0; j < lines.length; j++) {
      if (lines[j].trim() !== 'Reviews') continue;
      for (let k = j + 1; k < Math.min(j + 10, lines.length); k++) {
        const line = lines[k].trim();
        if (line === line.toUpperCase() && line.length > 3 && /^[A-Z]/.test(line)) {
          const nextLine = (lines[k + 1] || '').trim();
          if (isDateLine(nextLine)) {
            reviewsStart = k;
            break;
          }
        }
      }
      if (reviewsStart > -1) break;
    }
  }

  if (reviewsStart === -1) return [];

  // Step 2: Find end boundary — next production
  for (let j = reviewsStart; j < lines.length; j++) {
    const raw = lines[j];
    const trimmed = raw.trim();

    // Method A: Indented ALL CAPS title (works for -layout mode)
    if (raw.match(/^\s{20,}/) && trimmed.length > 3 && trimmed === trimmed.toUpperCase() &&
        /^[A-Z]/.test(trimmed) && trimmed !== 'Reviews' && trimmed !== 'Index' &&
        !trimmed.includes(titleUpper)) {
      reviewsEnd = j;
      break;
    }

    // Method B: Production metadata block (works for -raw mode)
    // Pattern: ALL CAPS title → "by AUTHOR" or venue+date-range within 5 lines
    // EXCLUDE known outlet names (they look like production titles but aren't)
    const KNOWN_OUTLETS_UPPER = new Set([
      'THE GUARDIAN', 'THE TELEGRAPH', 'THE TIMES', 'THE STAGE', 'DAILY MAIL',
      'EVENING STANDARD', 'THE STANDARD', 'FINANCIAL TIMES', 'THE INDEPENDENT',
      'THE OBSERVER', 'SUNDAY TIMES', 'THE SUNDAY TIMES', 'DAILY TELEGRAPH',
      'DAILY EXPRESS', 'THE SPECTATOR', 'TIME OUT', 'TIME OUT LONDON',
      'THE JEWISH CHRONICLE', 'JEWISH CHRONICLE', 'TRIBUNE', 'METRO',
      'MAIL ON SUNDAY', 'SUNDAY TELEGRAPH', 'BBC NEWS', 'VARIETY',
      'THE NEW YORK TIMES', 'NEW YORK TIMES', 'WHATSONSTAGE',
      'THEREVIEWSHUB.COM', 'THE REVIEWS HUB', 'THEATRECAT', 'LONDON THEATRE',
      'LONDONTHEATRE1', 'EVERYTHING THEATRE', 'BRITISH THEATRE GUIDE',
      'BROADWAYWORLD', 'MUSICAL THEATRE REVIEW', 'THEATRE WEEKLY',
      'THE ARTS DESK', 'THE SCOTSMAN', 'THE LIST', 'RADIO TIMES',
      'DIGITAL SPY', 'THE SUN', 'THE MIRROR', 'THE EXPRESS', 'CULTURE WHISPER',
      'THE I', 'I NEWS', 'LONDONIST', 'CITY A.M.',
    ]);

    if (trimmed === trimmed.toUpperCase() && trimmed.length > 3 && /^[A-Z]/.test(trimmed) &&
        trimmed !== 'Reviews' && trimmed !== 'Index' && !trimmed.includes(titleUpper) &&
        !isDateLine(trimmed) && !KNOWN_OUTLETS_UPPER.has(trimmed)) {
      // Check if next few lines look like production metadata (not a review)
      const nextLines = [];
      for (let k = 1; k <= 5 && j + k < lines.length; k++) {
        nextLines.push(lines[j + k].trim());
      }
      const hasVenueDateRange = nextLines.some(l => /\d{1,2}\s+\w+\s+\d{4}\s*[–—-]\s*\d{1,2}\s+\w+\s+\d{4}/.test(l));
      const hasByAuthor = nextLines.some(l => /^(?:by |Revival |European |World |New |Musical |A play |A comedy |A drama )/i.test(l));
      const hasVenue = nextLines.some(l => /Theatre|Playhouse|Palace|Lyceum|Apollo|Donmar|Almeida|Old Vic|National|Barbican/i.test(l));

      if ((hasVenueDateRange || hasByAuthor) && hasVenue) {
        reviewsEnd = j;
        break;
      }
    }
  }

  // Step 3: Parse reviews within the bounded section
  let i = reviewsStart;
  while (i < reviewsEnd) {
    const line = lines[i].trim();

    // Detect outlet: ALL CAPS line followed by a date
    if (line === line.toUpperCase() && line.length > 3 && /^[A-Z]/.test(line) &&
        !line.includes('Cast & Creative') && line !== titleUpper && line !== 'THE ' + titleUpper) {
      const nextLine = (lines[i + 1] || '').trim();
      if (isDateLine(nextLine)) {
        const outlet = line;
        const date = nextLine;
        const critic = (lines[i + 2] || '').trim();
        i += 3;

        // Skip blank line after critic name
        while (i < reviewsEnd && lines[i].trim() === '') i++;

        // Collect review text until next outlet or section boundary
        const textLines = [];
        while (i < reviewsEnd) {
          const curr = lines[i].trim();
          const next = (lines[i + 1] || '').trim();

          // Stop at next outlet (ALL CAPS + date)
          if (curr === curr.toUpperCase() && curr.length > 3 && /^[A-Z]/.test(curr) && isDateLine(next)) {
            break;
          }

          textLines.push(lines[i]);
          i++;
        }

        let fullText = textLines.map(l => l.trim()).filter(l => l).join('\n');
        // Clean PDF artifacts
        fullText = fullText.replace(/\nIndex$/m, '').replace(/\nReviews$/m, '').replace(/\n\d+$/m, '').trim();
        if (fullText.length > 50) {
          // Convert outlet name to Title Case
          const outletTitle = outlet.split(/[\s.]+/)
            .map(w => w.charAt(0) + w.slice(1).toLowerCase())
            .join(' ')
            .replace(/\.Com$/i, '.com')
            .replace(/Thereviewshub\.com/i, 'The Reviews Hub');

          reviews.push({
            outlet: outletTitle,
            date,
            critic: critic || null,
            fullText
          });
        }
        continue;
      }
    }
    i++;
  }

  return reviews;
}

// For multi-column pre-2019 PDFs: extract ALL reviews, filter by show title mention
function parseRawPdfReviews(text, showTitle) {
  const lines = text.split('\n');
  const allReviews = [];
  const titleLower = showTitle.toLowerCase();
  // Also match with common title variations
  const titleWords = titleLower.split(/\s+/).filter(w => w.length > 3);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Detect outlet: ALL CAPS line followed by a date
    if (line === line.toUpperCase() && line.length > 3 && /^[A-Z]/.test(line) &&
        !line.includes('Cast & Creative') && line !== 'HAMILTON' && line !== 'Index' && line !== 'Reviews') {
      const nextLine = (lines[i + 1] || '').trim();
      if (isDateLine(nextLine)) {
        const outlet = line;
        const date = nextLine;
        const critic = (lines[i + 2] || '').trim();
        i += 3;
        while (i < lines.length && lines[i].trim() === '') i++;

        const textLines = [];
        while (i < lines.length) {
          const curr = lines[i].trim();
          const next = (lines[i + 1] || '').trim();
          if (curr === curr.toUpperCase() && curr.length > 3 && /^[A-Z]/.test(curr) && isDateLine(next)) break;
          textLines.push(lines[i]);
          i++;
        }

        let fullText = textLines.map(l => l.trim()).filter(l => l).join('\n');
        fullText = fullText.replace(/\nIndex$/m, '').replace(/\nReviews$/m, '').replace(/\n\d+$/m, '').trim();

        if (fullText.length > 200 && fullText.length < 15000) {
          // Cap at 15K chars — longer means multiple reviews concatenated
          allReviews.push({ outlet, date, critic, fullText });
        }
        continue;
      }
    }
    i++;
  }

  // Filter: keep only reviews that are actually ABOUT our show
  // Raw mode extracts every review from the PDF — most are for other shows.
  // Multi-column PDFs break words across lines, so full-phrase matching is unreliable.
  // Strategy: exact phrase match OR significant-word overlap with theatre context.
  const titleEscaped = titleLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleRegex = new RegExp(`\\b${titleEscaped}\\b`, 'gi');
  const significantWords = titleLower.split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length > 3 && !['the', 'and', 'for', 'from', 'with'].includes(w));

  const matched = allReviews.filter(r => {
    const textLower = r.fullText.toLowerCase();
    const exactMentions = (textLower.match(titleRegex) || []).length;

    // Path 1: 2+ exact phrase mentions (original strict check)
    if (exactMentions >= 2) {
      const firstIdx = textLower.search(titleRegex);
      const context = textLower.slice(Math.max(0, firstIdx - 150), firstIdx + 300);
      const hasContext = /musical|play|production|stage|theatre|theater|curtain|cast|director|choreograph|review|opening|premiere|perform/i.test(context);
      if (hasContext) return true;
    }

    // Path 2: For multi-word titles, check significant word overlap
    // Multi-column PDFs often break "Book of Mormon" across lines
    if (significantWords.length >= 2) {
      const wordsFound = significantWords.filter(w => textLower.includes(w));
      if (wordsFound.length >= Math.ceil(significantWords.length * 0.7) && wordsFound.length >= 2) {
        // Reject if all title words only appear in the last 30% (wrong-show contamination)
        const firstWordIdx = Math.min(...wordsFound.map(w => textLower.indexOf(w)));
        if (firstWordIdx > textLower.length * 0.7) { /* skip — title only at tail */ }
        else {
          const hasContext = /musical|play|production|stage|theatre|theater|curtain|cast|director|choreograph|opening|premiere/i.test(textLower);
          if (hasContext) return true;
        }
      }
    }

    // Path 3: 1 exact mention + strong theatre context (for very long titles)
    if (exactMentions >= 1 && significantWords.length >= 2) {
      const firstIdx = textLower.search(titleRegex);
      if (firstIdx > textLower.length * 0.7) return false;
      const context = textLower.slice(Math.max(0, firstIdx - 100), firstIdx + 200);
      const strongContext = /musical|play|production|stage|cast|director|opening night|premiere/i.test(context);
      if (strongContext) return true;
    }

    // Path 4: Short/common-word titles (SIX, Cats, Rent)
    // Use the shortest distinctive word even if ≤3 chars, require 3+ standalone mentions
    const coreWord = titleLower.split(/\s+/)
      .map(w => w.replace(/[^a-z0-9]/g, ''))
      .filter(w => w.length >= 2 && !['the', 'and', 'for', 'from', 'with', 'a', 'an', 'at', 'in', 'on', 'of', 'to'].includes(w))
      .sort((a, b) => a.length - b.length)[0];
    if (coreWord && coreWord.length <= 4) {
      const coreRegex = new RegExp(`\\b${coreWord}\\b`, 'gi');
      const coreMentions = (textLower.match(coreRegex) || []).length;
      if (coreMentions >= 3) {
        const firstIdx = textLower.search(coreRegex);
        if (firstIdx <= textLower.length * 0.3) {
          const hasContext = /musical|play|production|stage|theatre|theater|cast|director|choreograph|opening|premiere|west end|broadway/i.test(textLower);
          if (hasContext) return true;
        }
      }
    }

    return false;
  });

  // Post-filter: reject reviews where the first 300 chars are about a different production
  // (multi-column PDFs concatenate adjacent shows' text)
  const cleaned = matched.filter(r => {
    const first300 = r.fullText.substring(0, 300).toLowerCase();
    // Check if the title words appear in the first 300 chars
    const titleInOpening = significantWords.length > 0
      ? significantWords.some(w => first300.includes(w))
      : new RegExp(`\\b${titleEscaped}\\b`, 'i').test(first300);
    if (titleInOpening) return true;
    // If title isn't in first 300 chars, the review is likely about a different show
    // (multi-column contamination from adjacent productions in the same PDF page)
    return false;
    // Allow if title words appear in the first 50% of text
    const firstHalf = r.fullText.substring(0, Math.floor(r.fullText.length * 0.5)).toLowerCase();
    return significantWords.some(w => firstHalf.includes(w));
  });

  // Convert outlet names to Title Case
  return cleaned.map(r => ({
    outlet: r.outlet.split(/[\s.]+/)
      .map(w => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' ')
      .replace(/\.Com$/i, '.com')
      .replace(/Thereviewshub\.com/i, 'The Reviews Hub'),
    date: r.date,
    critic: r.critic || null,
    fullText: r.fullText
  }));
}

async function extractReviewsFromPDF(page, context, pdfUrl, show) {
  // Get session cookie from Playwright context
  const cookies = await context.cookies();
  const phpSession = cookies.find(c => c.name === 'PHPSESSID');
  if (!phpSession) {
    console.log('  No PHPSESSID cookie — cannot download PDF');
    return [];
  }

  // Download PDF to temp file
  const tmpFile = path.join('/tmp', `tr-${show.id}.pdf`);
  try {
    // Resolve any redirects first — /archive/volume/ redirects to /archive/issue/
    const resolvedUrl = pdfUrl.replace(/#.*$/, ''); // Strip fragment
    execSync(`curl -s -L -o "${tmpFile}" -b "PHPSESSID=${phpSession.value}" "${resolvedUrl}"`, { timeout: 30000 });
  } catch (e) {
    console.log(`  PDF download failed: ${e.message}`);
    return [];
  }

  // Verify it's actually a PDF
  const fileType = execSync(`file "${tmpFile}"`).toString();
  if (!fileType.includes('PDF')) {
    console.log(`  Downloaded file is not a PDF: ${fileType.trim()}`);
    fs.unlinkSync(tmpFile);
    return [];
  }

  // Try -layout first (works for 2019+ single-column PDFs with indentation boundaries)
  let text;
  try {
    text = execSync(`pdftotext -layout "${tmpFile}" -`, { maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch (e) {
    console.log(`  pdftotext failed: ${e.message}`);
    fs.unlinkSync(tmpFile);
    return [];
  }

  let reviews = parsePdfReviews(text, show.title);
  if (reviews.length > 0) {
    console.log(`  Extracted ${reviews.length} reviews (-layout mode)`);
    // Don't return yet — also try raw mode as it may find more reviews
    // (layout mode can grab wrong articles from multi-column PDFs)
  }

  // Also try -raw mode — may find additional reviews via title filtering
  // Raw mode can't reliably detect production boundaries, so we extract ALL
  // outlet+date+critic+text blocks and filter to reviews that mention our show
  try {
    text = execSync(`pdftotext -raw "${tmpFile}" -`, { maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch (e) {
    console.log(`  pdftotext -raw failed: ${e.message}`);
    fs.unlinkSync(tmpFile);
    return [];
  }

  const rawReviews = parseRawPdfReviews(text, show.title);
  if (rawReviews.length > 0) {
    console.log(`  Extracted ${rawReviews.length} reviews (-raw mode, title-matched)`);
    // Merge with layout reviews, avoiding duplicates (same outlet+critic)
    const seen = new Set(reviews.map(r => `${r.outlet}|${r.critic}`));
    for (const r of rawReviews) {
      if (!seen.has(`${r.outlet}|${r.critic}`)) {
        reviews.push(r);
        seen.add(`${r.outlet}|${r.critic}`);
      }
    }
  }

  fs.unlinkSync(tmpFile);
  return reviews;
}

const ROOT = path.resolve(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const REVIEWS_FILE = path.join(ROOT, 'data', 'reviews.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const OUTLET_REGISTRY = path.join(ROOT, 'data', 'outlet-registry.json');

// CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const openWE = args.includes('--open-we');
const longRunning = args.includes('--long-running');
const browseWE = args.includes('--browse-we');
const browseLondon = args.includes('--browse-london');
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10) || 0;

// Theatre Record credentials
const TR_EMAIL = process.env.TR_EMAIL || 'thomas.pryor@gmail.com';
const TR_PASSWORD = process.env.TR_PASSWORD || '';

// Theatre Record outlet name → our outlet ID mapping
const TR_OUTLET_MAP = {
  'The Guardian': 'guardian',
  'The Telegraph': 'telegraph',
  'The Times': 'times-uk',
  'The Standard': 'standard',
  'Evening Standard': 'standard',
  'The Stage': 'thestage',
  'Time Out': 'timeout-london',
  'Time Out London': 'timeout-london',
  'The Independent': 'independent',
  'Financial Times': 'financialtimes',
  'Daily Mail': 'daily-mail',
  'The i': 'i-paper',
  'i': 'i-paper',
  'WhatsOnStage': 'whatsonstage',
  'The Observer': 'observer',
  'The Arts Desk': 'artsdesk',
  'BroadwayWorld': 'broadwayworld',
  'London Theatre': 'london-theatre',
  'LondonTheatre1': 'londontheatre1',
  'The Reviews Hub': 'thereviewshub',
  'theatreCat': 'theatrecat',
  'Theatre Weekly': 'theatre-weekly',
  'Musical Theatre Review': 'musical-theatre-review',
  'Everything Theatre': 'everything-theatre',
  'West End Wilma': 'west-end-wilma',
  'Radio Times': 'radio-times',
  'Metro': 'metro',
  'City A.M.': 'city-am',
  'Digital Spy': 'digital-spy',
  'The Sun': 'the-sun',
  'Daily Express': 'express-uk',
  'The Express': 'express-uk',
  'Mail on Sunday': 'daily-mail',
  'The Sunday Times': 'sunday-times',
  'Sunday Telegraph': 'sunday-telegraph',
  'The Scotsman': 'the-scotsman',
  'Hampstead & Highgate Express': 'hampstead-highgate-express',
  'The Spectator': 'the-spectator-uk',
  'London Box Office': 'london-box-office',
  'BBC News': 'bbc-news',
  'Culture Whisper': 'culture-whisper',
  'Londonist': 'londonist',
  'The Mirror': 'the-mirror',
  'A Younger Theatre': 'a-younger-theatre',
  'All That Dazzles': 'all-that-dazzles-uk',
  'West End Best Friend': 'west-end-best-friend',
  'Lost in Theatreland': 'lost-in-theatreland',
  'Shy Strange Manic': 'shy-strange-manic',
  'Theatre Bee': 'theatre-bee-uk',
  'Tim Talks Theatre': 'tim-talks-theatre-uk',
  'Variety': 'variety',
  'The New York Times': 'nytimes',
  'British Theatre Guide': 'british-theatre',
  'Gay Times': 'gay-times',
  'Attitude': 'attitude',
  'Sunday Express': 'express-uk',
  'The Sunday Express': 'express-uk',
  'i news': 'i-paper',
  'The i Paper': 'i-paper',
  'i newspaper': 'i-paper',
  'The Jewish Chronicle': 'the-jewish-chronicle',
  'Jewish Chronicle': 'the-jewish-chronicle',
  'The Herald': 'the-herald',
  'Herald': 'herald',
  'The List': 'the-list',
  "What's On": 'whatsonstage',
  "What'son": 'whatsonstage',
  "What's On Stage": 'whatsonstage',
  'Sunday Times': 'sunday-times',
  'Tribune': 'tribune',
  'The Mirror': 'mirror',
};

// Load data
const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const outletRegistry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY, 'utf8'));

function getOutletId(trName) {
  // Direct map first
  if (TR_OUTLET_MAP[trName]) return TR_OUTLET_MAP[trName];

  // Try matching against outlet registry aliases
  const normalized = trName.toLowerCase().trim();
  for (const [id, outlet] of Object.entries(outletRegistry.outlets || {})) {
    if (outlet.displayName?.toLowerCase() === normalized) return id;
    if (outlet.aliases?.some(a => a.toLowerCase() === normalized)) return id;
  }

  // Slugify as fallback
  return trName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getOutletDisplayName(trName) {
  const id = getOutletId(trName);
  const outlet = outletRegistry.outlets?.[id];
  return outlet?.displayName || trName;
}

function slugifyCritic(name) {
  return name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function makeFilename(outletId, criticName) {
  const critic = criticName ? slugifyCritic(criticName) : 'unknown';
  return `${outletId}--${critic}.json`;
}

function parseDate(dateStr) {
  // "03 April 2026" → "2026-04-03" or "21.12.17" → "2017-12-21"
  if (!dateStr) return null;
  if (DATE_SHORT.test(dateStr)) return parseShortDate(dateStr);
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return d.toISOString().split('T')[0];
}

// Determine which shows to process
function getTargetShows() {
  let shows = showsData.shows;

  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
    return shows;
  }

  if (longRunning) {
    shows = shows.filter(s =>
      (s.category === 'west-end' || s.category === 'off-west-end') &&
      s.status === 'open' &&
      s.openingDate && new Date(s.openingDate) < new Date('2025-01-01')
    );
  } else if (browseWE || browseLondon || openWE) {
    const categories = browseLondon
      ? ['off-west-end']
      : ['west-end', 'off-west-end'];
    shows = shows.filter(s =>
      categories.includes(s.category) &&
      (s.status === 'open' || s.status === 'previews')
    );
  }

  // Sort by opening date (oldest first — biggest gaps)
  shows.sort((a, b) => new Date(a.openingDate || '2099') - new Date(b.openingDate || '2099'));

  if (limit > 0) shows = shows.slice(0, limit);
  return shows;
}

// WE venue name patterns that indicate the right production
// ONLY includes unambiguous London venues — names like "playhouse", "palace",
// "lyceum", "cambridge", "phoenix" exist in Edinburgh/regional cities
const LONDON_VENUES = [
  'west end', 'london', 'victoria palace', 'apollo victoria',
  'savoy', 'dominion', 'drury lane', 'gielgud', 'wyndham', 'garrick',
  'noel coward', 'harold pinter', 'duke of york', 'criterion', 'novello',
  'adelphi', 'prince edward', 'prince of wales',
  'sondheim', 'gillian lynne', 'troubadour', 'kit kat club',
  "st martin", "her majesty", "his majesty", 'old vic', 'young vic',
  'national theatre', 'donmar', 'almeida', 'dorfman', 'olivier', 'lyttelton',
  'barbican', 'sadler', 'ambassadors', 'piccadilly', 'vaudeville',
  'fortune', 'duchess', 'trafalgar',
];

// Cities that indicate NOT London (used to reject ambiguous venue names)
const NON_LONDON_CITIES = [
  'edinburgh', 'bristol', 'birmingham', 'manchester', 'leeds', 'cardiff',
  'glasgow', 'sheffield', 'nottingham', 'southampton', 'brighton', 'bath',
  'chichester', 'oxford', 'salford', 'milton keynes', 'newcastle',
  'liverpool', 'plymouth', 'norwich', 'canterbury',
];

function isLondonVenue(venueText) {
  if (!venueText) return false;
  const lower = venueText.toLowerCase();
  // Reject if a non-London city is mentioned
  if (NON_LONDON_CITIES.some(city => lower.includes(city))) return false;
  return LONDON_VENUES.some(v => lower.includes(v));
}

// Title normalization — shared module
const { normalizeTitle, titlesMatch, cleanSearchTitle } = require('./lib/title-normalization');

// Scrape TR /west-end or /london for featured shows with direct archive links
async function scrapeTRFeaturedShows(page, marketPath) {
  const url = `https://www.theatrerecord.com${marketPath}`;
  console.log(`Scraping featured shows: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  return page.evaluate(() => {
    const results = [];
    // "Top Picks" featured cards have h1 titles + "Continue reading..." links
    document.querySelectorAll('.feature, .features > div').forEach(el => {
      const h1 = el.querySelector('h1');
      const link = el.querySelector('a[href*="/archive/"]');
      if (h1 && link) {
        results.push({ title: h1.textContent.trim(), link: link.href });
      }
    });
    // "Recent Openings" articles with "See cast, creatives, and N reviews" links
    document.querySelectorAll('section.articles article').forEach(article => {
      const h2 = article.querySelector('h2');
      const link = article.querySelector('a[href*="/archive/"]');
      if (h2 && link) {
        results.push({ title: h2.textContent.trim(), link: link.href });
      }
    });
    return results;
  });
}

// Scrape TR /listings/current-west-end or /listings/current-london
async function scrapeTRListingPage(page, listingUrl) {
  console.log(`Scraping listing: ${listingUrl}`);
  await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const entries = await page.evaluate(() => {
    const results = [];
    const articles = document.querySelectorAll('section.articles article');
    articles.forEach(article => {
      const h2 = article.querySelector('h2');
      const h3 = article.querySelector('h3');
      if (!h2) return;
      const title = h2.textContent.trim();
      const venue = h3 ? h3.textContent.trim() : '';
      const opensFeat = article.querySelector('#feat-opens-press-night span, [id*="opens"] span');
      const opens = opensFeat ? opensFeat.textContent.trim() : '';
      results.push({ title, venue, opens });
    });
    return results;
  });

  // Deduplicate — TR often has two entries per show (old + detailed)
  const byTitle = new Map();
  for (const entry of entries) {
    const norm = normalizeTitle(entry.title);
    const existing = byTitle.get(norm);
    if (!existing || (entry.opens && !existing.opens)) {
      byTitle.set(norm, entry);
    }
  }
  const dedupedEntries = [...byTitle.values()];
  console.log(`  Found ${entries.length} entries (${dedupedEntries.length} unique) on listing page`);
  return dedupedEntries;
}

// Match TR listing entries to our shows.json
function matchListingToShows(listings, targetShows) {
  const matched = [];
  const unmatched = [];
  const listingByNormTitle = new Map();
  for (const entry of listings) {
    listingByNormTitle.set(normalizeTitle(entry.title), entry);
  }
  for (const show of targetShows) {
    // Exact match first, then fuzzy
    let listing = listingByNormTitle.get(normalizeTitle(show.title));
    if (!listing) {
      listing = listings.find(e => titlesMatch(e.title, show.title));
    }
    if (listing) {
      matched.push({ show, listing });
    } else {
      unmatched.push(show);
    }
  }
  return { matched, unmatched };
}

async function main() {
  console.log('=== Theatre Record Review Extractor ===');

  const targets = getTargetShows();
  console.log(`Target shows: ${targets.length}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  if (targets.length === 0) {
    console.log('No shows to process.');
    return;
  }

  if (!TR_PASSWORD) {
    console.error('TR_PASSWORD environment variable required');
    process.exit(1);
  }

  // Browser state — mutable so we can recover from crashes
  let browser, context, page;

  async function launchAndLogin() {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });
    page = await context.newPage();

    console.log('Logging in to Theatre Record...');
    await page.goto('https://www.theatrerecord.com/login');
    await page.getByRole('textbox', { name: 'Email' }).fill(TR_EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill(TR_PASSWORD);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.waitForTimeout(3000);

    const loggedIn = await page.locator('text=Sign Out').count() > 0 ||
                     await page.locator('img[alt="Account"]').count() > 0;
    if (!loggedIn) {
      console.error('Login failed!');
      await browser.close();
      process.exit(1);
    }
    console.log('Login successful.\n');
  }

  await launchAndLogin();

  let totalNew = 0;
  let totalSkipped = 0;
  let totalShows = 0;

  // ─── Shared: extract search result entries from current page ───
  async function extractSearchResults(pg) {
    return pg.evaluate(() => {
      const articles = document.querySelectorAll('article');
      const r = [];
      articles.forEach(a => {
        const h2 = a.querySelector('h2');
        const venue = a.querySelector('h3');
        const links = a.querySelectorAll('a');
        let link = null;
        for (const l of links) {
          if (l.href && l.href.includes('/archive/')) { link = l; break; }
        }
        if (!link) {
          for (const l of links) {
            if (l.href && !l.href.includes('/search')) { link = l; break; }
          }
        }
        if (!h2 || !link) return;
        r.push({
          title: h2.textContent.trim(),
          venue: venue?.textContent?.trim() || '',
          link: link.href,
          linkText: link.textContent.trim()
        });
      });
      return r;
    });
  }

  // ─── Shared: extract reviews from a production page link ───
  async function processShowFromLink(show, productionLink) {
    const isPDF = productionLink.includes('/volume/') || productionLink.includes('/issue/');
    let reviews;

    if (isPDF) {
      console.log('  PDF format — downloading and extracting...');
      reviews = await extractReviewsFromPDF(page, context, productionLink, show);
    } else {
      try {
        await page.goto(productionLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) {
        console.log(`  Failed to load page: ${e.message}`);
        return { newCount: 0, skippedCount: 0 };
      }
      await page.waitForTimeout(2000);

      reviews = await page.evaluate(() => {
        const articles = document.querySelectorAll('main article');
        const result = [];
        articles.forEach((a, i) => {
          if (i === 0) return;
          const h2 = a.querySelector('h2');
          if (!h2) return;
          const meta = h2.nextElementSibling;
          const paras = [...a.querySelectorAll('p')];
          const fullText = paras.map(p => p.textContent.trim()).filter(t => t).join('\n\n');
          const criticLink = meta ? meta.querySelector('a') : null;
          const dateText = meta ? meta.textContent.replace(/\s*by\s.*/, '').trim() : '';
          result.push({
            outlet: h2.textContent.trim(),
            critic: criticLink ? criticLink.textContent.trim() : null,
            date: dateText,
            fullText
          });
        });
        return result;
      });
    }

    console.log(`  Found ${reviews.length} reviews`);

    const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
    if (!dryRun && !fs.existsSync(showDir)) {
      fs.mkdirSync(showDir, { recursive: true });
    }

    let newCount = 0;
    let skippedCount = 0;

    for (const review of reviews) {
      if (!review.fullText || review.fullText.length < 100) continue;

      if (review.outlet.toLowerCase().includes('theatre record') ||
          review.outlet.toLowerCase().includes('summary') ||
          review.outlet.toLowerCase().includes('editor')) {
        continue;
      }

      const outletId = getOutletId(review.outlet);
      const outletDisplay = getOutletDisplayName(review.outlet);
      const filename = makeFilename(outletId, review.critic);
      const filepath = path.join(showDir, filename);

      if (fs.existsSync(filepath)) {
        skippedCount++;
        continue;
      }

      // ─── Production validation guards ───
      const pubDate = parseDate(review.date);
      const showEarliestDate = show.previewsStartDate || show.openingDate;
      let skipReason = null;

      if (isLikelyWrongProduction(pubDate, showEarliestDate, 90)) {
        skipReason = `wrong-production-date (review ${pubDate} vs show ${showEarliestDate})`;
      }

      if (!skipReason) {
        const tourPatterns = [
          /\breview(?:ed)?\s+at\s+(?:the\s+)?(?:lowry|playhouse|hippodrome|opera house|new theatre|grand theatre|leeds|birmingham|manchester|bristol|cardiff|glasgow|edinburgh|sheffield|nottingham|southampton|brighton|bath|chichester|oxford|cambridge|salford|milton keynes)/i,
          /\btouring\s+(?:production|company|cast|show)\b/i,
          /\buk\s+tour\b/i,
          /\bnational\s+tour\b/i,
          /\bcurrent(?:ly)?\s+(?:on\s+)?tour\b/i,
        ];
        for (const pat of tourPatterns) {
          if (pat.test(review.fullText)) {
            skipReason = `tour-review (${pat.source.slice(0, 40)})`;
            break;
          }
        }
      }

      if (!skipReason) {
        const pantoMatches = (review.fullText.match(/\bpanto(?:s|mime)?\b/gi) || []).length;
        const pantoInOpening = /\bpanto(?:s|mime)?\b/i.test(review.fullText.slice(0, 200));
        if (pantoMatches >= 3 || pantoInOpening) {
          skipReason = 'panto (not the WE production)';
        }
      }

      if (!skipReason) {
        const filmSignals = [/\b(?:in cinemas|on screen|film adaptation|movie version|streaming on)\b/i];
        for (const pat of filmSignals) {
          if (pat.test(review.fullText)) {
            skipReason = `film/TV review (${pat.source.slice(0, 40)})`;
            break;
          }
        }
      }

      // Guard 5: Wrong-show content detection
      // Check if the review actually discusses our show (catches multi-column
      // PDF contamination AND misfiled HTML reviews on TR production pages)
      if (!skipReason) {
        const reviewLower = review.fullText.toLowerCase();
        const showTitleLower = show.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        const showWords = showTitleLower.split(/\s+/).filter(w => w.length > 3 && !['the', 'and', 'for', 'from', 'with'].includes(w));
        // Also keep shorter core words (e.g., "six" from "SIX the Musical") for fallback
        const coreWords = showTitleLower.split(/\s+/).filter(w => w.length >= 2 && !['the', 'and', 'for', 'from', 'with', 'a', 'an', 'at', 'in', 'on', 'of', 'to'].includes(w));

        // Count title/word mentions
        const titleRegex = new RegExp(`\\b${showTitleLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        const titleMentions = (reviewLower.match(titleRegex) || []).length;
        const wordMentions = showWords.length > 0
          ? Math.max(...showWords.map(w => (reviewLower.match(new RegExp(`\\b${w}\\b`, 'gi')) || []).length))
          : 0;
        // Always check core words as fallback (catches SIX, Cats, Rent where significantWords is insufficient)
        const coreMentions = coreWords.length > 0
          ? Math.max(...coreWords.map(w => (reviewLower.match(new RegExp(`\\b${w}\\b`, 'gi')) || []).length))
          : 0;

        const mentions = Math.max(titleMentions, wordMentions, coreMentions);
        // Single-word or very short titles need 2+ mentions (common words cause false positives)
        // Multi-word titles with distinctive words need only 1
        const minMentions = showWords.length >= 2 ? 1 : 2;
        if (mentions < minMentions) {
          skipReason = `wrong-show (only ${mentions} title mention(s) in review)`;
        }
      }

      if (skipReason) {
        console.log(`    SKIP: ${filename} — ${skipReason}`);
        skippedCount++;
        continue;
      }

      const reviewData = {
        showId: show.id,
        outletId,
        outlet: outletDisplay,
        criticName: review.critic || 'Unknown',
        url: null,
        publishDate: parseDate(review.date) || show.openingDate || null,
        fullText: review.fullText,
        isFullReview: true,
        contentTier: 'complete',
        contentTierReason: 'Full review text from Theatre Record',
        source: 'theatre-record',
        theatreRecordUrl: productionLink,
        addedAt: new Date().toISOString(),
        textWordCount: review.fullText.split(/\s+/).length
      };

      if (dryRun) {
        console.log(`    NEW: ${filename} (${review.fullText.length} chars, ${reviewData.textWordCount} words)`);
      } else {
        fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2));
        console.log(`    SAVED: ${filename} (${reviewData.textWordCount} words)`);
      }
      newCount++;
    }

    if (newCount === 0 && reviews.length > 0) {
      console.log('  All reviews already exist');
    }
    return { newCount, skippedCount };
  }

  // ─── Shared: search TR, collect results, merge deduped ───
  async function searchTR(title) {
    const searchUrl = `https://www.theatrerecord.com/search?query=${encodeURIComponent('"' + title + '"')}&title=on&order=newest`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    let results = await extractSearchResults(page);

    // Quoted search with apostrophes/special chars often returns 0 results on TR
    // Retry without quotes if needed
    if (results.length === 0 && /[''"'']/.test(title)) {
      const cleanTitle = title.replace(/[''"'']/g, ' ').replace(/\s+/g, ' ').trim();
      const retryUrl = `https://www.theatrerecord.com/search?query=${encodeURIComponent(cleanTitle)}&title=on&order=newest`;
      await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);
      results = await extractSearchResults(page);
    }

    return results;
  }

  // ─── Shared: search TR for a show, pick best result, extract ───
  async function searchAndProcessShow(show, hintVenue) {
    const searchTitle = cleanSearchTitle(show.title);

    let results = await searchTR(searchTitle);

    // If no results or no London venue, retry with location filter
    if (results.length === 0 || !results.find(r => isLondonVenue(r.venue))) {
      const retryUrl = `https://www.theatrerecord.com/search?query=${encodeURIComponent('"' + searchTitle + '"')}&title=on&location=on&order=newest`;
      await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);

      const retryResults = await extractSearchResults(page);
      const seen = new Set(results.map(r => r.link));
      for (const r of retryResults) {
        if (!seen.has(r.link)) { results.push(r); seen.add(r.link); }
      }
    }

    let titleMatches = results.filter(r => titlesMatch(r.title, show.title));

    // If no title match, retry with a cleaned (suffix/prefix-stripped) title
    if (titleMatches.length === 0) {
      const shorter = cleanSearchTitle(searchTitle);
      if (shorter !== searchTitle && shorter.length >= 3) {
        console.log(`  Retrying search with shorter title: "${shorter}"`);
        const moreResults = await searchTR(shorter);
        const seen = new Set(results.map(r => r.link));
        for (const r of moreResults) {
          if (!seen.has(r.link)) { results.push(r); seen.add(r.link); }
        }
        titleMatches = results.filter(r => titlesMatch(r.title, show.title));
      }
    }

    if (results.length === 0) {
      console.log('  No results found on Theatre Record');
      return null;
    }

    if (titleMatches.length === 0) {
      console.log(`  No title match. TR results: ${results.map(r => `"${r.title}" @ ${r.venue}`).join('; ')}`);
      return null;
    }

    // Pick best result — use hint venue from listing if available
    let bestResult = null;
    if (hintVenue) {
      const hintName = hintVenue.replace(/,\s*London$/i, '').trim().toLowerCase();
      bestResult = titleMatches.find(r => {
        const rv = r.venue.toLowerCase().replace(/,.*/, '').trim();
        return rv.includes(hintName) || hintName.includes(rv) ||
               normalizeTitle(rv) === normalizeTitle(hintName);
      });
    }
    if (!bestResult) bestResult = titleMatches.find(r => isLondonVenue(r.venue));
    if (!bestResult) {
      const showVenue = show.venue?.toLowerCase() || '';
      if (showVenue) {
        bestResult = titleMatches.find(r =>
          r.venue.toLowerCase().includes(showVenue) ||
          showVenue.includes(r.venue.toLowerCase().replace(/,.*/, '').trim())
        );
      }
    }
    if (!bestResult) bestResult = titleMatches[0];

    console.log(`  Found: ${bestResult.title} @ ${bestResult.venue}`);
    console.log(`  Link: ${bestResult.link}`);

    return processShowFromLink(show, bestResult.link);
  }

  // ─── Main processing loop ───
  if (browseWE || browseLondon) {
    const listingUrl = browseLondon
      ? 'https://www.theatrerecord.com/listings/current-london'
      : 'https://www.theatrerecord.com/listings/current-west-end';

    const listings = await scrapeTRListingPage(page, listingUrl);

    // Also scrape featured shows from /west-end or /london for direct archive links
    const marketPath = browseLondon ? '/london' : '/west-end';
    const featured = await scrapeTRFeaturedShows(page, marketPath);
    console.log(`  Found ${featured.length} featured shows with direct links`);

    // Build a map of featured show links by normalized title
    const featuredByTitle = new Map();
    for (const f of featured) {
      featuredByTitle.set(normalizeTitle(f.title), f.link);
    }

    if (listings.length === 0) {
      console.log('WARNING: No entries on listings page — page structure may have changed.');
      console.log('Falling back to search mode for all shows...\n');
    }

    const { matched, unmatched } = listings.length > 0
      ? matchListingToShows(listings, targets)
      : { matched: [], unmatched: targets };

    // Check if any unmatched shows have direct featured links
    const featuredMatched = [];
    const trulyUnmatched = [];
    for (const show of unmatched) {
      // Check exact and fuzzy title match against featured shows
      let directLink = featuredByTitle.get(normalizeTitle(show.title));
      if (!directLink) {
        for (const [normTitle, link] of featuredByTitle) {
          if (titlesMatch(show.title, normTitle)) { directLink = link; break; }
        }
      }
      if (directLink) {
        featuredMatched.push({ show, link: directLink });
      } else {
        trulyUnmatched.push(show);
      }
    }

    console.log(`\nMatched ${matched.length} shows via listing page`);
    if (featuredMatched.length > 0) {
      console.log(`Matched ${featuredMatched.length} shows via featured/recent openings`);
    }
    if (trulyUnmatched.length > 0) {
      console.log(`Unmatched: ${trulyUnmatched.length} shows (will fall back to search)`);
    }
    console.log('');

    // Helper: process a show with browser crash recovery
    async function processWithRecovery(show, hintVenue) {
      try {
        const result = await searchAndProcessShow(show, hintVenue);
        if (result) {
          totalNew += result.newCount;
          totalSkipped += result.skippedCount;
          if (result.newCount > 0 || result.skippedCount > 0) totalShows++;
        }
        await page.waitForTimeout(2000);
      } catch (err) {
        const isBrowserDead = err.message?.includes('Target page, context or browser has been closed') ||
                              err.message?.includes('browser has been closed') ||
                              err.message?.includes('Navigation failed') ||
                              err.message?.includes('ERR_ABORTED');
        if (isBrowserDead) {
          console.log(`  Browser crashed — relaunching...`);
          await launchAndLogin();
        } else {
          console.log(`  Error: ${err.message}`);
        }
      }
    }

    // Process matched shows — search with venue hint from listing
    for (const { show, listing } of matched) {
      console.log(`\n--- ${show.title} (${show.id}) ---`);
      console.log(`  Listing: "${listing.title}" @ ${listing.venue}`);
      await processWithRecovery(show, listing.venue);
    }

    // Process featured matches (direct archive links, no search needed)
    for (const { show, link } of featuredMatched) {
      console.log(`\n--- ${show.title} (${show.id}) ---`);
      console.log(`  Featured link: ${link}`);
      try {
        const result = await processShowFromLink(show, link);
        if (result) {
          totalNew += result.newCount;
          totalSkipped += result.skippedCount;
          if (result.newCount > 0 || result.skippedCount > 0) totalShows++;
        }
        await page.waitForTimeout(2000);
      } catch (err) {
        if (err.message?.includes('browser has been closed') || err.message?.includes('ERR_ABORTED')) {
          console.log(`  Browser crashed — relaunching...`);
          await launchAndLogin();
        } else {
          console.log(`  Error: ${err.message}`);
        }
      }
    }

    // Fall back to plain search for truly unmatched shows
    if (trulyUnmatched.length > 0) {
      console.log(`\n\n=== Falling back to search for ${trulyUnmatched.length} unmatched shows ===`);
      for (const show of trulyUnmatched) {
        console.log(`\n--- ${show.title} (${show.id}) ---`);
        await processWithRecovery(show);
      }
    }
  } else {
    // ─── Original search mode ───
    for (const show of targets) {
      console.log(`\n--- ${show.title} (${show.id}) ---`);
      try {
        const result = await searchAndProcessShow(show);
        if (result) {
          totalNew += result.newCount;
          totalSkipped += result.skippedCount;
          if (result.newCount > 0 || result.skippedCount > 0) totalShows++;
        }
        await page.waitForTimeout(2000);
      } catch (err) {
        if (err.message?.includes('browser has been closed') || err.message?.includes('ERR_ABORTED')) {
          console.log(`  Browser crashed — relaunching...`);
          await launchAndLogin();
        } else {
          console.log(`  Error: ${err.message}`);
        }
      }
    }
  }

  await browser.close();

  console.log('\n=== Summary ===');
  console.log(`Shows processed: ${totalShows}`);
  console.log(`New reviews: ${totalNew}`);
  console.log(`Skipped (existing): ${totalSkipped}`);
  if (dryRun) console.log('(DRY RUN — nothing saved)');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
