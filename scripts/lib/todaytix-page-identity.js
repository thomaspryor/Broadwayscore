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
const { PLOT_SIGNAL_RE, isAudiencePitch, BULLET_LIST_RE } = require('./synopsis-validation');

// Sentences in product.about that are not story: selling, star quotes, age /
// running-time / content notes, cast and team lists (the junk class that run
// 37818726628 saved from the scraped-paragraph path).
const NON_STORY_SENTENCE_RE = /\bsubject matters? (?:in|of) (?:the|this) (?:show|production|play)\b|todaytix|\btickets?\b|\bbook (now|your|tickets|today|early)\b|★|☆|\bstars?\b.*(guardian|times|telegraph|stage|standard|whatsonstage)|age guidance|\bages? \d|running time|\bcontent warning|\bcast\b.*\b(includes?|including|are|is|features?)\b|\bcreative team\b|\bdirected by\b.*,.*,/i;
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
// 2018-19 (BRO-4884): UK copy quotes critics in single quotes and names the
// paper in brackets ("With 'spellbinding, stripped-back staging' (Financial
// Times)"), which isPullQuote's double-quote check never saw.
const PRESS_ATTRIBUTION_RE = /\((?:the )?(?:financial times|ft|independent|i|inews|times|sunday times|telegraph|daily telegraph|sunday telegraph|guardian|observer|evening standard|standard|stage|whatsonstage|what's on stage|time out|daily mail|mail on sunday|metro|daily express|express|sun|mirror|radio times|spectator|new statesman|arts desk|new york times|variety|chicago tribune|hollywood reporter|broadwayworld|broadway world)\)/i;
const SINGLE_QUOTE_ATTRIBUTED_RE = /(?:^|[\s(])'[^']{3,}'\s*(?:\(|[–—-]\s*[A-Z])/;
// Copy that talks to the audience ("Welcome to the Rock! ... invites you into",
// "Join us on this emotional roller-coaster") is selling, not story. The rule
// lives in synopsis-validation.js (isAudiencePitch) so the write-time
// validator and this cleaner cannot drift apart (BRO-5063).
// Billing that the production-news list missed: "X (Evita, Cats) as Gloria",
// "James McArdle takes the title role", "The show features the spectacular
// music of TAKE THAT", "one of the most successful musical theatre tours ever".
const BILLING_RE = /\)\s+as\s+(the\s+)?[A-Z]|\btakes? (on )?the (title|lead|leading) role\b|\bthe show features the (\w+ ){0,2}(music|songs|hits)\b|\bmost successful\b.*\b(tours?|musicals?|shows?|productions?)\b/i;
// A sentence that starts on a scrap of the previous one, closes a bracket it
// never opened, or is a few words around a quote mark ("Beat' and '1-2-3'.").
// A contraction is not a quote mark: "It's the future." is story.
function isFragment(s) {
  if (/^[,;:)\]–—-]/.test(s)) return true;
  if ((s.match(/\)/g) || []).length > (s.match(/\(/g) || []).length) return true;
  return s.split(/\s+/).length < 5 && /"|(?<![A-Za-z])'|'(?![A-Za-z])/.test(s);
}
// Initials and titles end in a full stop that does not end the sentence
// ("F. Murray Abraham", "Dr. Seuss").
// A run of initials ("P.T. Barnum") counts too: the sentence matcher below
// skips any text whose end punctuation is not followed by a space, so "P."
// lost The Greatest Showman's opening sentence (BRO-5063).
const ABBREV_DOT_RE = /\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Capt|Gen|Lt|[A-Z])\.(?=\s|[A-Z]\.)/g;
// After a dropped sentence, a sentence leaning on it ("That meant a sudden
// influx of 7,000 visitors") has lost what it refers to.
const ANAPHORIC_OPENER_RE = /^(That|This|These|Those|It|They)\b/;
const PAREN_TITLE_RE = /\(\s*"[^"]*"(?:\s*\/\s*"[^"]*")*\s*\)/g;
// Private-use stand-ins for punctuation that must not end a sentence.
const HOLD = { '.': '\uE000', '!': '\uE001', '?': '\uE002', '…': '\uE003' };
const RESTORE = { '\uE000': '.', '\uE001': '!', '\uE002': '?', '\uE003': '...' };
const HOLD_RE = /[\uE000-\uE003]/g;
// Hold the title's punctuation wherever the title appears (any case) and the
// sentence carries on after it: not at the end of the text, not before a
// capitalised word.
function holdTitle(text, name) {
  const lower = text.toLowerCase();
  const needle = name.toLowerCase();
  let out = '';
  let pos = 0;
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) {
    const end = i + needle.length;
    if (/^(\s*$|\s+["'(]?[A-Z])/.test(text.slice(end))) continue;
    out += text.slice(pos, i) + text.slice(i, end).replace(/[.!?]/g, c => HOLD[c]);
    pos = end;
  }
  return out + text.slice(pos);
}
const MAX_ABOUT_CHARS = 700;

/**
 * A quotation that is a pull quote or soundbite, not a quoted title: an
 * unbalanced quote (split across sentences), a quoted span over 4 words, or a
 * short quote followed by an attribution ("Utterly brilliant" – The Guardian).
 * A quoted title ("After the Act" is a verbatim musical...) is story.
 */
function isPullQuote(sentence) {
  // A quoted title in its own brackets is a song or scene cue in plot text
  // ('mourns the start of a new workday ("I Feel Like I'm Not Out of Bed
  // Yet")', BRO-5063), never a press quote, which puts the outlet in the
  // brackets after the quote instead.
  sentence = sentence.replace(PAREN_TITLE_RE, '');
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
 * @returns {'pull-quote'|'selling-or-list'|'production-news'|'pitch-opener'|'fragment'|null}
 */
function nonStoryReason(sentence) {
  const s = String(sentence || '').replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").trim();
  if (!s) return null;
  if (isPullQuote(s) || PRESS_ATTRIBUTION_RE.test(s) || SINGLE_QUOTE_ATTRIBUTED_RE.test(s)) return 'pull-quote';
  if (NON_STORY_SENTENCE_RE.test(s) || BILLING_RE.test(s) || BULLET_LIST_RE.test(s)) return 'selling-or-list';
  if (PRODUCTION_NEWS_RE.test(s)) return 'production-news';
  if (MARKETING_OPENER_RE.test(s) || isAudiencePitch(s)) return 'pitch-opener';
  if (isFragment(s)) return 'fragment';
  return null;
}

/**
 * product.about reduced to its story sentences: markdown/HTML stripped,
 * non-story sentences dropped, cut at a sentence end. '' when nothing is left
 * or no sentence reads as plot (PLOT_SIGNAL_RE), so the caller falls back to
 * the verified path.
 */
function cleanTodaytixAbout(text, title) {
  let plain = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#+|[-*•])\s+/gm, '')
    .replace(/[*_]+/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // The show's own title is not a sentence end when the sentence carries on
  // ("Get Schmigadoon! tickets", BRO-5063); at a real sentence end ("... fall
  // for Schmigadoon! They ...") its "!" still ends it.
  const name = String(title || '').trim().replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  if (name && /[.!?]/.test(name)) plain = holdTitle(plain, name);
  // An ellipsis followed by lowercase continues the sentence ("(The New York
  // Times)... if you manage to get out." is one pull-quote sentence).
  plain = plain.replace(/\.{3}(?=\s+[a-z])/g, HOLD['…']);
  const sentences = (plain.replace(ABBREV_DOT_RE, `$1${HOLD['.']}`).match(/[^.!?]+[.!?]+["')\]]*(?=\s|$)/g) || []).map(x => x.replace(HOLD_RE, c => RESTORE[c]));
  const kept = [];
  let len = 0;
  let dropped = false;
  for (const raw of sentences) {
    // A sentence opening on a quote is judged with its mark: half of a pull
    // quote ('"At 27, my dad had escaped ...') is only visible with it, and a
    // quoted title ('"Hamilton" is ...') only balances with it. A stray mark
    // followed by a space ('" Brace Brace is ...') is not an opening quote.
    const whole = raw.trim();
    const sentence = /^"\S/.test(whole) ? whole : whole.replace(/^["'\s]+/, '');
    // Pull quotes / soundbites (Unicorn: "...very, very funny," Nicola Walker
    // said), selling, billing and pitch openers are not plot.
    const reason = nonStoryReason(sentence);
    if (!sentence || reason || (dropped && ANAPHORIC_OPENER_RE.test(sentence))) { dropped = true; continue; }
    dropped = false;
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
    about: cleanTodaytixAbout(p.about || p.shortDescription || '', p.displayName),
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

module.exports = { extractTodaytixPageIdentity, todaytixPageMatchesShow, cleanTodaytixAbout, nonStoryReason, ABBREV_DOT_RE };
