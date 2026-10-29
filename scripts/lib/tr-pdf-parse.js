/**
 * Theatre Record PDF review parsers, extracted from extract-theatre-record.js
 * (CLAUDE.md rule 15) so they can be tested against real pdftotext output.
 */

// ─── PDF review parser ───
// Parses reviews from pdftotext output. Reviews follow pattern:
// OUTLET NAME (ALL CAPS) → date line → critic name → review text
// Date formats: "18 May 2021" (post-2019) or "21.12.17" (pre-2019)
const DATE_LONG = /^\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}$/;
const DATE_SHORT = /^\d{1,2}\.\d{1,2}\.\d{2,4}$/;
const isDateLine = (line) => DATE_LONG.test(line) || DATE_SHORT.test(line);

function parseShortDate(dateStr) {
  // "21.12.17" → "2017-12-21", "15.03.99" → "1999-03-15"
  const [d, m, y] = dateStr.split('.');
  const yearNum = parseInt(y, 10);
  const fullYear = y.length === 4 ? yearNum : yearNum >= 80 ? 1900 + yearNum : (yearNum > 30 ? 1900 + yearNum : 2000 + yearNum);
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

// pdftotext ends each page with a form feed glued to the next page's first line
// ("...last words\fTHE WINTER'S TALE"), which hid a page-top production caption
// from every caps-line check (BRO-6287). Treat the form feed as a line break.
const splitPdfLines = (text) => String(text).split(/\n|\f/);

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

// 2017-18 issues print the bare masthead ("GUARDIAN", "INDEPENDENT", "METRO
// (LONDON)"); 2019+ print "THE GUARDIAN". Compare on the masthead alone
// (BRO-6127: the 2018 Pressure/The Band reviews were dropped for want of it).
const outletKey = (t) => t.replace(/\s*\([^)]*\)\s*$/, '').replace(/^THE\s+/, '');
const KNOWN_OUTLET_KEYS = new Set([...KNOWN_OUTLETS_UPPER].map(outletKey));
// BRO-6287: a bare masthead only counts when it is not also a plausible
// production title ("THE SUN" is an outlet, "SUN" or "LIST" is a show); those
// keep their exact "THE X" form.
const AMBIGUOUS_BARE_KEYS = new Set(['I', 'SUN', 'LIST', 'STAGE', 'TIMES', 'MIRROR', 'EXPRESS', 'STANDARD']);
const isKnownOutletLine = (t) => KNOWN_OUTLETS_UPPER.has(t)
  || (KNOWN_OUTLET_KEYS.has(outletKey(t))
    && (!AMBIGUOUS_BARE_KEYS.has(outletKey(t)) || /^THE\s|\([^)]*\)\s*$/.test(t)));

// `stats` (optional) is filled for the BRO-6097 coverage probe: whether the
// production's Reviews section was found, how many outlet+date headers it
// holds, and how many headers produced no review (text under 50 chars).
function parsePdfReviews(text, showTitle, stats) {
  const lines = splitPdfLines(text);
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

  if (stats) { stats.sectionFound = reviewsStart !== -1; stats.productionCount = productionCount; stats.headers = 0; stats.shortDropped = 0; }
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
        !isDateLine(trimmed) && !isKnownOutletLine(trimmed)) {
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
        if (stats) stats.headers++;
        const foreignCaption = captionOwnedBy(lines, i, showTitle) === false;
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

        let fullText = stripTrailingCaption(cutAtProductionHeader(textLines)).map(l => l.trim()).filter(l => l).join('\n');
        // Clean PDF artifacts
        fullText = fullText.replace(/\nIndex$/m, '').replace(/\nReviews$/m, '').replace(/\n\d+$/m, '').trim();
        if (stats && !foreignCaption && fullText.length <= 50) stats.shortDropped++;
        if (foreignCaption) {
          if (stats) stats.captionDropped = (stats.captionDropped || 0) + 1;
        } else if (fullText.length > 50) {
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
function parseRawPdfReviews(text, showTitle, venue) {
  const lines = splitPdfLines(text);
  const allReviews = [];
  const runs = productionRuns(lines);

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
        const owned = sectionOwnedBy(runs, i, showTitle, lines) === false || venueOwnedBy(lines, i, venue, showTitle) === false || captionForeign(lines, i, showTitle, sectionOwnedBy(runs, i, showTitle, lines), venueOwnedBy(lines, i, venue, showTitle)) ? false : null;
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

        let fullText = stripTrailingCaption(cutAtProductionHeader(textLines)).map(l => l.trim()).filter(l => l).join('\n');
        fullText = fullText.replace(/\nIndex$/m, '').replace(/\nReviews$/m, '').replace(/\n\d+$/m, '').trim();

        if (owned !== false && fullText.length > 200 && fullText.length < 15000) {
          // Cap at 15K chars — longer means multiple reviews concatenated
          allReviews.push({ outlet, date, critic, fullText });
        }
        continue;
      }
    }
    i++;
  }

  return finishPdfReviews(filterByTitle(allReviews, showTitle));
}

