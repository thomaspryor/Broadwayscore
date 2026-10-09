'use strict';
/**
 * Which production a fetched TodayTix show page is about (BRO-4851).
 *
 * TodayTix recycles numeric show IDs, so a stored ID can serve a different
 * show's page; that is why auto-fix-show-data.js sends every TodayTix synopsis
 * through the LLM wrong-show verifier. The verifier rejects any record too
 * sparse to confirm, which is every West End historical row (no cast or
 * creative team yet), so correct pages were thrown away (12 of 12 in run
 * 37802546159, e.g. The Shitheads at the Royal Court).
 *
 * The page carries its own identity in __NEXT_DATA__ props.pageProps.product
 * (id, displayName, venue.name, startingDate, closingDate). Only that object is
 * read: a recursive search could hit a related-shows carousel and vouch for a
 * recycled page. A page whose id, title, venue and dates all agree with the
 * record is this production.
 *
 * Pure, no I/O (CLAUDE.md §15); scripts/lib/todaytix-page-identity.test.mjs.
 */

// venue-write-guard-ok: reads a TodayTix page's venue name for comparison only; nothing here writes shows.json.
const { normalizeTitle } = require('./title-normalization');
const { venuesMatch } = require('./image-source-match');
const { PLOT_SIGNAL_RE } = require('./synopsis-validation');

