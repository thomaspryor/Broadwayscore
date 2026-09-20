/**
 * Excerpt Validation Module
 *
 * Layer 3: Cross-show excerpt validation (detects excerpts mentioning wrong shows)
 * Layer 3b: Former-cast mention detection (priorRuns reviews naming a
 *           since-departed cast member)
 * Layer 4: Tour review excerpt detection (detects touring production language)
 *
 * Designed for use in rebuild-all-reviews.js selectBestExcerpt() pipeline.
 * Operates in dry-run mode by default (logs but doesn't suppress) until
 * DRY_RUN_CROSS_SHOW=false is set.
 */

const path = require('path');
const fs = require('fs');
const { isWithinPriorRun } = require('./wrong-production-autoclear');

// --- Layer 3: Cross-Show Validation ---

// Titles that are common English words — NEVER match these as cross-show references
// because they appear naturally in review text (e.g., "the company delivers", "beyond doubt")
const COMMON_WORD_TITLES = new Set([
  // Single common words
  'company', 'doubt', 'network', 'proof', 'sweat', 'closer', 'home', 'nine',
  'cats', 'rent', 'once', 'hair', 'big', 'grease', 'chicago', 'fame',
  'oliver', 'pippin', 'annie', 'dreamgirls', 'carousel', 'contact',
  'curtains', 'follies', 'gypsy', 'tommy', 'ragtime', 'purlie',
  'ruined', 'eclipse', 'topdog', 'wings', 'bent', 'betrayal',
  'lobby', 'hero', 'slave', 'wolf', 'power', 'trouble', 'appropriate',
  'on the town', 'the visit', 'the rose', 'the band',
  // Two-word common phrases
  'war paint', 'the trip', 'the year', 'big fish', 'big river',
  'bright star', 'beautiful', 'holiday', 'parade', 'passion',
  'spring', 'summer', 'stomp', 'sunset', 'cabaret',
  // Theater terms that are also show titles — appear constantly in review text
  'the audience', 'master class', 'the performers', 'the present',
  'the price', 'the real thing', 'all the way', 'rock \'n\' roll',
  'chinglish',
  // Short titles easily embedded in other words/phrases
  'bug', 'job', 'juno', 'fela', 'fun', 'leap', 'loot',
  // Place names and common nouns that are also show titles
  'broadway', 'brooklyn', 'hamilton', 'innocence', 'barrymore',
  'brothers', 'strangers', 'the women', 'the children', 'the life',
  'the first', 'music is', 'the supporting cast',
  'the producers', 'bullets over broadway',
  // Common phrases / genre terms that are show titles
  'all over', 'best friend', 'a broadway musical', 'charlotte',
  'ballroom', 'liberation', 'romantic comedy', 'the father',
  'lombardi', 'the motherf**ker with the hat',
]);

// Minimum title length to consider for matching (chars)
const MIN_TITLE_LENGTH = 8;

let _titleCache = null;

/**
 * Build title → showId map from shows.json (cached after first call)
 * Only includes titles >= MIN_TITLE_LENGTH and not in COMMON_WORD_TITLES
 */
function getMatchableTitles() {
  if (_titleCache) return _titleCache;

  const showsPath = path.join(__dirname, '../../data/shows.json');
  const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows || [];

  _titleCache = new Map();

  for (const show of shows) {
    const title = show.title;
    if (!title) continue;

    // Skip short titles and common-word titles
    if (title.length < MIN_TITLE_LENGTH) continue;
    if (COMMON_WORD_TITLES.has(title.toLowerCase())) continue;

    // Store with word-boundary regex for accurate matching
    // Escape special regex chars in title
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    _titleCache.set(show.id, { title, regex });
  }

  return _titleCache;
}

/**
 * Check if an excerpt mentions a different show's title without mentioning the current show.
 *
 * @param {string} excerpt - The excerpt text to check
 * @param {string} currentShowId - The show ID this excerpt belongs to
 * @param {string} currentShowTitle - The title of the current show
 * @returns {{ isWrongShow: boolean, mentionedShowId?: string, mentionedTitle?: string }}
 */