// Keep only reviews ABOUT the show: raw and default modes extract every
// review in the volume, so the rest are other productions'.
function filterByTitle(allReviews, showTitle) {
  const titleLower = showTitle.toLowerCase();
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
  return cleaned;
}

function finishPdfReviews(cleaned) {
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

// BRO-6097: plain `pdftotext` (no -layout, no -raw) reads the 3-column
// pre-2020 pages column by column, so a review's outlet caption, headline,
// date and critic are NOT adjacent lines as -raw expects: the date can sit up
// to DEFAULT_DATE_WINDOW lines below the caption and the critic a few lines
// below the date. Captions are limited to KNOWN_OUTLETS_UPPER so a caps
// headline or production title cannot open a review.
const DEFAULT_DATE_WINDOW = 8;
const DEFAULT_CRITIC_WINDOW = 10;
const DEFAULT_MAX_CHARS = 8000;
const CRITIC_PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'di', 'da', 'del', 'du', 'le', 'la', 'bin', 'al', 'ap', 'ten', 'ter']);
// Venue and heading words that fit the name shape ("Theatre Royal Haymarket").
const NOT_A_NAME = new Set(['theatre', 'theater', 'royal', 'playhouse', 'duke', 'palace', 'hall', 'studio', 'studios', 'arts',
  'centre', 'center', 'street', 'road', 'park', 'garden', 'gardens', 'opera', 'house', 'square', 'court', 'globe', 'stage',
  'london', 'hotel', 'club', 'room', 'vic', 'bridge', 'wharf', 'lane', 'online', 'review', 'reviews', 'index', 'cast',
  'creative', 'previews', 'press', 'night', 'closes', 'opens', 'running', 'time', 'performed', 'musical', 'play', 'revival']);
