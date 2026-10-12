/**
 * Theatre Record PDF review parsers, extracted from extract-theatre-record.js
 * (CLAUDE.md rule 15) so they can be tested against real pdftotext output.
 */

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

// TR's 2019+ issue PDFs open each production with an info page:
//   ANNA X                                         Index
//   New play written by JOSEPH CHARLTON
//   Harold Pinter Theatre, London
//   Previews / Opens              Press night                   Closes
// The title shares its line with a right-aligned "Index" link and long
// titles wrap ("JOSEPH AND THE AMAZING" / "TECHNICOLOR DREAMCOAT"). BRO-5141:
// neither shape matched the title/boundary checks below, so the Joseph
// (2021) run parsed from the issue's first Reviews block to the end of the
// PDF and filed Anna X, FRIEND and other productions' reviews under Joseph.
const INDEX_SUFFIX = /\s{2,}Index\s*$/;
const stripIndexSuffix = (line) => line.replace(INDEX_SUFFIX, '').trim();
const PRODUCTION_INFO_LINE = /^Previews \/ Opens\b/;
// A title line never ends a sentence ("BRAVO." closing a review is prose).
const isCapsTitleLine = (t) => t.length > 1 && /[A-Z]/.test(t) && t === t.toUpperCase() && !isDateLine(t) && !/[.,;:]$/.test(t);

// 2019-20 issues print "TITLE" / "Goto" / "CITY, VENUE" above the info line.
const isHeaderLine = (t) => isCapsTitleLine(t) || t === 'Goto';

// First line of the production header block whose info line ("Previews /
// Opens") sits at `infoIdx`: the ALL CAPS title line(s) just above it.
function productionHeaderStart(lines, infoIdx, floor = 0) {
  for (let k = infoIdx - 1; k >= Math.max(floor, infoIdx - 8); k--) {
    const t = stripIndexSuffix(lines[k].trim());
    if (!t || !isCapsTitleLine(t)) continue;
    // A title wraps over at most three lines, plus the 2019 "Goto" line.
    let start = k;
    while (start - 1 >= floor && k - start < 3 && isHeaderLine(stripIndexSuffix(lines[start - 1].trim()))) start--;
    return start;
  }
  return infoIdx;
}

const hasProductionHeaderBleed = (text) => String(text || '').split('\n').some(l => PRODUCTION_INFO_LINE.test(l.trim()));

// Review text never contains another production's info page; when a block
// runs into one (no outlet+date line in between), cut it there.
function cutAtProductionHeader(textLines) {
  const infoIdx = textLines.findIndex(l => PRODUCTION_INFO_LINE.test(l.trim()));
  if (infoIdx === -1) return textLines;
  return textLines.slice(0, productionHeaderStart(textLines, infoIdx));
}

const normTitleLine = (line) => stripIndexSuffix(line.trim()).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Outlet names look like production titles (ALL CAPS) but never end a section.
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

function parsePdfReviews(text, showTitle) {
  const lines = text.split('\n');
  const reviews = [];

  const titleUpper = showTitle.toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Step 1: Find the reviews section for THIS production
  // Pattern: "Reviews" right-aligned, then show title, then first outlet+date
  let reviewsStart = -1;
  let reviewsEnd = lines.length;

  const isOurTitle = (t) => t === titleUpper || t === 'THE ' + titleUpper;
  for (let j = 0; j < lines.length; j++) {
    const trimmed = normTitleLine(lines[j]);
    if (!trimmed) continue;
    // A wrapped title spans up to three lines.
    let titleEnd = -1;
    let joined = trimmed;
    for (let w = 0; w < 3 && titleEnd === -1; w++) {
      if (w > 0) joined += ' ' + normTitleLine(lines[j + w] || '');
      if (isOurTitle(joined)) titleEnd = j + w;
    }
    if (titleEnd > -1) {
      // Check if preceded by "Reviews" marker (within 5 lines)
      for (let k = Math.max(0, j - 5); k < j; k++) {
        if (lines[k].trim() === 'Reviews') {
          reviewsStart = titleEnd + 1;
          break;
        }
      }
      if (reviewsStart > -1) break;
    }
  }

  // Fallback: find first outlet+date pattern after "Reviews" text. Only for
  // a single-production PDF: in a multi-production issue the first Reviews
  // block belongs to whichever show comes first, not necessarily ours.
  const productionCount = lines.filter(l => PRODUCTION_INFO_LINE.test(l.trim())).length;
  if (reviewsStart === -1 && productionCount <= 1) {
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

  if (reviewsStart === -1) {
    if (productionCount > 1) console.log(`  -layout: "${showTitle}" heading not found in a ${productionCount}-production issue; relying on -raw title matching`);
    return [];
  }

  // Step 2: Find end boundary — next production
  for (let j = reviewsStart; j < lines.length; j++) {
    const raw = lines[j];
    const trimmed = raw.trim();

    // Method C: the next production's info page (see INDEX_SUFFIX above).
    if (PRODUCTION_INFO_LINE.test(trimmed)) {
      reviewsEnd = productionHeaderStart(lines, j, reviewsStart);
      break;
    }

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

        let fullText = cutAtProductionHeader(textLines).map(l => l.trim()).filter(l => l).join('\n');
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

        let fullText = cutAtProductionHeader(textLines).map(l => l.trim()).filter(l => l).join('\n');
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

module.exports = {
  DATE_LONG,
  DATE_SHORT,
  isDateLine,
  parseShortDate,
  cutAtProductionHeader,
  hasProductionHeaderBleed,
  parsePdfReviews,
  parseRawPdfReviews,
};