function excerptMentionsWrongShow(excerpt, currentShowId, currentShowTitle) {
  if (!excerpt || !currentShowId) return { isWrongShow: false };

  const titles = getMatchableTitles();

  // Check if excerpt mentions current show's title (if so, it's probably fine
  // even if it mentions another show — could be a comparison)
  // Strip trailing punctuation from title before building regex — chars like ! break \b
  const titleForMatch = currentShowTitle
    ? currentShowTitle.replace(/[^\w]+$/, '')
    : null;
  const currentEscaped = titleForMatch
    ? titleForMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : null;
  const currentRegex = currentEscaped
    ? new RegExp(`\\b${currentEscaped}\\b`, 'i')
    : null;
  const mentionsCurrentShow = currentRegex ? currentRegex.test(excerpt) : false;

  for (const [showId, { title, regex }] of titles) {
    // Skip self
    if (showId === currentShowId) continue;

    // Check if this other show's title appears in the excerpt
    if (regex.test(excerpt)) {
      // If excerpt also mentions current show, it's likely a comparison — allow it
      if (mentionsCurrentShow) continue;

      return {
        isWrongShow: true,
        mentionedShowId: showId,
        mentionedTitle: title
      };
    }
  }

  return { isWrongShow: false };
}

// --- Layer 3b: Former-Cast Mention Detection ---
//
// A returning production (show.priorRuns) re-includes reviews from an
// earlier run of the same show. Those reviews' pull-quotes were written
// about THAT run's cast and can name a since-departed lead (BRO-1397: To
// Kill a Mockingbird WE 2026 re-includes its 2022 Gielgud run, whose Times
// review reads "Rafe Spall is stunning" — Spall isn't in the 2026 cast).
//
// Detection requires POSITIVE evidence, not just "any unrecognized name":
// a name candidate only counts as a former-cast mention when it sits near
// one of the CURRENT show's own character/role names (Atticus, Mayella,
// Judge Taylor...) in the review's own text — the way critics actually
// write about casting ("Rafe Spall inheriting ... role as Atticus Finch",
// "a terrified Mayella (Poppy Lee Friar)"). A plain "unrecognized name"
// net over-fires on the author ("Harper Lee's 1960 novel", "the Harper Lee
// estate"), other adaptations name-dropped for comparison ("The Social
// Network"), and outlet/venue text — none of those sit next to a role name.
//
// Detection is file-local (scoped to the one review's own text fields, not
// the show's whole corpus): a corpus-wide "mentioned only in prior-run-era
// reviews" scan sounds appealing but aggregator excerpt fields on this
// corpus are already known to carry stale cross-era text (WET/Stagedoor
// excerpts scraped from an old archive page onto a new review, see
// memory/feedback_wet_venue_page_wrong_show_ingestion.md) — bucketing by
// publishDate alone would let a contaminated "current-era" field cancel out
// a real former-cast name. Restricting the scan to one file's own fields
// avoids that cross-file poisoning.

// Two-or-three consecutive Title-Case words — a broad "this looks like a
// person's name" net, deliberately unanchored to any specific name so it
// generalizes to any show that declares priorRuns.
const NAME_CANDIDATE_RE = /\b[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){1,2}\b/g;

// Candidates ending in one of these words are venues/outlets/institutions,
// not people — "Gielgud Theatre", "New York Times" — even though they match
// the Title-Case pattern.
const INSTITUTIONAL_SUFFIX_RE = /(theatre|theater|company|square|street|avenue|award|awards|festival|society|museum|centre|center|studio|productions?|times|guardian|post|herald|journal|tribune|magazine)$/i;

// Whole-phrase market/geography boilerplate that recurs constantly in
// review prose regardless of suffix ("West End", "Off Broadway") — caught
// live on allegra-west-end-2026 (readaboutstuff--unknown.json, 2026-07-10):
// "Peter Quilter's hit West End transfer" got its own "West End" tokenized
// into a false former-cast match once "end" collided with unrelated prose
// near the role name elsewhere in the file.
const MARKET_PHRASE_RE = /^(west end|off broadway|off west end|new york|east end|south bank|the fringe)$/i;