const NAME_TOKEN = /^[A-Z][A-Za-z'’.-]+$/;
const isCriticLine = (l) => {
  const t = l.split(' ');
  if (t.length < 2 || t.length > 5 || l === l.toUpperCase()) return false;
  if (!NAME_TOKEN.test(t[0]) || !NAME_TOKEN.test(t[t.length - 1])) return false;
  return t.every(w => (NAME_TOKEN.test(w) || CRITIC_PARTICLES.has(w)) && !NOT_A_NAME.has(w.toLowerCase()));
};
// A short caps or unpunctuated line right before another review's date is that
// review's headline or caption, not this review's prose.
const isHeadlineish = (l) => l.length <= 60 && !/[.!?"”]$/.test(l);

// Default mode interleaves a review's lines with its neighbours' (headline
// fragments come first), so the first-300-chars check of filterByTitle drops
// real reviews. The cut at the next date/caption already bounds each review to
// one piece, so a mention of the title anywhere in it is the signal.
const TITLE_STOP = new Set(['the', 'and', 'for', 'from', 'with', 'a', 'an', 'at', 'in', 'on', 'of', 'to']);
function mentionsTitle(fullText, showTitle) {
  const text = fullText.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const words = showTitle.toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !TITLE_STOP.has(w));
  if (!words.length) return false;
  const count = (w) => (text.match(new RegExp(`\\b${w}\\b`, 'g')) || []).length;
  if (words.length === 1) {
    const w = words[0];
    const n = count(w);
    if (w.length <= 4 || /^\d+$/.test(w)) return n >= 3;
    if (n >= 2) return true;
    // A single mention only counts when written as a proper name next to theatre context.
    const cap = new RegExp(`\\b${w[0].toUpperCase()}${w.slice(1)}\\b`).test(fullText);
    return n === 1 && cap && /\b(production|theatre|theater|stage|cast|directed|revival|musical|opening|premiere|staging)\b/i.test(fullText);
  }
  // Titles made of numbers or tiny words ("9 to 5") match ordinary prose, so each word must recur.
  if (words.every(w => w.length <= 2 || /^\d+$/.test(w))) return words.every(w => count(w) >= 3);
  return words.filter(w => count(w) > 0).length >= Math.ceil(words.length * 0.7);
}

function parseDefaultPdfReviews(text, showTitle, venue) {
  const lines = splitPdfLines(text).map(l => l.trim());
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isKnownOutletLine(lines[i])) continue;
    for (let k = i + 1; k <= Math.min(i + DEFAULT_DATE_WINDOW, lines.length - 1); k++) {
      if (isKnownOutletLine(lines[k])) break;
      if (isDateLine(lines[k])) { markers.push({ start: i, dateIdx: k }); break; }
    }
  }

  const all = [];
  const runs = productionRuns(lines);
  markers.forEach((m, idx) => {
    let end = idx + 1 < markers.length ? markers[idx + 1].start : lines.length;
    // Any further date line is another review's header (an outlet we do not
    // list, or a caption whose date sits beyond the window): cut there and drop
    // the caption and headline lines that precede it.
    for (let k = m.dateIdx + 1; k < end; k++) {
      if (!isDateLine(lines[k])) continue;
      let cut = k;
      for (let n = 0; n < 6 && cut > m.dateIdx + 1 && (!lines[cut - 1] || isHeadlineish(lines[cut - 1])); n++) cut--;
      end = cut;
      break;
    }
    let critic = '';
    let criticIdx = -1;
    for (let k = m.dateIdx + 1; k < Math.min(m.dateIdx + 1 + DEFAULT_CRITIC_WINDOW, end); k++) {
      if (isCriticLine(lines[k])) { critic = lines[k]; criticIdx = k; break; }
    }
    const body = lines.slice(m.start + 1, end)
      .map((l, off) => ({ l, abs: m.start + 1 + off }))
      .filter(({ l, abs }) => l && abs !== m.dateIdx && abs !== criticIdx && !/^(Index|Reviews|\d+)$/.test(l))
      .map(({ l }) => l);
    const fullText = stripTrailingCaption(cutAtProductionHeader(body)).join('\n').trim();
    if (fullText.length > 200 && fullText.length < DEFAULT_MAX_CHARS && sectionOwnedBy(runs, m.start, showTitle, lines) !== false && venueOwnedBy(lines, m.start, venue, showTitle) !== false && !captionForeign(lines, m.start, showTitle, sectionOwnedBy(runs, m.start, showTitle, lines), venueOwnedBy(lines, m.start, venue, showTitle))) {
      all.push({ outlet: lines[m.start], date: lines[m.dateIdx], critic, fullText });
    }
  });
  return finishPdfReviews(all.filter(r => mentionsTitle(r.fullText, showTitle)));
}

// "14.10.16" and "14 October 2016" both reduce to the ISO day (unparseable
// dates stay as written, so they only dedupe against themselves).
const dateKey = (d) => {
  if (DATE_SHORT.test(d)) return parseShortDate(d);
  const t = Date.parse(`${d} UTC`);
  return isNaN(t) ? d : new Date(t).toISOString().slice(0, 10);
};
const lastName = (c) => String(c || '').trim().split(/\s+/).pop().toLowerCase();

// Add default-mode reviews to the layout/raw ones. Same outlet + day is the
// same review when either side lacks a critic or the surnames agree; two named
// critics from one outlet on one day are both kept.
function mergeDefaultReviews(existing, incoming) {
  const out = existing.slice();
  for (const r of incoming) {
    const k = dateKey(r.date);
    const dup = out.some(e => e.outlet === r.outlet && dateKey(e.date) === k
      && (!e.critic || !r.critic || lastName(e.critic) === lastName(r.critic)));
    if (!dup) out.push(r);
  }
  return out;
}