// Sentences in product.about that are not story: selling, star quotes, age /
// running-time / content notes, cast and team lists (the junk class that run
// 37818726628 saved from the scraped-paragraph path).
const NON_STORY_SENTENCE_RE = /todaytix|\btickets?\b|\bbook (now|your|tickets|today|early)\b|★|☆|\bstars?\b.*(guardian|times|telegraph|stage|standard|whatsonstage)|age guidance|\bages? \d|running time|\bcontent warning|\bcast\b.*\b(includes?|including|are|is|features?)\b|\bcreative team\b|\bdirected by\b.*,.*,/i;
// Production news and billing, not story (WE historical 2023-24, BRO-4884:
// "currently playing at Wyndham's ... has just won rave reviews", "Sheridan
// Smith stars in ...", "one of nine shows in the theatre's 2024 season",
// "returns to the West End this May", "Hamnet premiered in April at the Swan").
// Phase C 2023-24: "Olivier Award nominee ... reprise their leading roles" (A Mirror),
// "This groundbreaking new production expertly balances ..." (Bacchae). Not
// "transports audiences": it leads story sentences ("... to 1950s Buffalo, where").
const PRODUCTION_NEWS_RE = /\b(currently|now) (playing|performing|running)\b|\bis (playing|performing) at\b|\brave reviews\b|\b(award|olivier|tony|bafta)[- ]win|\bstar(s|ring)? (in|as)\b|\b(will be|is) directed\b|\bdirected by\b|\bartistic director\b|\breturns? to (london|the west end)\b|\b(transfers?|promoted) to the west end\b|\bwest end (debut|transfer|premiere)\b|\b(strictly )?limited (run|season|time|engagement)\b|\b\d+-week (run|season)\b|\bpremiered\b|\bgraced the stage\b|\bsold-out\b|\bmaking (her|his|their) .*debut\b|\breprises? (his|her|their) (\w+ )?roles?\b|\b(award|olivier|tony|bafta)[- ]nomin|\bthis (\w+ ){0,3}production\b/i;
// isValidSynopsis rejects text opening this way; such sentences are pitch, not plot.
const MARKETING_OPENER_RE = /^(See |Get tickets|Don't miss|Experience the|Come discover|Catch |Book |Have you ever|Immerse yourself|Audiences will|Fly to |Attend the )/i;
const MAX_ABOUT_CHARS = 700;

/**
 * A quotation that is a pull quote or soundbite, not a quoted title: an
 * unbalanced quote (split across sentences), a quoted span over 4 words, or a
 * short quote followed by an attribution ("Utterly brilliant" – The Guardian).
 * A quoted title ("After the Act" is a verbatim musical...) is story.
 */
function isPullQuote(sentence) {
  const marks = (sentence.match(/"/g) || []).length;
  if (marks === 0) return false;
  if (marks % 2 === 1) return true;
  for (const m of sentence.matchAll(/"([^"]*)"(\s*[–—-]\s*[A-Z(]|\s*\()?/g)) {
    if (m[1].trim().split(/\s+/).length > 4 || m[2]) return true;
  }
  return false;
}

/**
 * Why a sentence is not story, or null. Shared by cleanTodaytixAbout and the
 * season audit (scripts/audit-we-historical-season.js) so both apply one rule.
 * @returns {'pull-quote'|'selling-or-list'|'production-news'|'pitch-opener'|null}
 */
function nonStoryReason(sentence) {
  const s = String(sentence || '').replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").trim();
  if (!s) return null;
  if (isPullQuote(s)) return 'pull-quote';
  if (NON_STORY_SENTENCE_RE.test(s)) return 'selling-or-list';
  if (PRODUCTION_NEWS_RE.test(s)) return 'production-news';
  if (MARKETING_OPENER_RE.test(s)) return 'pitch-opener';
  return null;
}

/**
 * product.about reduced to its story sentences: markdown/HTML stripped,
 * non-story sentences dropped, cut at a sentence end. '' when nothing is left
 * or no sentence reads as plot (PLOT_SIGNAL_RE), so the caller falls back to
 * the verified path.
 */
function cleanTodaytixAbout(text) {
  const plain = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#+|[-*•])\s+/gm, '')
    .replace(/[*_]+/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [];
  const kept = [];
  let len = 0;
  for (const raw of sentences) {
    const sentence = raw.trim().replace(/^["'\s]+/, '');
    // Pull quotes / soundbites (Unicorn: "...very, very funny," Nicola Walker
    // said), selling, billing and pitch openers are not plot.
    if (!sentence || nonStoryReason(sentence)) continue;
    if (len + sentence.length + 1 > MAX_ABOUT_CHARS) break;
    kept.push(sentence);
    len += sentence.length + 1;
    if (kept.length >= 4) break;
  }
  const out = kept.join(' ');
  return out && PLOT_SIGNAL_RE.test(out) ? out : '';
}


/** @returns {{id: string, title: string, venue: string|null, start: string|null, end: string|null}|null} */
function extractTodaytixPageIdentity(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''));
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const p = data && data.props && data.props.pageProps && data.props.pageProps.product;
  if (!p || p.id == null || !p.displayName) return null;
  return {
    id: String(p.id),
    title: String(p.displayName),
    venue: (p.venue && p.venue.name) || null,
    start: p.startingDate || null,
    end: p.closingDate || null,
    about: cleanTodaytixAbout(p.about || p.shortDescription || ''),
  };
}

/**
 * True only when the page is this production: same TodayTix id as the one we
 * asked for, same title, same venue, and (when both sides carry dates) runs
 * that overlap. Same title + venue + overlapping dates still allows a page for
 * a returning run of the same staging; its plot is the same, so for synopsis
 * and creative team that is acceptable.
 */
function todaytixPageMatchesShow(identity, show, expectedId) {
  if (!identity || !show) return false;
  if (expectedId == null || identity.id !== String(expectedId)) return false;
  // Exact after normalization: titlesMatch's suffix stripping treats
  // "Shitheads II" as "The Shitheads", too loose to vouch for a page.
  if (normalizeTitle(identity.title) !== normalizeTitle(show.title)) return false;
  if (!identity.venue || !venuesMatch(identity.venue, show.venue)) return false;
  const showStart = show.previewsStartDate || show.openingDate || null;
  const showEnd = show.closingDate || null;
  if (identity.start && showEnd && identity.start > showEnd) return false;
  if (identity.end && showStart && identity.end < showStart) return false;
  return true;
}

module.exports = { extractTodaytixPageIdentity, todaytixPageMatchesShow, cleanTodaytixAbout, nonStoryReason };