// A candidate starting with a common function word is a title/phrase
// fragment ("The Social Network", "A Few Good Men" — comparison titles
// critics drop in passing), not a person's name.
const LEADING_STOPWORD_RE = /^(the|a|an|and|or|but|of|in|on|at|to|for|with|from|by|as|is|was|are|were|has|have|had|this|that|these|those|its|so|if|when|while|where|what|who|which|how|why|there|here|now|then|yet|not|no)$/i;

// A name immediately followed by "'s novel"/"estate"/etc (with up to a few
// adjectives in between — "'s beloved book", "'s celebrated 1960 novel") is
// the literary source's author (Harper Lee, Arthur Miller...) — a valid
// reference in any era's review, so role-name proximity alone isn't enough
// to treat it as a departed cast member.
const LITERARY_SOURCE_SUFFIX_RE = /^\s*['’]?s?\s*(?:\d{4}\s+)?(?:[a-z]+\s+){0,3}(?:novel|book|memoir|play|story|autobiography|screenplay|source material|estate)\b/i;
const LITERARY_SOURCE_SUFFIX_WINDOW = 40;

// Fields that can carry review prose worth scanning for name candidates —
// mirrors the source list selectBestExcerpt() itself pulls quotes from.
const NAME_SCAN_FIELDS = [
  'fullText', 'westEndTheatreExcerpt', 'stagedoorExcerpt', 'dtliExcerpt',
  'bwwExcerpt', 'showScoreExcerpt', 'theatreReviewsExcerpt', 'nycTheatreExcerpt',
  'lboRoundupExcerpt', 'llmPullQuote',
];

// How close a current-show role name must sit to a name candidate (either
// side) to count as "this text is describing who plays that role" rather
// than an unrelated nearby mention.
const ROLE_PROXIMITY_WINDOW = 60;

function nameTokens(str) {
  if (!str) return [];
  return str
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length >= 3);
}

/**
 * Extract "this looks like a person's name" candidates (with match index)
 * from text, dropping institutional matches (venues, outlets) and leading
 * function-word fragments ("The Social Network").
 *
 * @param {string} text
 * @returns {Array<{ name: string, index: number }>}
 */
function extractPersonNameCandidates(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(NAME_CANDIDATE_RE)) {
    let candidate = m[0];
    let index = m.index;
    let words = candidate.split(/\s+/);
    if (LEADING_STOPWORD_RE.test(words[0])) {
      // The regex is greedy and non-overlapping: "The Rafe Spall" matches as
      // ONE 3-word candidate, so rejecting it outright would lose "Rafe
      // Spall" entirely (the next matchAll() iteration resumes AFTER this
      // match, it never re-tries the tail). Retry on the remainder instead
      // of just dropping it.
      if (words.length < 3) continue;
      const restOffset = candidate.indexOf(words[1]);
      candidate = words.slice(1).join(' ');
      index = m.index + restOffset;
      words = candidate.split(/\s+/);
      if (LEADING_STOPWORD_RE.test(words[0])) continue;
    }
    // A stopword ANYWHERE in the final candidate (not just leading) means
    // it isn't a name — e.g. scraped ad-chrome "Advertisement" immediately
    // followed by a capitalized sentence starter ("Advertisement The sound
    // design...") matches the 2-word pattern with no leading stopword to
    // catch it (illinoise-2024/slantmagazine, corpus sweep). A genuine
    // name never contains a bare "the"/"was"/"has".
    if (words.some(w => LEADING_STOPWORD_RE.test(w))) continue;
    if (INSTITUTIONAL_SUFFIX_RE.test(words[words.length - 1])) continue;
    if (MARKET_PHRASE_RE.test(candidate)) continue;
    const afterMatch = text.slice(index + candidate.length, index + candidate.length + LITERARY_SOURCE_SUFFIX_WINDOW);
    if (LITERARY_SOURCE_SUFFIX_RE.test(afterMatch)) continue;
    out.push({ name: candidate, index });
  }
  return out;
}