// BRO-6097: layout skeleton of a paid TR issue. Short lines (outlet, date,
// critic, headings) keep their capitals; prose lines and every lowercase or
// non-ASCII letter become 'x', so structure survives and no prose does.
function maskPdfText(text, keepWords) {
  const keep = new Set(keepWords.map(w => w.toLowerCase()));
  return text.split('\n').map(line => {
    // Short lines carry the structure (outlet, date, critic, headings); long
    // lines are prose, so their capitals go too. Non-ASCII letters always go.
    const prose = line.trim().length > 70;
    return line.replace(/[\p{L}]+/gu, w => (keep.has(w.toLowerCase()) ? w
      : w.replace(/[\p{L}]/gu, c => (/[A-Z]/.test(c) && !prose ? c : 'x'))));
  }).join('\n');
}


// BRO-6154: -raw and default text carry no "Previews / Opens" line, but every
// production starts with "<VENUE>\n<run dates>\n<TITLE>", e.g.
// "03 October - 02 December 2017". A review belongs to the latest such block
// above it. The issue's running header ("Theatre Record 18 September - 17
// October 2017") starts with letters, so a line that begins with the day is
// the production's run. Before this, a common-word title (All About Eve,
// After Life) matched the prose of whichever production followed ours.
const RUN_DATES_LINE = /^\d{1,2}( [A-Za-z]+)?( \d{4})? [\u2013-] \d{1,2} [A-Za-z]+ \d{4}$/;
const isCapsTitle = (l) => /[A-Z]/.test(l) && l === l.toUpperCase() && l.length > 2 && !isDateLine(l) && !/[.,;:]$/.test(l) && !isKnownOutletLine(l);

const { trTitleMatches } = require('./tr-production-pick');
const { foldDiacritics } = require('./title-match');

// BRO-6302: a block title sharing a word with ours stays "unknown" (TR spells
// titles its own way), but common title words do not count: KING LEAR kept
// EXIT THE KING's and THE KING AND I's reviews, LOVE LETTERS kept LOVE BITES'.
const GENERIC_TITLE_WORDS = new Set(['king', 'queen', 'prince', 'princess', 'lady', 'man', 'men', 'woman', 'women', 'girl', 'girls', 'boy', 'boys', 'love', 'night', 'nights', 'day', 'days', 'life', 'death', 'light', 'dark', 'great', 'little', 'old', 'new', 'one', 'two', 'three', 'last', 'first', 'play', 'show', 'story', 'house', 'home', 'world', 'time', 'christmas', 'that', 'this', 'into', 'what', 'when', 'who', 'all', 'not', 'are', 'was', 'you', 'your', 'our', 'his', 'her', 'broken', 'come', 'away', 'goes', 'over', 'out', 'way', 'wild', 'heart', 'blood', 'city', 'street', 'road', 'big', 'good', 'bad', 'young', 'black', 'white', 'red', 'blue', 'green']);
// A long title wraps over caps lines; a line-end hyphen joins the halves of a
// wrapped word ("A MIDSUM-" / "MER NIGHT'S DREAM").
const joinWrapped = (parts) => parts.join(' ').replace(/(\w)-\s+(?=\w)/g, '$1');
const titleWords = (t) => foldDiacritics(String(t)).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !TITLE_STOP.has(w));
// A block title of two or more words that are all in our title, or one that
// opens it, is TR's short form of it ("ALL IN" for All In: Comedy About Love).
function sharesTitleWord(blockTitle, showTitle) {
  const all = titleWords(showTitle);
  const theirs = titleWords(joinWrapped([blockTitle]));
  const norm = (t) => foldDiacritics(String(t)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (theirs.length && theirs.every(w => all.includes(w))
    && (theirs.length >= 2 || norm(showTitle).startsWith(`${norm(joinWrapped([blockTitle]))} `))) return true;
  const distinctive = all.filter(w => !GENERIC_TITLE_WORDS.has(w));
  if (distinctive.length) return theirs.some(w => distinctive.includes(w));
  // A title of common words only (The King and I): a block naming something
  // else as well (KING LEAR, EXIT THE KING) is another show.
  return theirs.some(w => all.includes(w)) && theirs.every(w => all.includes(w) || GENERIC_TITLE_WORDS.has(w));
}

function productionRuns(lines) {
  const runs = [];
  lines.forEach((l, i) => {
    if (!RUN_DATES_LINE.test(l.trim())) return;
    // A long title wraps over up to three caps lines.
    const parts = [];
    for (let k = i + 1, seen = 0; k < Math.min(i + 6, lines.length) && seen < 4; k++) {
      const t = lines[k].trim();
      if (!t) continue;
      seen++;
      if (isCapsTitle(t) && parts.length < 3) parts.push(t); else if (parts.length) break;
    }
    const title = parts.length ? joinWrapped(parts) : null;
    runs.push({ line: i, title });
  });
  return runs;
}

// true: the review sits under our production's block; false: under another
// production's; null: the block cannot be told (no run line above, no title).
function sectionOwnedBy(runs, lineIdx, showTitle, lines) {
  let run = null;
  for (const r of runs) { if (r.line <= lineIdx) run = r; else break; }
  if (!run || !run.title) return null;
  if (trTitleMatches(run.title, showTitle)) return true;
  // TR spells titles its own way ("PRIDE AND PREJUDICE* (*SORT OF)"), so a block
  // that shares a real word with ours stays "unknown" instead of being dropped.
  if (sharesTitleWord(run.title, showTitle)) return null;
  // Our own run line may have been missed ("onwards", "01-28 February"): when our
  // title appears as a caps line after the other block's run line, we cannot tell.
  if (lines) {
    for (let k = run.line + 1; k < lineIdx && k < lines.length; k++) {
      const t = lines[k].trim();
      if (isCapsTitle(t) && trTitleMatches(t, showTitle)) return null;
    }
  }
  return false;
}

// BRO-6287: the next review's caption sits right above its outlet line, so it
// lands at the tail of the review before it. Drop those trailing caps lines.
function stripTrailingCaption(textLines) {
  const out = textLines.slice();
  const last = () => String(out[out.length - 1]).trim();
  while (out.length && !last()) out.pop();
  let n = 0;
  while (out.length && n < 3 && isCapsTitle(last())) { out.pop(); n++; while (out.length && !last()) out.pop(); }
  if (n && out.length && /^Reviews?$/.test(last())) out.pop();
  return out;
}

// BRO-6287: 2020+ issues print each review under a caps caption naming its own
// production ("SOUTH PACIFIC" above "FINANCIAL TIMES / 16 July 2021"), with no
// run-dates line or venue header for the other guards to read. Looks at the
// nearest non-blank line above the outlet line (up to two blank lines skipped):
// true when it names our show, false when it names another one, null when
// there is no caps caption. A caption sharing a real word with our title stays
// null, as in sectionOwnedBy (TR spells titles its own way).
// `inherit` (raw and default modes): a review with no caption of its own sits in
// the block the nearest review above it belongs to, because TR prints the
// caption only on a block's first review and again at each page top. Without
// this a foreign block's second and later reviews (no caption directly above)
// were read as unknown and kept (BRO-6287: South Pacific's FT review filed
// under Be More Chill).
const CAPTION_CHAIN_MAX = 30;
const CAPTION_LOOKBACK = 700;
function captionOwnedBy(lines, outletIdx, showTitle, { inherit = false } = {}, depth = 0) {
  let k = outletIdx - 1;
  while (k >= 0 && !String(lines[k]).trim() && outletIdx - k <= 2) k--;
  if (k < 0) return null;
  const parts = [];
  // A long title wraps over up to three caps lines.
  for (; k >= 0 && parts.length < 3; k--) {
    const t = String(lines[k]).trim();
    if (!isCapsTitle(t)) break;
    parts.unshift(t);
  }
  if (!parts.length) return inherit ? inheritedCaptionOwner(lines, outletIdx, showTitle, depth) : null;
  // The first half of a wrapped masthead ("INTERNATIONAL" / "NEW YORK TIMES").
  if (parts.length === 1 && /^(INTERNATIONAL|SUNDAY|DAILY|EVENING|THE)$/.test(parts[0])) return null;
  // An outlet we do not list ("WHATSONSTAGE.COM") is not a production caption.
  if (parts.some(t => /\.(COM|CO\.UK|ORG|NET|UK)\b/.test(t))) return null;
  const caption = joinWrapped(parts);
  if (trTitleMatches(caption, showTitle)) return true;
  if (sharesTitleWord(caption, showTitle)) return null;
  return false;
}

// Ownership of a caption-less review: that of the previous outlet+date header.
// The walk gives up (unknown) at anything that could start a different block
// the guards can read better: a run-dates line, a production info line, or a
// caps line that is, wraps into, or shares a word with our title.
function inheritedCaptionOwner(lines, outletIdx, showTitle, depth) {
  if (depth >= CAPTION_CHAIN_MAX) return null;
  const memo = inheritMemo(lines, showTitle);
  if (memo.has(outletIdx)) return memo.get(outletIdx);
  const nearOurs = (t) => trTitleMatches(t, showTitle) || sharesTitleWord(t, showTitle);
  let result = null;
  for (let k = outletIdx - 1; k >= 0 && outletIdx - k <= CAPTION_LOOKBACK; k--) {
    const t = String(lines[k]).trim();
    if (RUN_DATES_LINE.test(t) || PRODUCTION_INFO_LINE.test(t)) break;
    if (isCapsTitle(t)) {
      const wrapped = [t, `${t} ${String(lines[k + 1]).trim()}`, `${t} ${String(lines[k + 1]).trim()} ${String(lines[k + 2]).trim()}`];
      if (wrapped.some(w => /^[^a-z]+$/.test(w) && nearOurs(w))) break;
    }
    if (isReviewHeaderLine(lines, k)) {
      result = captionOwnedBy(lines, k, showTitle, { inherit: true }, depth + 1);
      break;
    }
  }
  memo.set(outletIdx, result);
  return result;
}

// An outlet line with its date on the next line, or (default mode) a listed
// outlet with the date up to DEFAULT_DATE_WINDOW lines below.
function isReviewHeaderLine(lines, k) {
  const t = String(lines[k]).trim();
  if (t === t.toUpperCase() && t.length > 3 && /^[A-Z]/.test(t) && isDateLine(String(lines[k + 1] || '').trim())) return true;
  if (!isKnownOutletLine(t)) return false;
  for (let j = k + 1; j <= Math.min(k + DEFAULT_DATE_WINDOW, lines.length - 1); j++) {
    const u = String(lines[j]).trim();
    if (isKnownOutletLine(u)) return false;
    if (isDateLine(u)) return true;
  }
  return false;
}

const inheritMemos = new WeakMap();
function inheritMemo(lines, showTitle) {
  let byTitle = inheritMemos.get(lines);
  if (!byTitle) { byTitle = new Map(); inheritMemos.set(lines, byTitle); }
  if (!byTitle.has(showTitle)) byTitle.set(showTitle, new Map());
  return byTitle.get(showTitle);
}

// A caption verdict from inheritance is a guess about the block above; a
// positive section or venue match for the review outranks it.
function captionForeign(lines, idx, showTitle, sec, ven) {
  if (sec === true || ven === true) return false;
  return captionOwnedBy(lines, idx, showTitle, { inherit: true }) === false;
}

// 2019+ issues have no run-dates lines; each production page opens with a
// "Previews / Opens" header whose caps line names the venue ("WYNDHAM'S THEATRE",
// "LONDON, YOUNG VIC THEATRE"). A review under a header naming a theatre that
// shares no word with the show's venue belongs to another production.
const VENUE_STOP = new Set(['the', 'theatre', 'theater', 'royal', 'london', 'national', 'reviews', 'review', 'from', 'printed', 'media', 'are', 'reproduced', 'pages', 'following', 'playscript', 'synopsis']);
// Venues renamed after the issue was printed: shows.json carries today's name.
const VENUE_ALIASES = [['stoppard', 'duke', 'york'], ['gillian', 'lynne', 'new', 'london'], ['sondheim', 'queen'], ['harold', 'pinter', 'comedy'], ['lyttelton', 'lyttleton', 'national'], ['noel', 'coward', 'albery'], ['lyric', 'sondheim']];
const venueWords = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/['\u2019]s\b/g, 's').split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !VENUE_STOP.has(w));
const wordsClose = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5))));
const sectionCache = new WeakMap();
function venueOwnedBy(lines, lineIdx, venue, showTitle) {
  const ours = venueWords(venue);
  if (!ours.length) return null;
  let sections = sectionCache.get(lines);
  if (!sections) { sections = productionSections(lines); sectionCache.set(lines, sections); }
  let sec = null;
  for (const x of sections) { if (x.line <= lineIdx) sec = x; else break; }
  if (!sec) return null;
  const theirs = venueWords(sec.title);
  if (!theirs.length) return null;
  // The header also carries the production title; its words count as ours.
  const mine = [...ours, ...venueWords(showTitle)];
  if (theirs.some(w => mine.some(o => wordsClose(w, o)))) return true;
  // Renamed theatre: the header and shows.json each hit the same alias group.
  const hits = (ws, g) => ws.some(w => g.some(x => wordsClose(w, x)));
  if (VENUE_ALIASES.some(g => hits(theirs, g) && hits(ours, g))) return true;
  return false;
}