/**
 * Tokens that must never be treated as a former-cast mention: the current
 * cast (name + role, so character names like "Bob Ewell" aren't mistaken for
 * a departed actor), the creative team (director/writer persist across
 * runs), and the show/venue identity.
 *
 * @param {object} show
 * @returns {Set<string>}
 */
function buildSafeNameTokens(show) {
  const safe = new Set();
  const add = (s) => nameTokens(s).forEach(t => safe.add(t));
  (show.cast || []).forEach(c => { add(c && c.name); add(c && c.role); });
  (show.creativeTeam || []).forEach(c => add(c && c.name));
  add(show.title);
  add(show.venue);
  (show.priorRuns || []).forEach(r => add(r && r.venue));
  return safe;
}

/**
 * Role/character-name tokens for the show's CURRENT cast (e.g. "atticus",
 * "finch", "mayella", "judge", "taylor"). Presence of one of these near a
 * name candidate is the positive signal that the candidate is being
 * described as playing that role — see module-level comment.
 *
 * @param {object} show
 * @returns {Set<string>}
 */
function buildRoleTerms(show) {
  const terms = new Set();
  (show.cast || []).forEach(c => {
    if (!c || !c.role) return;
    c.role.split(/[/,]/).forEach(part => nameTokens(part).forEach(t => terms.add(t)));
  });
  return terms;
}