// BRO-6154 diagnostic: which production's section of the issue each parsed
// review sits in. Structure only (production titles, outlets, dates, line
// numbers), never review prose, so the result can be committed in a probe file.
function productionSections(lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (!PRODUCTION_INFO_LINE.test(l.trim())) return;
    const start = productionHeaderStart(lines, i);
    const title = lines.slice(start, i).map(x => stripIndexSuffix(x.trim())).filter(t => t && t !== 'Goto').join(' ');
    out.push({ line: i, title });
  });
  return out;
}

function locateReviews(text, reviews, showTitle) {
  const lines = splitPdfLines(text);
  const trimmed = lines.map(l => l.trim());
  const runs = productionRuns(lines);
  const sections = productionSections(lines);
  const mk = (x) => maskPdfText(x, []).trim().slice(0, 60);
  return reviews.map(r => {
    const first = String(r.fullText || '').split('\n')[0].trim().slice(0, 40);
    const line = first.length >= 15 ? trimmed.findIndex(t => t.startsWith(first)) : -1;
    let section = null;
    for (const x of sections) if (x.line <= line) section = x.title; else break;
    let run = null;
    for (const x of runs) { if (x.line <= line) run = x; else break; }
    const tail = String(r.fullText || '').split('\n').filter(Boolean).slice(-2).map(mk);
    // BRO-6287: the masked 14 lines above the review's first text line (outlet,
    // date, critic, caption), so a layout whose
    // production boundaries the guards miss can be read without any prose.
    const before = line < 0 ? [] : trimmed.slice(Math.max(0, line - 14), line).map(mk);
    return { outlet: r.outlet, date: r.date, line, section, runTitle: run ? run.title : null, tail, before, owned: line < 0 ? null : sectionOwnedBy(runs, line, showTitle, lines) };
  });
}

// BRO-6507: which lines of a volume PDF the committed skeleton keeps. A
// title also appears in the issue's contents and index (and in other
// productions' prose), so the first 8 hits alone never reached the review page
// for No Man's Land. Lines that are the bare production title come first.
const titleKey = (t) => foldDiacritics(String(t || '')).toUpperCase().replace(/[\u2018\u2019']/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
function skeletonKeepLines(lines, title, { maxHits = 8, radius = 110 } = {}) {
  const key = titleKey(title);
  if (!key) return new Set();
  const loose = new RegExp(String(title).replace(/[^A-Za-z0-9]+/g, '.{0,3}').replace(/^\.\{0,3\}|\.\{0,3\}$/g, ''), 'i');
  const exact = [];
  const other = [];
  lines.forEach((l, i) => {
    const t = stripIndexSuffix(l.trim());
    if (titleKey(t) === key) exact.push(i);
    else if (loose.test(l)) other.push(i);
  });
  const picked = [...exact.slice(0, maxHits), ...other.slice(0, Math.max(0, maxHits - exact.length))];
  const keep = new Set();
  for (const i of picked) for (let j = Math.max(0, i - radius); j <= Math.min(lines.length - 1, i + radius); j++) keep.add(j);
  return keep;
}

module.exports = {
  skeletonKeepLines,
  productionRuns,
  sharesTitleWord,
  captionOwnedBy,
  isKnownOutletLine,
  sectionOwnedBy,
  venueOwnedBy,
  productionSections,
  locateReviews,
  maskPdfText,
  DATE_LONG,
  DATE_SHORT,
  isDateLine,
  parseShortDate,
  cutAtProductionHeader,
  hasProductionHeaderBleed,
  parsePdfReviews,
  parseRawPdfReviews,
  parseDefaultPdfReviews,
  mentionsTitle,
  mergeDefaultReviews,
  dateKey,
};