// "Directed by NAME" / "Written by NAME" / "Developed & Directed by: NAME" /
// "NAME's production/staging/direction/adaptation" — creative-team credits
// inferred from prose when show.creativeTeam data is incomplete (common for
// fringe/regional shows). Caught live sweeping all 34 priorRuns shows:
// the-enormous-crocodile-west-end-2026 (creativeTeam: []) credits its
// director two different ways across two review files — "Developed &
// Directed by: Emily Lim" in one, "Emily Lim's production delivers..." in
// another — both need to resolve to the same safe name. Whoever
// created/directed a production typically stays on for a returning run,
// the same reasoning as the explicit show.creativeTeam exclusion in
// buildSafeNameTokens.
const CREATIVE_ROLE_PHRASE_RE = /\b(?:directed|written|created|developed|choreographed|composed|designed|adapted)\s+(?:(?:&|and)\s+\w+\s+)?by:?\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})|\b([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2})['’]s\s+(?:production|staging|direction|adaptation)\b/gi;

/**
 * Names inferred from "directed by X" style credit lines in a review's own
 * text — a file-local safelist augmentation for creative-team members the
 * structured show.creativeTeam data is missing.
 *
 * @param {string} text
 * @returns {Set<string>} name tokens
 */
function extractCreativeRolePhraseNames(text) {
  const names = new Set();
  if (!text) return names;
  for (const m of text.matchAll(CREATIVE_ROLE_PHRASE_RE)) {
    nameTokens(m[1] || m[2]).forEach(t => names.add(t));
  }
  return names;
}

/**
 * True when a role term appears within ROLE_PROXIMITY_WINDOW chars either
 * side of a candidate's position in its source text.
 */
function hasNearbyRoleTerm(text, candidateName, candidateIndex, roleTerms) {
  if (roleTerms.size === 0) return false;
  const start = Math.max(0, candidateIndex - ROLE_PROXIMITY_WINDOW);
  const end = Math.min(text.length, candidateIndex + candidateName.length + ROLE_PROXIMITY_WINDOW);
  const window = text.slice(start, end).toLowerCase();
  for (const term of roleTerms) {
    if (new RegExp(`\\b${term}\\b`).test(window)) return true;
  }
  return false;
}

/**
 * Collect name-candidate tokens from a single review file's own text fields
 * that (a) don't match the show's current cast/creative-team/venue/title and
 * (b) sit near one of the current show's role names somewhere in the file —
 * positive evidence the file is describing who plays that role. These are
 * the tokens (first name, surname, or both) a former-cast guard treats as
 * "this review's own evidence of who is no longer in the show" — reused
 * both for a bare-surname mention ("Spall handles...") and a full-name one
 * ("Rafe Spall is stunning").
 *
 * @param {object} data - review-text JSON for one review
 * @param {Set<string>} safeTokens
 * @param {Set<string>} roleTerms
 * @returns {Set<string>}
 */
function collectFormerCastTokens(data, safeTokens, roleTerms) {
  const former = new Set();
  const texts = NAME_SCAN_FIELDS.map(f => data && data[f]).filter(t => typeof t === 'string' && t);
  if (data && data.llmScore) {
    if (data.llmScore.keyQuote) texts.push(data.llmScore.keyQuote);
    (data.llmScore.keyPhrases || []).forEach(p => { if (p && p.quote) texts.push(p.quote); });
  }

  // File-local safelist augmentation: "directed by X" credits caught in
  // THIS review's own text, on top of the show-level safeTokens.
  const fileSafeTokens = new Set(safeTokens);
  for (const text of texts) {
    for (const t of extractCreativeRolePhraseNames(text)) fileSafeTokens.add(t);
  }

  for (const text of texts) {
    for (const { name: candidate, index } of extractPersonNameCandidates(text)) {
      const tokens = nameTokens(candidate);
      if (tokens.length === 0) continue;
      // If ANY token of the candidate matches a safe name, treat the whole
      // candidate as a mention of that safe person (e.g. "Bartlett Sher"),
      // not a former-cast member.
      if (tokens.some(t => fileSafeTokens.has(t))) continue;
      if (!hasNearbyRoleTerm(text, candidate, index, roleTerms)) continue;
      // A 2-word candidate ("Rafe Spall") decomposes into both individual
      // tokens so a later bare-surname mention ("Spall handles...") still
      // matches. A 3-word candidate ("Poppy Lee Friar") is kept as one
      // atomic phrase instead — splitting it would add "lee" on its own,
      // which collides with unrelated words (e.g. the author "Harper
      // Lee") anywhere else in the file. The tradeoff: a later bare
      // mention of just the middle/last word of a 3-word name won't
      // match, which is an acceptable miss next to that false-positive.
      if (tokens.length <= 2) {
        tokens.forEach(t => former.add(t));
      } else {
        former.add(tokens.join(' '));
      }
    }
  }
  return former;
}

/**
 * Decide whether an excerpt candidate names someone from a returning
 * production's PRIOR run who isn't in the current cast — a former lead's
 * pull-quote surviving onto the current show page (BRO-1397).
 *
 * Only applies when the show declares priorRuns AND the review's own
 * publishDate falls inside one of those windows; every other review is
 * unaffected regardless of who it mentions.
 *
 * @param {string} excerpt - the candidate excerpt being validated
 * @param {object} context
 * @param {object} context.show - the show record (cast, creativeTeam, priorRuns, title, venue)
 * @param {string|Date} context.reviewDate - the review's publishDate
 * @param {object} context.reviewData - the full review-text JSON (for cross-field evidence)
 * @returns {{ mentionsFormerCast: boolean, name?: string }}
 */
function excerptMentionsFormerCast(excerpt, context) {
  if (!excerpt || !context || !context.show) return { mentionsFormerCast: false };
  const { show, reviewDate, reviewData } = context;
  if (!Array.isArray(show.priorRuns) || show.priorRuns.length === 0) {
    return { mentionsFormerCast: false };
  }
  if (!isWithinPriorRun(reviewDate, show.priorRuns)) return { mentionsFormerCast: false };

  const safeTokens = buildSafeNameTokens(show);
  const roleTerms = buildRoleTerms(show);
  const formerTokens = collectFormerCastTokens(reviewData || {}, safeTokens, roleTerms);
  if (formerTokens.size === 0) return { mentionsFormerCast: false };

  const excerptLower = excerpt.toLowerCase();
  // Use the same tokenizer that built formerTokens (nameTokens keeps a
  // hyphenated surname as one token, e.g. "lloyd-webber") — a regex ad hoc
  // to this call site previously split on hyphens, so a hyphenated former
  // cast member's surname alone (common in UK/West End casts) could never
  // match here even though it was correctly collected above.
  const excerptWords = nameTokens(excerpt);
  for (const entry of formerTokens) {
    if (entry.includes(' ')) {
      // Multi-word phrase (3-word candidate, kept atomic) — substring match.
      if (excerptLower.includes(entry)) return { mentionsFormerCast: true, name: entry };
    } else if (excerptWords.includes(entry)) {
      return { mentionsFormerCast: true, name: entry };
    }
  }
  return { mentionsFormerCast: false };
}

// --- Layer 4: Tour Review Detection ---

const TOUR_EXCERPT_PATTERNS = [
  /\btouring production\b/i,
  /\bnational tour\b/i,
  /\bNorth American tour\b/i,
  /\bfirst national\b/i,
  /\broad company\b/i,
  /\bbus and truck\b/i,
  /\btouring company\b/i,
  /\bon tour(?! with)\b/i,
];

// Known touring venue names that appear in review excerpts
const TOUR_VENUE_PATTERNS = [
  /\bPantages\b/,
  /\bOrpheum\b/,
  /\bFox Theatre\b/,
  /\bFabulous Fox\b/,
  /\bAhmanson\b/,
  /\bCIBC Theatre\b/,
  /\bCadillac Palace\b/,
  /\bKennedy Center\b/,
  /\bBoston Opera House\b/,
  /\bBuell Theatre\b/,
  /\bSegerstrom\b/,
  /\bDPAC\b/,
  /\bPlayhouse Square\b/,
];

// Forward-looking tour mentions (planned/upcoming tours, not reviews of live tours).
// A Broadway review that ends with "a national tour is planned" should NOT be
// excluded as a tour review. Beaches 2026-04-22 + Rocky Horror 2026-04-23 postmortem #18.
const TOUR_FORWARD_TENSE_PATTERNS = [
  /\b(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\s+(?:is|will\s+be|will|has\s+been|is\s+being|is\s+set|is\s+slated|is\s+expected)\s+(?:planned|announced|scheduled|slated|launched|launching|booked|set|expected|coming|on\s+the\s+way|to\s+(?:launch|begin|start|open|hit|embark|follow|tour))/i,
  /\b(?:planned|announced|scheduled|slated|upcoming|forthcoming|future|prospective|proposed)\s+(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\b/i,
  /\btour\s+(?:starts|begins|opens|kicks\s+off|launches|heads|set\s+to\s+(?:launch|begin|start|open|embark))\s+(?:in\s+\d{4}|later|next|soon|tomorrow|this\s+(?:fall|winter|spring|summer|year))/i,
  /\bto\s+(?:embark\s+on|launch|begin|start|commence|mount|hit\s+the\s+road\s+on)\s+a\s+(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\b/i,
  /\b(?:announcing|announced|launching|launch|plans?\s+(?:for|a))\s+(?:a\s+)?(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\b/i,
  /\btour\s+(?:in|beginning|opening|starting|launching|set\s+for)\s+(?:20\d{2})\b/i,
  // "will [optionally up to 2 words] tour" — catches "will tour", "will eventually tour",
  // "will soon tour". Adverb gap capped at 2 words to avoid false positives like
  // "will walk toward the tour bus".
  /\bwill(?:\s+\w+){0,2}\s+tour\b/i,
  // Bare participle/gerund adjacent to tour — no helper verb required. Catches
  // "tour planned for 2027", "tour launching next spring", "tour announced today".
  /\btour\s+(?:planned|announced|scheduled|slated|launching|booked|upcoming|expected)\b/i,
];

// Past-tense / in-progress markers — confirm this IS a tour review
const TOUR_PAST_TENSE_PATTERNS = [
  /\b(?:saw|caught|watched|attended|experienced|witnessed|reviewed)\s+(?:the\s+)?(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\b/i,
  /\b(?:on|during|at|from)\s+(?:its|the)\s+(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\b/i,
  /\btour\s+(?:opened|began|started|arrived|settled|landed|stops?|has\s+arrived|is\s+now|continues|is\s+currently|played|comes|came|has\s+come)\b/i,
  /\btoured\b/i,
  /\b(?:currently|now)\s+(?:on|touring)\b/i,
  /\bthis\s+(?:national\s+|uk\s+|us\s+|north\s+american\s+)tour\b/i,
];

/**
 * Returns true if a tour keyword appears only in forward-looking contexts
 * (planned/upcoming tour) with no past-tense/in-progress tour signal.
 * Indicates a Broadway review mentioning a future tour, not a review of the tour itself.
 *
 * @param {string} excerpt
 * @returns {boolean}
 */
function hasOnlyForwardTenseTourMention(excerpt) {
  if (!excerpt) return false;
  const hasForward = TOUR_FORWARD_TENSE_PATTERNS.some(p => p.test(excerpt));
  if (!hasForward) return false;
  const hasPast = TOUR_PAST_TENSE_PATTERNS.some(p => p.test(excerpt));
  return !hasPast;
}

// How close a DIFFERENT show's title must sit before a tour-pattern match to
// count as "this tour signal is about that show, not the one being reviewed."
// Deliberately tight (not sentence-scoped): a full-sentence window let short
// or generic titles (a show literally named "Caroline", matching "Sweet
// Caroline" in an unrelated clause; "The Story", matching "as the story
// opens") swallow real self-descriptions anywhere in the same sentence.
// Corpus parity check (all 41,455 review-text files) found the sentence-wide
// version flipped 8 files; only 1 was the intended fix. A tight character
// window keeps the real bug fixed ("Noises Off is on tour on its umpteenth
// revival" — title sits ~14 chars before the match) without that surface.
const TOUR_OTHER_SHOW_WINDOW_CHARS = 70;

/**
 * True when a DIFFERENT, known show's title sits immediately before a
 * tour-pattern match (within TOUR_OTHER_SHOW_WINDOW_CHARS) — not the current
 * one. Critics routinely open a review with a comparison lede ("Noises Off is
 * on tour on its umpteenth revival; Fawlty Towers is back in London soon
 * before going on tour...") before getting to the show actually being
 * reviewed. isTourReviewExcerpt had no other-show awareness, so that
 * comparison tripped the same "on tour" pattern a genuine touring-production
 * review would. Confirmed live 2026-08-01: times-uk--dominic-maxwell.json on
 * the-comedy-about-spies-west-end-2026 was excluded (skippedTourContamination)
 * over its own lede mentioning Noises Off and Fawlty Towers touring — not
 * itself.
 *
 * @param {string} excerpt
 * @param {number} matchIndex - index of the tour-pattern match within excerpt
 * @param {string} currentShowId
 * @param {string} currentShowTitle
 * @returns {{ title: string, showId: string }|null}
 */
function tourMatchIsAboutDifferentShow(excerpt, matchIndex, currentShowId, currentShowTitle) {
  if (!currentShowId) return null;
  const windowStart = Math.max(0, matchIndex - TOUR_OTHER_SHOW_WINDOW_CHARS);
  const window = excerpt.slice(windowStart, matchIndex);

  const titleForMatch = currentShowTitle ? currentShowTitle.replace(/[^\w]+$/, '') : null;
  const currentEscaped = titleForMatch ? titleForMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const currentRegex = currentEscaped ? new RegExp(`\\b${currentEscaped}\\b`, 'i') : null;
  if (currentRegex && currentRegex.test(window)) return null;

  for (const [showId, { title, regex }] of getMatchableTitles()) {
    if (showId === currentShowId) continue;
    if (regex.test(window)) return { title, showId };
  }
  return null;
}

/**
 * Check if an excerpt appears to be from a touring production review.
 *
 * @param {string} excerpt - The excerpt text
 * @param {{currentShowId?: string, currentShowTitle?: string}} [context] - when
 *   provided, a tour-pattern match immediately preceded by a DIFFERENT known
 *   show's title is treated as a comparison lede, not tour contamination.
 * @returns {{ isTourReview: boolean, signal?: string, forwardTenseOnly?: boolean, otherShowComparison?: boolean }}
 */
function isTourReviewExcerpt(excerpt, context) {
  if (!excerpt) return { isTourReview: false };

  // Venue patterns are unambiguous — check first (forward-tense carve-out does NOT apply)
  for (const pattern of TOUR_VENUE_PATTERNS) {
    if (pattern.test(excerpt)) {
      return { isTourReview: true, signal: `venue: ${pattern.source}` };
    }
  }

  // Tour keyword patterns — skip when only forward-tense context is present.
  // Checks the FIRST match per pattern only (mirrors the pre-existing
  // .find()-based behavior): a comparison lede that opens the excerpt is by
  // far the common case this excerpt corpus produces, and scanning every
  // subsequent match against the (necessarily incomplete) known-show-title
  // catalog trades a real fix — the-comedy-about-spies-west-end-2026's lede
  // also names "Fawlty Towers", which is not itself a cataloged show — for a
  // narrower theoretical gain (a genuine self-description coexisting with an
  // unrelated comparison later in the same excerpt).
  for (const pattern of TOUR_EXCERPT_PATTERNS) {
    const m = pattern.exec(excerpt);
    if (!m) continue;
    if (hasOnlyForwardTenseTourMention(excerpt)) {
      return { isTourReview: false, forwardTenseOnly: true, signal: pattern.source };
    }
    if (context) {
      const other = tourMatchIsAboutDifferentShow(excerpt, m.index, context.currentShowId, context.currentShowTitle);
      if (other) {
        return { isTourReview: false, otherShowComparison: true, signal: pattern.source, mentionedTitle: other.title };
      }
    }
    return { isTourReview: true, signal: pattern.source };
  }

  return { isTourReview: false };
}

// --- Film/TV Review Detection ---

// Phrases that strongly indicate a film/TV/streaming review (not live theater)
const FILM_TV_PATTERNS = [
  /\bstreaming on\b/i,
  /\bon Netflix\b/i,
  /\bon Disney\+/i,
  /\bon Disney Plus\b/i,
  /\bon HBO\b/i,
  /\bon Amazon Prime\b/i,
  /\bon Hulu\b/i,
  /\bon Apple TV/i,
  /\bcinematography\b/i,
  /\bfilmed version\b/i,
  /\bfilm adaptation\b/i,
  /\bmovie adaptation\b/i,
  /\bmovie version\b/i,
  /\bon the big screen\b/i,
  /\bin theaters now\b/i,
  /\bin cinemas\b/i,
];

// Phrases that confirm live theater context (presence = NOT a film review)
const THEATER_CONTEXT_PATTERNS = [
  /\bstage\b/i,
  /\btheatre?\b/i,
  /\bBroadway\b/i,
  /\bcurtain call\b/i,
  /\bintermission\b/i,
  /\bopening night\b/i,
  /\bstanding ovation\b/i,
  /\bthe musical\b/i,
  /\borchestra\b/i,
  /\bmezzanine\b/i,
];

/**
 * Check if text appears to be from a film/TV/streaming review rather than live theater.
 * Requires 2+ film/TV signals AND zero theater signals to flag — high precision.
 *
 * @param {string} text - Review text (typically first 600 chars of fullText)
 * @returns {{ isFilmTv: boolean, signals?: string[], filmCount?: number, theaterCount?: number }}
 */
function isFilmTvReview(text) {
  if (!text || text.length < 100) return { isFilmTv: false };

  const filmMatches = FILM_TV_PATTERNS.filter(p => p.test(text));
  const theaterMatches = THEATER_CONTEXT_PATTERNS.filter(p => p.test(text));

  if (filmMatches.length >= 2 && theaterMatches.length === 0) {
    return {
      isFilmTv: true,
      signals: filmMatches.map(p => p.source),
      filmCount: filmMatches.length,
      theaterCount: 0
    };
  }

  return { isFilmTv: false };
}

/**
 * Reset the title cache (for testing)
 */
function resetCache() {
  _titleCache = null;
}

module.exports = {
  excerptMentionsWrongShow,
  isTourReviewExcerpt,
  isFilmTvReview,
  excerptMentionsFormerCast,
  buildSafeNameTokens,
  buildRoleTerms,
  collectFormerCastTokens,
  extractPersonNameCandidates,
  hasOnlyForwardTenseTourMention,
  getMatchableTitles,
  resetCache,
  COMMON_WORD_TITLES,
  MIN_TITLE_LENGTH,
};
