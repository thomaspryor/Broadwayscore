/**
 * Pull Quote Guards — pure decision helpers for extract-pull-quotes.js.
 *
 * Extracted per CLAUDE.md §15 (Test Extraction Pattern): never copy logic
 * into test files; require the real function.
 */

// Sentences that start with a hedging connector — "But", "Yet", "Still",
// "Though", "Although", "However", "Despite", "While" — usually introduce
// a reservation or caveat. When the surrounding review is positive overall,
// picking one of these as the pull quote makes the critic look ambivalent
// even when they weren't. NYT critics especially structure reviews with a
// middle-paragraph caveat before a positive closer — the LLM reliably picks
// the caveat as "most quotable".
const { isSoft404Body } = require('./soft-404-body');
const { foldDiacritics } = require('./title-match');

const HEDGE_OPENER_RE = /^\s*(but|yet|still|though|although|however|despite|while)\b/i;

// Mid-sentence pivots like ", but", ", yet", ", though" on a positive review
// almost always swing the reader from praise to reservation. E.g. Helen Shaw
// on Giant: "I found Lithgow's performance a fascinating study in monstrosity,
// but I found myself more engaged by the conversations I've had since seeing
// 'Giant'" — reads as a withdrawal of endorsement on a 77-scoring review.
// "yet again" / "yet another" is emphasis, not a pivot: the NYT Critics' Pick
// line ", has returned to Broadway, yet again in triumph" is the endorsement
// BRO-751 asked the extractor to pick, and was being rejected.
const MID_SENTENCE_PIVOT_RE = /,\s+(but|yet(?!\s+(?:again|another|once more)\b)|though|although|however|despite)\b/i;

// A candidate outside this range is rejected: too short to stand alone out of
// context ("Yes, they're spectacular!" — real, on-topic, but only 25 chars),
// or too long to read as a pull quote.
const MIN_QUOTE_LENGTH = 30;
const MAX_QUOTE_LENGTH = 300;

/**
 * Does an LLM keyPhrase's sentiment contradict the review's score? A
 * 'negative' phrase on a score >= 70 review, or a 'positive' one on a
 * score <= 40 review, misrepresents the verdict as the display quote.
 * Null score / unknown sentiment → false (no evidence of a contradiction).
 */
function phraseContradictsScore(sentiment, score) {
  if (score == null || typeof score !== 'number') return false;
  if (sentiment === 'negative' && score >= 70) return true;
  if (sentiment === 'positive' && score <= 40) return true;
  return false;
}

/**
 * Is this candidate too short or too long to ship as a pull quote?
 * extract-pull-quotes.js retries once with a hint before giving up on a
 * length rejection — see processReview()'s length-check branch — instead of
 * falling through to the raw-fullText heuristic scrape (Les Mis Arena
 * Concert / Cititour, card em-20260801-000455).
 */
function isBadCandidateLength(quote) {
  if (!quote || typeof quote !== 'string') return false;
  return quote.length < MIN_QUOTE_LENGTH || quote.length > MAX_QUOTE_LENGTH;
}

/**
 * Does this sentence open with a hedge word? Case-insensitive, tolerates
 * leading quote marks (some LLM responses are wrapped in quotes the caller
 * didn't strip).
 */
function isHedgeOpener(quote) {
  if (!quote || typeof quote !== 'string') return false;
  // Strip leading straight/curly quotes so '"But..."' still trips the guard.
  const cleaned = quote.replace(/^[\s"\u201C\u2018'`]+/, '');
  return HEDGE_OPENER_RE.test(cleaned);
}

/**
 * Does this sentence contain a mid-sentence reservation pivot?
 */
// BRO-7598: "not X, but Y" is a correction, not a reservation. WSJ on
// Downstate (score 93): "A playwright's responsibility isn't to either forgive
// or condemn, but to render life in all its complexity ... as Mr. Norris so
// superbly does" was refused as a hedge, which pushed the extractor to a
// fragment cut from the middle of that sentence. The ", but" only counts as a
// correction when the same clause before it carries a negation and "but" is
// followed by a parallel phrase (to / also / rather / instead), never by a new
// subject: "It isn't perfect, but it is fun" still trips the guard.
// The check is per ", but": the clause before THIS but (back to the previous
// comma or sentence stop) must hold the negation, and the words right after it
// must be a parallel phrase. So "Overlong, but not dull, but also thrilling"
// still trips on its first but. Concessions ("but to its credit", "but to our
// delight", "but to this critic", "but to judge by", "but to say so") and
// "but also not" stay pivots.
const CORRECTIVE_NEGATION_RE = /(?:\bnot|\bnever|n['\u2019]t)\b/i;
const CORRECTIVE_FOLLOW_RE = /^(?:to\b(?!\s+(?:its|his|her|their|this|my|me|us|say|judge|be\s+(?:fair|sure|honest))\b)(?!(?:\s+\S+){0,3}?\s+(?:credit|delight|surprise|dismay|relief|chagrin|mind|eyes?|ears?)\b)|also\b(?!\s+not\b)|rather\b|instead\b)/i;

function isCorrectiveBut(quote, butIndex, afterBut) {
  const clause = quote.slice(0, butIndex).split(/[.!?;:,]/).pop();
  if (!CORRECTIVE_NEGATION_RE.test(clause)) return false;
  return CORRECTIVE_FOLLOW_RE.test(quote.slice(afterBut));
}

function hasMidSentencePivot(quote) {
  if (!quote || typeof quote !== 'string') return false;
  const re = new RegExp(MID_SENTENCE_PIVOT_RE.source, 'gi');
  let m;
  while ((m = re.exec(quote)) !== null) {
    if (m[1].toLowerCase() !== 'but') return true;
    if (!isCorrectiveBut(quote, m.index, m.index + m[0].length + 1)) return true;
  }
  return false;
}

/**
 * Should we reject this quote as misaligned with the review's verdict?
 *
 * Rule: if the review's overall score is positive (>= 70) and the quote
 * opens with a hedging connector, it's almost always a middle-paragraph
 * reservation rather than the critic's endorsement. Reject so the caller
 * can retry with a stronger hint.
 *
 * For mixed (40-69) and negative (< 40) reviews, hedge openers are often
 * legitimate ("Still, the show never finds its footing") so we don't block.
 *
 * `score` can be null/undefined — in that case we don't have a verdict
 * signal and we let the quote through (old behavior).
 */
function shouldRejectAsReservation(quote, score) {
  if (score == null) return false;
  if (typeof score !== 'number' || Number.isNaN(score)) return false;
  if (score < 70) return false;
  if (isHedgeOpener(quote)) return true;
  if (hasMidSentencePivot(quote)) return true;
  return false;
}

// Bug #11: Internal-note excerpts (e.g. "[INTERNAL: score needs review]", "Note: ...")
// These are editorial notes that accidentally end up in the pullQuote field.
function isInternalNote(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  const trimmed = excerpt.trimStart();
  if (trimmed.startsWith('[')) return true;
  if (/\[INTERNAL\b/i.test(excerpt)) return true;
  if (/\[NOTE\b/i.test(excerpt)) return true;
  return false;
}

// Bug #14: Copyright/subscribe chrome patterns that leak from web scraping.
const COPYRIGHT_CHROME_PATTERNS = [
  /all rights reserved/i,
  /subscribe to/i,
  /\u00A9 20\d\d/,    // © 20xx (unicode © sign)
  /\(c\) 20\d\d/i,    // (c) 20xx fallback
  /read more at/i,
  /click here to/i,
  /\bsign up\b/i,
  /\bnewsletter\b/i,
  // Affiliate / reader-funding disclaimers that lead many outlet pages
  // (Evening Standard: "When you purchase through links on our site, we may
  //  earn an affiliate commission." / "The Standard's journalism is supported
  //  by our readers."). War Horse 2026-06-07.
  /affiliate commission/i,
  /purchase through links/i,
  /through links on our site/i,
  /journalism is supported by/i,
  /supported by our readers/i,
  /we may earn a/i,
];

function hasCopyrightChrome(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  return COPYRIGHT_CHROME_PATTERNS.some(re => re.test(excerpt));
}

// Promo-teaser guard (2026-07-14, Whoopi Monologues audit): New York Theatre
// Guide / London Theatre articles OPEN with an SEO standfirst ("Read our
// review of <show>, now in performances at <venue>...") that gets scraped
// into fullText as its first narrative-shaped sentence. It sailed past every
// excerpt guard (5+ words, ends with a period, uppercase start, theater
// vocabulary) and shipped as the displayed pull quote on 6 shows. These
// patterns are START-anchored (after optional wrapping quotes/whitespace) —
// a critic writing "...you should read our review" mid-sentence is untouched.
// Parity-tested against all 18,763 live pull quotes: exactly the 6 known-bad
// teasers match, zero false positives.
const PROMO_TEASER_PATTERNS = [
  /^[\s"'“”‘’«»`(\[]*read\s+(?:our|the|my)\s+(?:full\s+)?review\b/i,
  /^[\s"'“”‘’«»`(\[]*(?:book|buy|get|find|grab)\s+(?:your\s+)?tickets?\b/i,
  /^[\s"'“”‘’«»`(\[]*tickets?\s+(?:from|start|are\s+on\s+sale|on\s+sale)\b/i,
  /^[\s"'“”‘’«»`(\[]*(?:follow\s+us|click\s+here|learn\s+more\s+about)\b/i,
];

// Service-journalism sections some outlets (New York Theatre Guide, London
// Theatre) append after the critic's prose: "Who should see X", "What to
// expect at X", "What audiences are saying about X". Sentences there are
// genre boilerplate, not the critic's verdict (GTC NYTG picked "The family
// play is a staple of American theatre.", BRO-4973).
const SERVICE_SECTION_HEADING_RE = /(?:who\s+should\s+(?:see|watch)|what\s+to\s+expect\s+(?:at|from)|what\s+(?:audiences|theatregoers|theatergoers)\s+are\s+saying|good\s+to\s+know|should\s+you\s+(?:see|go))\b/i;

/**
 * Does `quote` sit inside a service-journalism section of `fullText`? True
 * when one of those headings occurs within 500 chars before the quote.
 */
function isInServiceSection(quote, fullText) {
  if (!quote || !fullText || typeof quote !== 'string' || typeof fullText !== 'string') return false;
  const norm = (t) => t.replace(/[\u2018\u2019\u201c\u201d'"]/g, '').replace(/\s+/g, ' ');
  const text = norm(fullText);
  const at = text.indexOf(norm(quote).trim());
  if (at < 0) return false;
  return SERVICE_SECTION_HEADING_RE.test(text.slice(Math.max(0, at - 500), at));
}

// ---------------------------------------------------------------------------
// Context dependence: a quote that leans on the sentence before it.
//
// BRO-6631 (owner report, A Few Good Men opening 2026-10-29): the shipped
// quotes included "Despite this elaborate choreography, Arden's production
// works as theater only intermittently." (NYT), "If only the rest of the
// production felt as up-to-date." (NYTG) and "Truth be told, though, the main
// struggle here has to be within Kaffee..." (Chicago Tribune). Each is a real
// critic sentence, but read alone on a show card it points at something the
// reader never saw. The extractor prompt already says "must make sense without
// the surrounding context"; nothing enforced it.
//
// Used at extraction time only (extract-pull-quotes retries; a stored quote
// that trips it is re-extracted). The rebuild does NOT defer on it: a
// 2026-10-30 A/B of the 205 shipped quotes it would swap found the fallback
// candidates (keyPhrases, aggregator blurbs, body slices) no better half the
// time. A fresh LLM pick from the full review is the fix.
//
// Deliberately narrow (291 of 39,642 shipped quotes on 2026-10-30): plain
// "It..." / "This is a..." / "His performance..." openers read fine alone and
// are NOT flagged, nor are mild markers like "Even so," / "That said," /
// "The result is", whose clause still states a verdict.
// ---------------------------------------------------------------------------
// Words that, right after "despite this" / "for all that", mean the
// demonstrative names the show itself ("Despite this production's flaws").
const CONTEXT_SHOW_NOUN = '(?:show|production|revival|play|musical|staging|evening|night|piece|work|drama|comedy|opera|adaptation|version|incarnation|outing|transfer|cast|company|ensemble|year|season|theater|theatre|tour|concert|run|one|new|latest)';
const CONTEXT_DEPENDENT_PATTERNS = [
  // Discourse markers that only make sense after a previous sentence.
  /^(?:if only|even then|in other words|in that sense|to that end|on top of that|more than that|beyond that|worse still|better still|by contrast|in contrast|similarly|likewise|then again|nor|which is why|this is why|that is why|that's why|that’s why|hence|for that reason|for this reason)\b/i,
  // "Truth be told, though, ..." / "To be fair, however, ..."
  /^(?:truth be told|in truth|to be fair|to be sure|admittedly|granted|in fairness|frankly|honestly)[,\s]+(?:though|however)\b/i,
  // Bare demonstrative pronoun as the subject: "That makes the clumsiness...",
  // "These are the moments where...", "This is hardly a problem".
  /^(?:that|those|these)\s+(?:is|was|'s|’s|are|were|makes|made|means|meant|would|could|should|might|may|leaves|left|explains|isn't|isn’t|doesn't|doesn’t|wasn't|wasn’t|did|does|alone|aside|helps|matters|changes)\b/i,
  /^this\s+(?:is|was|'s|’s)\s+(?:hardly|no mere|also|partly|precisely|why|because|the problem|a problem|in part)\b/i,
  /^this\s+(?:makes(?!\s+for)|made(?!\s+for)|means|meant|leaves|left|explains|would|could|helps|matters|changes|aside)\b/i,
  // A concessive pointing back: "Despite this elaborate choreography",
  // "Yet despite this, ...", "For all that, ...". Not "Despite this
  // production's flaws" or "For all those who love...".
  new RegExp(`^(?:\\S+\\s+){0,2}(?:despite|for all|because of|in spite of|thanks to|beyond|besides|apart from|aside from)\\s+(?:all\\s+)?(?:this|that|these|those|it|them)\\b(?!\\s+who\\b)(?!\\s+${CONTEXT_SHOW_NOUN}\\b)`, 'i'),
  // An unnamed person: "Even his skills can't salvage this show."
  /^even\s+(?:his|her|their)\s/i,
  // An earlier-named pair: "the verdict rests with the former."
  /\bthe (?:latter|former)(?=\s*[.,;:!?—–]|\s+(?:is|was|are|were|has|had|proves|wins|works)\b)/i,
];

// A quote that names the show stands on its own even with a back-reference:
// "That makes A Strange Loop the best new musical of the Broadway season."
// (The 2026-10-30 A/B judged these better than any replacement.)
function namesShowTitle(quote, showTitle) {
  if (!showTitle || typeof showTitle !== 'string') return false;
  // Case is kept so a common-word title ("Company") only counts when written
  // as a name; apostrophes split so "Company’s" still matches.
  const norm = t => foldDiacritics(String(t)).replace(/[^A-Za-z0-9]+/g, ' ').trim();
  const title = norm(showTitle).replace(/^(?:The|A|An) /i, '');
  if (title.length < 4) return false;
  const q = ` ${norm(quote)} `;
  const at = q.toLowerCase().indexOf(` ${title.toLowerCase()} `);
  return at >= 0 && /[A-Z0-9]/.test(q[at + 1]);
}

function isContextDependentQuote(quote, { showTitle } = {}) {
  if (!quote || typeof quote !== 'string') return false;
  const s = quote.replace(/^[\s"“‘'`(\[]+/, '');
  if (!CONTEXT_DEPENDENT_PATTERNS.some(re => re.test(s))) return false;
  return !namesShowTitle(s, showTitle);
}

// BRO-7598: a quote lifted from inside a subordinate clause. The WSJ review of
// Downstate (2026-11-15) reads "...a vision of humanity that is truthful, as
// Mr. Norris so superbly does in this troubling but terrific play." and shipped
// "Mr. Norris so superbly does in this troubling but terrific play.": every word
// verbatim, so verifyInText and the contiguity check passed, but it is not a
// sentence. The tell is in the source: the words just before the quote, in the
// same sentence, are "as" / "which" / "whom" / "than". On the 2026-11-16 corpus
// (51,047 stored quotes) this matched 26, about a third of them real fragments,
// so it is a soft signal: extract-pull-quotes retries once asking for the whole
// sentence from its start, and a quote that survives the retry is kept via
// llmPullQuoteContextCheckedAt. Never a hard reject. Commas and "that"/"if"/
// "because" leads were measured too (4,082 and 153 matches, nearly all fine
// standalone clauses) and left out. Errs toward false: a quote the source
// repeats, or one not found verbatim, is not judged.
const MID_CLAUSE_LEAD_RE = /(?:^|[\s,(])(as|which|whom|than) '?$/;
// The lead word alone over-fires: "as Some Like It Hot is a wildly
// entertaining farce" and "a play in which Bartlett exhilaratingly combines
// the domestic and the epic" read fine on their own. A real fragment leaves a
// gap the cut-off words filled:
// - as/than + a pro-verb or reporting verb with nothing after it: "as Mr.
//   Norris so superbly does in this play", "as Titanique joyously shows, mirth
//   and song...", "as A Bright Room Called Day does, consistently."
// - a bare which/whom (no preposition before it) is an object relative, so
//   its object is missing: "which Butler brings vibrantly to life", "which I
//   admired for its dramatic skill". "in which" / "with which" is complete.
const MID_CLAUSE_GAP_RE = /^[^,.;:!?\u2014]*?\b(?:do|does|did|show|shows|showed|prove|proves|proved|suggest|suggests|suggested|demonstrate|demonstrates|demonstrated|remind|reminds|reminded|note|notes|noted|say|says|said|write|writes|wrote|puts\s+it|put\s+it)\b(?=\s*(?:[,.;:!?\u2014]|$|\s(?:in|on|at|with|here|there|so|now|again|throughout|best|well)\b))/i;
const RELATIVE_AFTER_PREP_RE = /\b(?:in|of|by|at|on|for|from|with|through|under|over|to|into|during|against|about|without|within)\s+(?:which|whom) '?$/i;
function startsMidClause(quote, fullText) {
  if (!quote || !fullText || typeof quote !== 'string' || typeof fullText !== 'string') return false;
  const q = normalizeForContiguity(quote).replace(/^['(\[\s]+/, '');
  // A leading ellipsis is the critic's or editor's own honest elision.
  if (/^(?:\.\.\.|…)/.test(q)) return false;
  const head = q.slice(0, 40);
  if (head.length < 20) return false;
  const src = contiguityViews(fullText).breaks;
  const at = src.indexOf(head);
  // Absent, at the very start, or ambiguous (quoted twice): nothing to judge.
  if (at <= 0 || src.indexOf(head, at + 1) !== -1) return false;
  // Only the same paragraph counts: a break starts a sentence ("...end.\nAs
  // Mr. Norris..." still reads the "As").
  const window = src.slice(Math.max(0, at - 40), at);
  const before = window.slice(window.lastIndexOf('\n') + 1);
  const lead = MID_CLAUSE_LEAD_RE.exec(before);
  if (!lead) return false;
  if (lead[1] === 'which' || lead[1] === 'whom') return !RELATIVE_AFTER_PREP_RE.test(before);
  // "Mr." / "St." are not sentence stops for the first-clause scan.
  return MID_CLAUSE_GAP_RE.test(q.replace(/\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Mt)\./gi, '$1'));
}

// A candidate that opens mid-sentence: a lowercase first word, or a stray
// comma / semicolon / colon left over when the sentence splitter broke at a
// "!" or "?" inside a title. Slant on The Fantasticks (2026-11-16) shipped
// ", director Christopher Gattelli spread large-scale charm..." after the
// split at "In Death Becomes Her and Schmigadoon!". Leading wrapping quotes,
// parens and whitespace are skipped first.
const FRAGMENT_START_RE = /^[\s"'\u201c\u2018\u00ab(\[]*(?:[a-z]|[,;:])/;
// Only the stray-punctuation half: a shipped or LLM quote opening this way
// is never the critic's sentence start (audit + extractor hard reject).
const PUNCT_FRAGMENT_START_RE = /^[\s"'\u201c\u2018\u00ab(\[]*[,;:]/;
// A candidate that opens on a parenthetical aside or a photo credit: Slant on
// The Fantasticks (2026-11-16) shipped "(Lewis's existence also happens to save
// the show...", Piedmont Exedra shipped "(Courtesy Matthew Murphy/...) The stage
// musical...". An opening "(" is never the critic's verdict sentence (9 of 9
// live cases on 2026-11-17 were asides, credits or song-title fragments).
const PAREN_ASIDE_START_RE = /^[\s"'\u201c\u2018\u00ab]*\(/;
// "(Courtesy Matthew Murphy/BroadwaySF) The stage musical..." -> "The stage
// musical...": a closed aside (or photo credit) followed by a capitalised
// sentence is cut, so the critic's own sentence ships. Anything else (an
// unclosed aside, or one followed by ", is very nearly...") is left as is and
// the fragment guard defers it. The result is still a substring of the input.
const LEADING_PAREN_ASIDE_RE = /^[\s"'\u201c\u2018\u00ab]*\([^()]{1,300}\)[\s.]*(?=["\u201c\u2018']?[A-Z])/;
// A list-bullet or arrow left over from page markup: Time Out London shipped
// "- Coward's wit is...", LondonTheatre1 "– Kunene and the King...", Bristol24/7
// "--> \u201cSay your prayers..." (2026-11-17). Cut only when a space and then a
// capital or opening quote follow, so a dash that is part of the text stays.
const LEADING_BULLET_RE = /^\s*(?:-+>|\u2192|[-\u2013\u2014\u2022\u00b7*]+)\s+(?=["\u201c\u2018\u00ab'(]?[A-Z(])/;
function stripLeadingParenAside(excerpt) {
  if (typeof excerpt !== 'string') return excerpt;
  const b = excerpt.match(LEADING_BULLET_RE);
  if (b) excerpt = excerpt.slice(b[0].length);
  const m = excerpt.match(LEADING_PAREN_ASIDE_RE);
  return m ? excerpt.slice(m[0].length) : excerpt;
}
function startsAsFragment(excerpt) {
  return typeof excerpt === 'string' && (FRAGMENT_START_RE.test(excerpt) || PAREN_ASIDE_START_RE.test(excerpt));
}

// An aggregator excerpt the aggregator itself cut short ("...the plebeian ear
// requiring a careful listen. But Sorkin's script evens out, and ..."): BWW
// roundups clip at a fixed length. It is a partial passage, not a quote.
function endsWithSourceEllipsis(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  return /(?:\.\.\.|…)[\s"”’']*$/.test(excerpt);
}

// Only the long, multi-sentence clipped blurbs: a single line with "..."
// appended ("This is strong stuff, and the cast is up to the task...") still
// reads as a quote (BRO-6631 corpus A/B, 2026-10-30).
function isClippedAggregatorBlurb(excerpt) {
  if (!endsWithSourceEllipsis(excerpt)) return false;
  const body = excerpt.replace(/(?:\.\.\.|…)[\s"”’']*$/, '');
  const sentenceEnds = (body.match(/[.!?]["'”’)\]]*\s+(?=["'“‘(]*[A-Z0-9])/g) || []).length;
  return sentenceEnds >= 1 || excerpt.length > 200;
}

function isPromoTeaser(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  return PROMO_TEASER_PATTERNS.some(re => re.test(excerpt));
}

// ---------------------------------------------------------------------------
// Listing / credits chrome (2026-08-01, owner report on Tao of Glass).
//
// British Theatre Guide (and several other UK outlets) lead every review page
// with a one-line production-credits + venue + run-dates block terminated by
// "Listing details and ticket info". Because it carries NO newline, the
// line-based stripLeadingChrome below cannot see it, and the block is
// sentence-shaped enough to survive extractExcerptFromFullText's filters. It
// shipped as the displayed quote:
//   "Philip Glass and Phelim McDermott Factory International, Improbable and
//    Nica Burns @sohoplace theatre 24 July–12 September 2026. Listing details
//    and ticket info... Tao of Glass finally makes it to London after..."
//
// Two mechanisms, both needed:
//   stripListingPrelude() — removes the block from raw text before extraction
//   hasListingChrome()    — rejects any candidate that still carries it
// ---------------------------------------------------------------------------

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

// The BTG-style boilerplate terminator. Deliberately literal: this exact
// phrase is site furniture, never critic prose.
const LISTING_TERMINATOR_RE = /\blisting details and ticket info\b\.{0,3}/i;

// A venue-and-run-dates block: "@sohoplace theatre 24 July–12 September 2026",
// "at the Duke of York's Theatre, 3 March – 12 June 2026". Requires BOTH a
// day-number + month AND a second month + year, so a critic writing "opened in
// March" or "runs to September" is untouched.
const RUN_DATES_RE = new RegExp(
  `\\b\\d{1,2}\\s+(?:${MONTHS})\\s*[–—-]\\s*\\d{1,2}\\s+(?:${MONTHS})\\s+20\\d\\d`,
  'i'
);

const LISTING_CHROME_PATTERNS = [
  LISTING_TERMINATOR_RE,
  RUN_DATES_RE,
  // "Tickets from £45. Booking until 12 September 2026."
  /\bbooking (?:until|to|through)\s+\d{1,2}\s+\w+\s+20\d\d/i,
  // Runtime furniture: "Running time: 1 hour 40 minutes, no interval"
  /\brunning time:?\s*\d+\s*(?:hour|hr|minute|min)/i,
  // BRO-7196: a show-listing footer (Cititour, Wanted 2026-11-08): "Open/Close Dates Opening 11/8/2026 Closing
  // Open-ended Theatre Info James Earl Jones Theatre 138 West 48th Street New York, NY 10036 Map".
  /\bopen\s*\/\s*close dates\b/i,
  /\bclosing:?\s+open[- ]ended\b/i,
  /\b\d{2,5}\s+(?:(?:west|east|w\.?|e\.?)\s+)?\d{1,3}(?:st|nd|rd|th)\s+street\b[^.]{0,40}\bNY\s+1\d{4}\b/i,
];

function hasListingChrome(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  return LISTING_CHROME_PATTERNS.some(re => re.test(excerpt));
}

/**
 * Remove a leading listing/credits prelude from raw review text.
 *
 * Only strips when the boilerplate terminator appears near the START of the
 * text (within `maxPreludeChars`) — a critic quoting listing language 3,000
 * chars in is left alone. Returns the input unchanged when no prelude is found,
 * so it is safe to call unconditionally.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxPreludeChars=500] How far in the terminator may sit
 * @returns {string}
 */
function stripListingPrelude(text, opts = {}) {
  if (!text || typeof text !== 'string') return text;
  const maxPreludeChars = opts.maxPreludeChars != null ? opts.maxPreludeChars : 500;

  const m = LISTING_TERMINATOR_RE.exec(text);
  if (!m) return text;
  const end = m.index + m[0].length;
  if (m.index > maxPreludeChars) return text;

  // The terminator alone is not enough. A critic could write "The programme's
  // listing details and ticket info are more lucid than the production" — and
  // stripping there would delete their opening verdict (Codex adversarial
  // review, 2026-08-01). Require the text BEFORE the terminator to actually
  // look like a listing block: run dates, a venue @handle, or credits-style
  // prose with no sentence punctuation at all. Real criticism has periods.
  // The no-punctuation branch additionally requires the prelude to be
  // SUBSTANTIAL. A short lead-in like "The programme's " has no period either,
  // but it is the start of a sentence, not a credits block. Real listing
  // preludes carry a full credits + venue run (BTG's is ~110 chars).
  const prelude = text.slice(0, m.index);
  const preludeIsListing =
    RUN_DATES_RE.test(prelude) ||
    /@\w+\s*(theatre|theater)/i.test(prelude) ||
    (prelude.length >= 60 && !/[.!?]/.test(prelude));
  if (!preludeIsListing) return text;

  const remainder = text.slice(end).replace(/^[\s.…]+/, '');
  // Never strip everything — if the prelude is (almost) the whole text, the
  // caller is better off with the original than with a two-word husk.
  if (remainder.length < 100) return text;
  return remainder;
}

// ---------------------------------------------------------------------------
// Leading credits header (BRO-5718). Talkin' Broadway (and any outlet whose
// scrape keeps the byline block) opens the body with
//   "Theatre Review by Howard Miller - October 18, 2026. Other Desert Cities by
//    Jon Robin Baitz. Directed by Jane Doe. Scenic design by ... "
// and the raw-body fallback showed that as the pull quote until the LLM ran.
// stripLeadingCredits() drops that run so the slice starts at the first prose
// sentence. Conservative by construction: the run must open with a header or
// credit label, and every "<label> by" sentence must be NAMES ONLY, so prose
// like "Directed by Sam Mendes, this revival soars." is never touched.
// ---------------------------------------------------------------------------
const CREDITS_DATE = `\\s*[-–—|]\\s*(?:${MONTHS}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\\.?\\s+\\d{1,2},?\\s+20\\d\\d`;
const CREDITS_HEADER_RE = new RegExp(
  `^[Tt]heat(?:re|er) [Rr]eview(?:` +
  `\\s+by\\s+[A-Z][^\\n]{0,60}?(?=${CREDITS_DATE})(?:${CREDITS_DATE})` +
  `|\\s+by\\s+[A-Z][^.\\n]{0,60}?(?=\\s*\\.(?:\\s|$|\\n))` +
  `|\\s+by\\s+[A-Z][^.\\n]{0,60}?(?=\\n)` +
  `|${CREDITS_DATE})\\s*\\.?(?=\\s|$)`
);
const CREDIT_LABEL_BY = '(?:Directed|Written|Music|Lyrics|Book|Choreograph(?:ed|y)|Produced|Presented|Adapted|Orchestrations?|Original music|'
  + '(?:Scenic|Set|Costume|Lighting|Sound|Projection|Video|Hair|Wig|Makeup|Puppet|Fight|Movement|Music|Casting|Production)(?:\\s+and\\s+\\w+)?\\s+(?:design(?:ed)?|direction|supervision)|'
  + 'Photos?(?:\\s+credit)?)\\s+by\\b';
const CREDIT_LABEL_BY_G = new RegExp(CREDIT_LABEL_BY, 'gi');
const CREDIT_NAMES_COLON_RE = /^(?:Cast|Starring|Photos?(?:\s+credit)?)\s*:\s*/i;
const CREDIT_FACTS_COLON_RE = /^(?:Tickets|Running\s+time|Runtime|Venue)\s*:\s*/i;
const NAME_TOKEN_RE = /^(?:[A-Z][\w'’.\-]*|and|&|de|di|van|von|der|la|le|da|del|y)[,;.]?$/;
// Sentence split that does not break after an initial or title abbreviation.
const CREDIT_SENTENCE_SPLIT_RE = /\s*\n\s*|(?<=[.!?])(?<!\b(?:[A-Z]|Jr|Sr|St|Mr|Ms|Mrs|Dr)\.)\s+(?=["“‘']?[A-Z])/;

function isNamesOnly(s) {
  const toks = s.replace(/[–—]/g, ' ').split(/\s+/).filter(Boolean);
  return toks.length > 0 && toks.every(t => NAME_TOKEN_RE.test(t));
}

function normalizeCreditTitle(t) {
  return foldDiacritics(String(t || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.showTitle] enables the "<Show title> by <Author>." credit
 * @param {number} [opts.maxCreditsChars=700] the credits run must end within this
 * @returns {string} text minus the leading credits run, or the input unchanged
 */
function stripLeadingCredits(text, opts = {}) {
  if (!text || typeof text !== 'string') return text;
  const maxCreditsChars = opts.maxCreditsChars != null ? opts.maxCreditsChars : 700;
  const title = normalizeCreditTitle(opts.showTitle);
  let rest = text.replace(/^\s+/, '');
  let strong = false;

  const header = CREDITS_HEADER_RE.exec(rest);
  if (header) {
    strong = true;
    rest = rest.slice(header[0].length).replace(/^\s+/, '');
  }

  const sentences = rest.split(CREDIT_SENTENCE_SPLIT_RE);
  let consumed = 0;
  for (let i = 0; i < sentences.length - 1; i++) {
    const sent = sentences[i].trim();
    if (!sent || sent.length > 220) break;
    const body = sent.replace(/[.!?]+$/, '');
    let credit = false;
    const names = CREDIT_NAMES_COLON_RE.exec(body);
    const facts = !names && CREDIT_FACTS_COLON_RE.exec(body);
    if (names && isNamesOnly(body.slice(names[0].length))) {
      credit = true; strong = true;
    } else if (facts && body.length <= 90 && /[\d$]/.test(body)) {
      credit = true; strong = true;
    } else if (new RegExp('^' + CREDIT_LABEL_BY, 'i').test(body)) {
      if (isNamesOnly(body.replace(CREDIT_LABEL_BY_G, ' '))) { credit = true; strong = true; }
    } else if (title) {
      const m = /^(.{2,80}?)\s+by\s+(.+)$/.exec(body);
      if (m && normalizeCreditTitle(m[1]) === title && isNamesOnly(m[2])) credit = true;
    }
    if (!credit) break;
    consumed = i + 1;
  }
  if (!strong) return text;

  let pos = 0;
  for (let i = 0; i < consumed; i++) pos = rest.indexOf(sentences[i], pos) + sentences[i].length;
  const remainder = rest.slice(pos).replace(/^\s+/, '');
  const removed = text.length - remainder.length;
  if (removed > maxCreditsChars || remainder.length < 100) return text;
  return remainder;
}

// ---------------------------------------------------------------------------
// Tag-cloud excerpts (2026-08-01). The Reviews Hub renders its per-review tag
// list adjacent to the headline, and the LLM pull-quote extractor swallowed the
// whole run on A Midsummer Night's Dream (WE 2026):
//   "Funny but unmagical A Midsummer Night's Dream Atri Banerjee Issam Al
//    Ghussain Jenny Rainford London Mary Malone Nadeem Islam Naomi Dawson
//    Olivier Huband Regent's Park Open Air Theatre Review Terique Jarrett
//    Theatre Tomás Palmer William Shakespeare"
//
// Signature: no sentence punctuation anywhere, and a long unbroken run of
// capitalised tokens. Both conditions are required — headline-style pull quotes
// ("Full-blooded production of an undernourished play") have no sentence
// punctuation either, but no capitalised run.
// ---------------------------------------------------------------------------

// Thresholds calibrated against the full 19,309-quote corpus. The first pass
// (10 words / run 5 / ratio 0.5) produced two false positives on legitimate
// short quotes that happen to be title- and name-heavy:
//   ew / Betrayal 2019:      'B+ "Tom Hiddleston, Charlie Cox, and Zawe Ashton command a smart, stripped down 'Betrayal'"'
//   musical-theatre-review:  "The Royal Shakespeare Company's My Neighbour Totoro is actual magic"
// A real tag list is far longer and its capitalised run is unbroken: the
// Reviews Hub case is 36 words with a 33-token run. At 20 words / run 10 the
// two false positives clear and the real tag list still fires — verified by
// `node scripts/audit-pull-quotes.js` over the whole corpus.
const TAG_CLOUD_MIN_WORDS = 20;
const TAG_CLOUD_MIN_CAP_RUN = 10;
const TAG_CLOUD_MIN_CAP_RATIO = 0.6;

function isTagCloudExcerpt(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  const trimmed = excerpt.trim();
  // Any sentence punctuation means it is prose, not a tag list.
  if (/[.!?;:]/.test(trimmed)) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < TAG_CLOUD_MIN_WORDS) return false;

  let capped = 0;
  let run = 0;
  let longestRun = 0;
  for (const w of words) {
    // Strip wrapping punctuation/quotes before testing the first letter.
    const core = w.replace(/^[^\p{L}]+/u, '');
    if (/^\p{Lu}/u.test(core)) {
      capped++;
      run++;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
  }
  if (longestRun < TAG_CLOUD_MIN_CAP_RUN) return false;
  return capped / words.length >= TAG_CLOUD_MIN_CAP_RATIO;
}

// ---------------------------------------------------------------------------
// Mid-word truncation (2026-08-01). The LLM pull-quote extractor sometimes
// emits a quote cut mid-word — Evening Standard on Teeth 'n' Smiles shipped
// "...with Phil Daniels one of the few sa" while the sibling keyPhrase held the
// complete sentence ("...one of the few saving graces as the casually
// exploitative manager Saraffian.").
//
// Detected by evidence, not by dictionary: the candidate is a prefix of some
// source text (fullText, a keyPhrase quote, an aggregator excerpt) and the very
// next character in that source is a letter. A legitimately short headline
// standfirst is never a mid-word prefix of its own source, so this has no
// false-positive surface by construction.
// ---------------------------------------------------------------------------

// Symbol key for the per-call normalized-sources cache (see isMidWordTruncation).
const NORMALIZED_SOURCES = Symbol('normalizedSources');

// Fold the punctuation that differs between an LLM's re-typing of a quote and
// the scraped source (curly vs straight quotes, en/em dashes, NBSP runs).
function normalizeForSourceMatch(s) {
  return String(s)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is `excerpt` a mid-word truncation of any of `sourceTexts`?
 *
 * @param {string} excerpt
 * @param {string[]} sourceTexts  fullText / keyPhrase quotes / aggregator excerpts
 * @returns {boolean}
 */
function isMidWordTruncation(excerpt, sourceTexts) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  if (!Array.isArray(sourceTexts) || sourceTexts.length === 0) return false;

  // Strip wrapping quotes the LLM may have added, then drop a trailing ellipsis
  // (an explicit ellipsis is a deliberate elision, not an accidental cut).
  const cleaned = normalizeForSourceMatch(excerpt).replace(/^["']+|["']+$/g, '');
  if (/(\.\.\.|…)$/.test(cleaned)) return false;
  if (cleaned.length < 40) return false;
  // Ends in sentence punctuation → complete by construction.
  if (/[.!?]["']?$/.test(cleaned)) return false;

  // Normalizing a 5,000-char fullText once per CANDIDATE (and there are up to
  // ~9 candidates per review, across 19,309 reviews) was ~750MB of avoidable
  // string churn per rebuild — flagged in the 2026-08-01 Codex review. Cache
  // the normalized form on the caller's array so it is computed once per
  // review. Non-enumerable so the array still serializes/iterates normally.
  let normalized = sourceTexts[NORMALIZED_SOURCES];
  if (!normalized) {
    normalized = sourceTexts
      .filter(s => s && typeof s === 'string')
      .map(normalizeForSourceMatch);
    try {
      Object.defineProperty(sourceTexts, NORMALIZED_SOURCES, {
        value: normalized, enumerable: false, writable: true, configurable: true,
      });
    } catch (_) { /* frozen array — fall through, just uncached */ }
  }

  for (const hay of normalized) {
    const at = hay.indexOf(cleaned);
    if (at === -1) continue;
    const next = hay[at + cleaned.length];
    // A lowercase end followed by a capital is scraped text gluing a headline
    // to the next line ("...for the Resistance" + "By Jason Zinoman"), not a
    // word cut in half (BRO-5796). A short last word stays a cut: "Audra Mc" +
    // "Donald", "Patti Lu" + "Pone".
    if (/\p{L}{4,}$/u.test(cleaned) && /\p{Ll}$/u.test(cleaned) && next && /\p{Lu}/u.test(next)) continue;
    if (next && /\p{L}/u.test(next)) return true;
  }
  return false;
}

/**
 * Write-time hard guard for a freshly extracted llmPullQuote (BRO-5789).
 * audit-pull-quotes.js flags these classes on shipped quotes; extract-pull-quotes
 * stored them anyway and relied on a later rebuild to drop them. Returns the
 * audit's class name, or null when the quote may be stored.
 */
function llmQuoteHardRejectReason(quote, fullText) {
  if (isInternalNote(quote)) return 'internal-note';
  if (isMidWordTruncation(quote, fullText ? [fullText] : [])) return 'mid-word-truncation';
  if (typeof quote === 'string' && PUNCT_FRAGMENT_START_RE.test(quote)) return 'punctuation-start-fragment';
  if (typeof quote === 'string' && PAREN_ASIDE_START_RE.test(quote)) return 'parenthetical-start';
  return null;
}

// A stored llmPullQuote that fails the write-time guard is treated as absent,
// so the extractor's skip-if-present does not pin it forever: the rebuild
// drops or trims it and nothing else replaces it (BRO-5796).
// BRO-6631: a stored quote that only makes sense after the sentence before it
// is also re-extracted (the extractor now retries those), without making it a
// hard reject that review-field-edit would refuse. Once a re-extraction has
// also come back context-dependent (llmPullQuoteContextCheckedAt), it is kept.
function hasUsableLlmQuote(data) {
  return !!(data && data.llmPullQuote && !llmQuoteHardRejectReason(data.llmPullQuote, data.fullText)
    && !quoteOutsideTargetSection(data.llmPullQuote, data)
    && !quoteFromOtherShowPassage(data.llmPullQuote, data)
    && (data.llmPullQuoteContextCheckedAt || (!isContextDependentQuote(data.llmPullQuote, { showTitle: data.showTitle })
      && !startsMidClause(data.llmPullQuote, data.fullText))));
}

/**
 * BRO-8326: the quote sits in another show's part of the article, or in a news
 * column's lede ahead of this show (scripts/lib/pull-quote-other-show.js).
 * Returns the reason string or null. `show` is optional: a stored record only
 * carries its title, so cast evidence is used when the caller has the show.
 */
function quoteFromOtherShowPassage(quote, data, show) {
  const r = require('./pull-quote-other-show').quoteInOtherShowPassage(
    quote, data, show || { id: data && data.showId, title: data && data.showTitle });
  return r ? `${r.rule}: ${r.detail}` : null;
}

/**
 * BRO-7346: the text a pull quote may come from. A column that reviews several
 * shows (HuffPost/Finkle First Nighter, split by asterisk dividers) yields only
 * the target show's section; anything else yields the whole fullText. Uses the
 * scorer's own section split, so quote and score read the same section.
 * Before this, 6 live reviews showed a quote about another show in the column.
 */
function pullQuoteSourceText(data, showTitle) {
  const text = data && typeof data.fullText === 'string' ? data.fullText : '';
  const title = showTitle || (data && data.showTitle);
  if (!text || !title) return text;
  const { trimByAsteriskDivider } = require('./multi-show-asterisk-divider');
  const r = trimByAsteriskDivider(text, title, data);
  return r.trimmed ? r.text : text;
}

/** True when the quote is in the record's fullText but not in the target show's section of it. */
function quoteOutsideTargetSection(quote, data, showTitle) {
  if (!quote || !data || typeof data.fullText !== 'string') return false;
  const section = pullQuoteSourceText(data, showTitle);
  if (section === data.fullText) return false;
  const norm = (t) => foldDiacritics(String(t || '')).replace(/[‘’“”'"]/g, '').replace(/[\u2013\u2014]|--/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
  return !norm(section).includes(norm(quote));
}

/**
 * BRO-7977: on a combined multi-show column (one post reviewing several shows)
 * a quote must be about THIS show. The Sweat copy of a Theater Life Sheward
 * column shipped "Jones turns Yank's journey into a road trip to hell" (The
 * Hairy Ape). A joint column has no per-show footer to cut the text on, so the
 * test is positive evidence: the quote names a cast or creative-team member of
 * this show (full name or surname, never a lone first name; the title only
 * when the show has no such data). A quote with none of those is
 * unattributable in a combined column and is dropped, so a cleaner source wins.
 * Applies only to isCombinedReview records with combinedWith and a 'joint' split anchor; single-show
 * reviews are untouched. Pure (CLAUDE.md §15).
 */
function combinedColumnQuoteLacksOwnShow(quote, data, show) {
  if (!quote || !data || data.isCombinedReview !== true) return false;
  if (!Array.isArray(data.combinedWith) || data.combinedWith.length === 0) return false;
  // Only a column the section splitter could NOT separate (anchor 'joint': every show's text still in one body). Other
  // anchors were trimmed to this show's own section; unsplit files are flagged from a shared URL alone (748 of 964).
  // Child copies of a joint split carry only their own section; the parent keeps text about shows outside combinedWith.
  if (data.multiShowSplitAnchorKind !== 'joint' || data.multiShowSplitParent !== true) return false;
  const title = (show && show.title) || data.showTitle;
  if (!title) return false;
  const norm = (t) => ' ' + foldDiacritics(String(t || '').toLowerCase()).replace(/[’‘ʼ']/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const body = norm(quote);
  const names = [];
  for (const m of [...(show && show.cast || []), ...(show && show.creativeTeam || [])]) {
    const n = norm(m && typeof m === 'object' ? m.name : m).trim();
    if (n.split(' ').length < 2) continue;
    names.push(n, n.split(' ').pop()); // full name, then surname ("Nottage's script")
  }
  const bareTitle = norm(title).trim().replace(/^the /, '');
  // A title alone is not evidence: another show's sentence can name this one
  // ("predicted by Sweat and Hairy Ape"). It counts only when the record has
  // no cast or creative team to check instead.
  const needles = (names.length ? names : [bareTitle]).filter((n) => n && n.length >= 4);
  if (!needles.length) return false; // a title under 4 chars ("Hir") with no cast data: no usable evidence
  return !needles.some((n) => body.includes(' ' + n + ' ') || body.includes(' ' + n + 's ')); // "Nottage's" folds to "nottages"
}

// ---------------------------------------------------------------------------
// Contiguity: is the displayed quote a passage the critic actually wrote?
//
// 2026-10-19 audit: 2,970 of 26,321 displayed quotes were not a contiguous
// passage of the review's fullText. NY Post on Other Desert Cities dropped
// ", which opened Sunday night at the Hudson Theatre," from mid-sentence; the
// Guardian's quote stopped at "American rot." where the critic wrote "American
// rot – perhaps too eerily." extract-pull-quotes.verifyInText forgives an
// invented terminal period, and nothing in selectBestExcerpt checked
// keyPhrases / keyQuote / aggregator excerpts against the body at all.
//
// Normalization matches verifyInText (curly quotes, dashes, whitespace, case)
// but NOT its trailing-punctuation forgiveness: a period is accepted at the
// end only where the source also ends a sentence there. An interior "..." /
// "…" (or a bracketed editorial insertion) is an honest elision: each segment
// must be contiguous, in order.
// ---------------------------------------------------------------------------

// Fold the glyph differences verifyInText forgives (curly quotes, dash
// variants, ellipsis character), then collapse whitespace and the spacing
// around dashes. Lowercased: case never makes a quote non-contiguous.
function foldContiguityGlyphs(s) {
  // Single and double quote marks fold together: an outlet's “1776” is an
  // aggregator's '1776'.
  return String(s)
    .replace(/[‘’‚‛“”„‟"]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/…/g, '...');
}

function normalizeForContiguity(s) {
  return foldContiguityGlyphs(s)
    .replace(/\s+/g, ' ')
    .replace(/ *-+ */g, '-')
    .trim()
    .toLowerCase();
}

// Source form that keeps paragraph breaks as a single '\n' so a sentence end
// lost at a paragraph break can still be recognised (see sourceEndsSentenceAt).
function normalizeSourceKeepingBreaks(s) {
  return foldContiguityGlyphs(s)
    .replace(/[^\S\n]*\n\s*/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *-+ */g, '-')
    .trim()
    .toLowerCase();
}

const CONTIGUITY_SOURCE = Symbol('contiguitySource');

/** Normalized views of one source text, cached for the last text seen. */
function contiguityViews(fullText) {
  let cache = contiguityViews[CONTIGUITY_SOURCE];
  if (!cache || cache.raw !== fullText) {
    const breaks = normalizeSourceKeepingBreaks(fullText);
    // `hay` and `breaks` share every index: only '\n' -> ' ' differs.
    cache = { raw: fullText, breaks, hay: breaks.replace(/\n/g, ' '), sentences: null };
    contiguityViews[CONTIGUITY_SOURCE] = cache;
  }
  return cache;
}

// After `end` in the source, does a sentence end there: closing quotes /
// parens then terminal punctuation, end of text, or a paragraph break (a
// scrape that dropped the period before a new paragraph)? A continuing clause
// (", which", "– perhaps", "directed by", " Audra McDonald") does not.
function sourceEndsSentenceAt(breaks, end) {
  return /^["')\]]*(?:[.!?]|\.\.\.|\n|$)/.test(breaks.slice(end, end + 6));
}

function findSegment(views, seg, from) {
  const { hay, breaks } = views;
  const at = hay.indexOf(seg, from);
  if (at !== -1) return at + seg.length;
  // Terminal punctuation the source also has, possibly outside a closing quote
  // ('…called it "sublime."' vs '…called it "sublime".').
  const m = seg.match(/^(.*?)["')\]]*[.!?]+["')\]]*$/s);
  if (!m || m[1].length < 3) return -1;
  const body = m[1];
  let i = hay.indexOf(body, from);
  while (i !== -1) {
    if (sourceEndsSentenceAt(breaks, i + body.length)) return i + body.length;
    i = hay.indexOf(body, i + 1);
  }
  return -1;
}

function excerptSegments(excerpt) {
  const ex = normalizeForContiguity(excerpt)
    .replace(/^["'\s]+/, '')
    .replace(/["'\s]+$/, '');
  return ex
    .split(/\s*(?:\.\.\.|\[[^\]]*\])\s*/)
    .map(s => s.replace(/^["'\s]+|["'\s]+$/g, ''))
    .filter(Boolean);
}

/**
 * Is `excerpt` a contiguous passage of `fullText` (elisions allowed)?
 *
 * @param {string} excerpt   candidate pull quote (wrapping quotes tolerated)
 * @param {string} fullText  review body
 * @returns {boolean} true when contiguous, or when there is nothing to check
 */
function isContiguousInSource(excerpt, fullText) {
  if (!excerpt || typeof excerpt !== 'string') return true;
  if (!fullText || typeof fullText !== 'string') return true;
  const segments = excerptSegments(excerpt);
  if (segments.length === 0) return true;
  const views = contiguityViews(fullText);
  let cursor = 0;
  for (const seg of segments) {
    const end = findSegment(views, seg, cursor);
    if (end === -1) return false;
    cursor = end;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Snap: replace a non-contiguous quote with the real passage it came from.
//
// Deferring every non-contiguous candidate (first cut of this fix) handed the
// slot to worse quotes: a negative keyPhrase on a 78 review, or a raw-body
// plot summary / page chrome in place of the critic's verdict sentence. Most
// non-contiguous quotes are one source sentence with a clause dropped or an
// invented period ("…American rot." for "…American rot – perhaps too
// eerily."). Snapping displays that exact source sentence (or two
// consecutive sentences) instead, so the critic's own words win.
// ---------------------------------------------------------------------------

// Sentence ends in the original text: terminal punctuation (+ closing quotes)
// followed by whitespace and a sentence-starting character, or a newline.
// Not after an initial or a common abbreviation ("Christopher J. Hanke",
// "240 W. 44th", "Mr. Diamond"): splitting there snapped quotes that ended
// mid-name. Month abbreviations and military/academic titles too (BRO-6631:
// USA Today on A Few Good Men snapped to "...a bang-up revival that opened
// Oct." and the play is full of "Lt." / "Col." / "Cpl.").
const SOURCE_SENTENCE_SPLIT_RE = /(?<=[.!?]["'”’)\]]*)(?<!(?:^|[\s(])[A-Z]\.)(?<!\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Mt|No|Nos|Ave|Vol|vs|Lt|Col|Gen|Capt|Cpl|Sgt|Pvt|Cmdr|Adm|Maj|Prof|Gov|Hon)\.)(?<!\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.(?=\s+\d))\s+(?=["'“‘(\[]*[A-Z0-9])|\s*\n\s*/;

function sourceSentences(views) {
  if (views.sentences) return views.sentences;
  const raws = views.raw.split(SOURCE_SENTENCE_SPLIT_RE).map(x => (x || '').trim()).filter(Boolean);
  const list = [];
  let joined = '';
  for (const raw of raws) {
    const norm = normalizeForContiguity(raw);
    if (!norm) continue;
    if (joined) joined += ' ';
    list.push({ raw, norm, start: joined.length });
    joined += norm;
  }
  views.sentences = { list, joined };
  return views.sentences;
}

function sentenceIndexAt(list, pos) {
  let lo = 0, hi = list.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// BRO-7598: the whole source sentence a mid-clause quote was cut from, when the
// quote runs to that sentence's end and the sentence fits a pull quote. The
// expansion is the critic's own words from the sentence's first word, so it
// replaces the fragment without another LLM call ("Mr. Norris so superbly does
// in this troubling but terrific play." -> "A playwright’s responsibility isn’t
// to either forgive or condemn, ... as Mr. Norris so superbly does in this
// troubling but terrific play."). snapToSourceSpan cannot: its lead is capped
// at SNAP_MAX_LEAD to keep listing chrome out, and the lead here is the point.
function expandToSentenceStart(quote, fullText, { maxLen = MAX_QUOTE_LENGTH } = {}) {
  if (!startsMidClause(quote, fullText)) return null;
  const q = normalizeForContiguity(quote).replace(/^['(\[\s]+/, '').replace(/['")\]\s]+$/, '');
  const { list, joined } = sourceSentences(contiguityViews(fullText));
  const at = joined.indexOf(q);
  if (at === -1 || joined.indexOf(q, at + 1) !== -1) return null;
  const si = sentenceIndexAt(list, at);
  const sentence = list[si];
  // The quote must end where the sentence ends (closing marks aside).
  // The quote must end inside this one sentence, or the expansion would drop
  // whatever it carried past the sentence stop.
  if (at - sentence.start + q.length > sentence.norm.length) return null;
  const tail = sentence.norm.slice(at - sentence.start + q.length);
  if (!/^['")\]]*$/.test(tail)) return null;
  if (at === sentence.start || sentence.raw.length > maxLen) return null;
  if (!/[.!?]["'”’)\]]*$/.test(sentence.raw) || SNAP_CHROME_RE.test(sentence.raw)) return null;
  // A sentence that opens a quotation closed in a later sentence would ship
  // with a dangling opening mark; drop it.
  const raw = sentence.raw.trim();
  if (/^[“"]/.test(raw) && !/[”"]/.test(raw.slice(1))) return raw.slice(1);
  return raw;
}

// Anchors are short word runs from the start and end of the quote; a few
// alternative offsets tolerate a transcription slip right at either end
// ("performance" for "performances" in an aggregator copy).
const SNAP_ANCHOR_WORDS = 3;
const SNAP_ANCHOR_OFFSETS = 4;
const SNAP_MAX_SENTENCES = 2;
const SNAP_MIN_WORD_COVERAGE = 0.85;
// Source text the snap may add BEFORE the quote's first anchor. Small: a long
// lead means the sentence split missed a boundary and the span would drag in
// listing chrome ("Through June 18, $35-$298.50 www.audible.com Sexual…").
// The tail is bounded only by maxLen, so a quote cut mid-sentence (", not
// only through…") still snaps to its whole sentence.
const SNAP_MAX_LEAD = 40;
// When the quote is the start of a source sentence closed with an invented
// period and the whole sentence would add more than this, show the real
// prefix with an honest trailing "..." instead ("This “1776” pulsates with
// energy, snaps with attitude and enlivens history..."), not 200 chars of
// production detail. Shorter tails (the Guardian's "– perhaps too eerily")
// are restored in full: they can change the meaning.
const SNAP_PREFIX_SLACK = 120;
// Dateline/byline furniture too ("BY Aly Prouty Milwaukee PUBLISHED 1:12 PM
// ET Sep. 23, 2026 SHARE"): once "Sep." stopped ending a sentence (BRO-6631)
// a snap could swallow the whole header into the quote.
const SNAP_CHROME_RE = /©|\ball rights reserved\b|\bsubscribe\b|\bsign in\b|\b(?:PUBLISHED|UPDATED)\s+\d|\b\d{1,2}:\d{2}\s*[AP]M\b/i;

/**
 * Does any start/end anchor of `excerpt` occur in `fullText`? When none does,
 * the quote is not a modified copy of THIS text (an aggregator quoting the
 * print edition, or a body that is some other version): contiguity cannot be
 * judged, so it is no evidence of splicing.
 */
function isExcerptAnchoredInSource(excerpt, fullText) {
  if (!excerpt || !fullText || typeof excerpt !== 'string' || typeof fullText !== 'string') return false;
  const segments = excerptSegments(excerpt);
  if (!segments.length) return false;
  const { hay } = contiguityViews(fullText);
  const head = segments[0].split(' ');
  const tail = segments[segments.length - 1].replace(/["')\]]*[.!?]+["')\]]*$/, '').split(' ');
  for (let o = 0; o < SNAP_ANCHOR_OFFSETS; o++) {
    const f = head.slice(o, o + SNAP_ANCHOR_WORDS).join(' ');
    const l = tail.slice(Math.max(0, tail.length - SNAP_ANCHOR_WORDS - o), tail.length - o).join(' ');
    if ((f.length >= 10 && hay.includes(f)) || (l.length >= 10 && hay.includes(l))) return true;
  }
  return false;
}

/**
 * `excerpt` without its invented terminal punctuation, plus "...", when that
 * body is contiguous in `fullText` (the quote is a real prefix of a longer
 * sentence). Null otherwise.
 */
function honestPrefix(excerpt, fullText) {
  let body = excerpt.trim();
  const wrapped = /^["“'‘]/.test(body) && /["”'’]$/.test(body);
  if (wrapped) body = body.slice(1, -1).trim();
  body = body.replace(/[\s.!?…,;:–—-]+$/, '');
  if (body.length < 40 || !/[.!?]["”'’)]*$/.test(excerpt.trim())) return null;
  if (!isContiguousInSource(body, fullText)) return null;
  return body + '...';
}

/**
 * The exact source span (one or two consecutive sentences, ≤ maxLen chars)
 * that a non-contiguous `excerpt` was taken from, or null when there is no
 * such span. Never returns text that is not verbatim in `fullText`.
 *
 * @param {string} excerpt
 * @param {string} fullText
 * @param {{maxLen?: number}} [opts]
 * @returns {string|null}
 */
function snapToSourceSpan(excerpt, fullText, { maxLen = 350 } = {}) {
  if (!excerpt || !fullText || typeof excerpt !== 'string' || typeof fullText !== 'string') return null;
  const segments = excerptSegments(excerpt);
  if (!segments.length) return null;
  const headWords = segments[0].split(' ');
  const tailWords = segments[segments.length - 1].replace(/["')\]]*[.!?]+["')\]]*$/, '').split(' ');
  const firsts = [];
  const lasts = [];
  for (let o = 0; o < SNAP_ANCHOR_OFFSETS; o++) {
    const f = headWords.slice(o, o + SNAP_ANCHOR_WORDS).join(' ');
    const l = tailWords.slice(Math.max(0, tailWords.length - SNAP_ANCHOR_WORDS - o), tailWords.length - o).join(' ');
    if (f.length >= 10) firsts.push(f);
    if (l.length >= 10) lasts.push(l);
  }
  if (!firsts.length || !lasts.length) return null;

  const { list, joined } = sourceSentences(contiguityViews(fullText));
  if (!list.length) return null;
  const words = segments.join(' ').split(/[^a-z0-9']+/).filter(w => w.length >= 4);

  for (const first of firsts) {
    for (let a = joined.indexOf(first); a !== -1; a = joined.indexOf(first, a + 1)) {
      const si = sentenceIndexAt(list, a);
      if (a - list[si].start > SNAP_MAX_LEAD) continue;
      for (const last of lasts) {
        const b = joined.indexOf(last, a);
        if (b === -1) continue;
        const ei = sentenceIndexAt(list, b + last.length - 1);
        if (ei - si + 1 > SNAP_MAX_SENTENCES) continue;
        const span = list.slice(si, ei + 1).map(x => x.raw).join(' ');
        if (SNAP_CHROME_RE.test(span)) continue;
        // A span that does not end a sentence is a scrape cut mid-clause.
        if (!/[.!?]["'”’)\]]*$/.test(span)) continue;
        const spanNorm = normalizeForContiguity(span);
        const covered = words.filter(w => spanNorm.includes(w)).length;
        if (words.length && covered / words.length < SNAP_MIN_WORD_COVERAGE) continue;
        const prefix = honestPrefix(excerpt, fullText);
        if (prefix && (span.length > maxLen || span.length > excerpt.length + SNAP_PREFIX_SLACK)) return prefix;
        if (span.length > maxLen) continue;
        return span;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Which review bodies are authoritative enough to judge contiguity against.
// A body flagged as the wrong show / production / article, a roundup, or an
// 'invalid' tier is a different text: a correct aggregator quote "fails"
// against it (1536 / The Stage's Show Score quote vs an unrelated article).
// An auto-recovered wrongShow flag is a heuristic, trusted only once content
// verification has run and found no wrong article.
// ---------------------------------------------------------------------------
function isTrustedContiguitySource(data) {
  if (!data || typeof data.fullText !== 'string' || data.fullText.length <= 500) return false;
  if (data.textStatus === 'truncated') return false;
  if (data.wrongShow || data.wrongProduction || data.wrongFullText || data.isRoundupArticle) return false;
  if (data.contentTier === 'invalid') return false;
  // BRO-6439: a body that never mentions the show (showNotMentioned, e.g. an AP news feed recovered from
  // garbageFullText) is a different article, so a correct aggregator quote "fails" contiguity against it.
  if (data.showNotMentioned === true) return false;
  if (isSoft404Body(data.fullText)) return false;
  if (data.wrongShowAutoRecovered) {
    const cv = data.contentVerification;
    if (!cv || cv.wrongArticle || cv.wrongShow) return false;
  }
  return true;
}

// Share/gift/save toolbars that scrapes glue onto the first sentence
// ("Gift this articleShare Any honest musician…", NY Sun).
const SHARE_TOOLBAR_RE = /^(?:gift|share|save|listen to)\s+this\s+(?:article|story)/i;

/**
 * Does `text` open with page chrome rather than review prose? Narrower than
 * isChromeLine on purpose: that treats any line starting "By" as a byline,
 * which is wrong for prose ("By the end of the night…").
 */
function startsWithPageChrome(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim().replace(/^["'“‘]+/, '');
  // Navigation glued word-to-word by a scrape ("The New York SunJoin
  // TodaySign InArts+Neil Diamond…"): three or more lowercase→Uppercase joins
  // in the opening. Names alone (McDonald, LuPone) rarely reach three.
  if ((t.slice(0, 120).match(/[a-z][A-Z]/g) || []).length >= 3) return true;
  return SHARE_TOOLBAR_RE.test(t)
    || /^(?:Review|Photo|Credit|Venue|Production)\s*:/i.test(t)
    || /^read\s+(?:our|the)\s+(?:full\s+)?review\b/i.test(t)
    || /^(?:buy\s+tickets|tickets\s+from\s+\$)/i.test(t)
    || CREDITS_HEADER_RE.test(t);
}

/**
 * Page furniture inside the first lines of a review body that is not critic prose: a gallery counter ("1/7"), a byline
 * date glued to the text ("Henry Hitchings22 February 2019"), a "WHEN?:" / "RUNTIME:" listing block, a "(Picture: ...)"
 * caption, site navigation icons, "The tour continues until ..." run logistics. startsWithPageChrome() only defers such
 * a quote; a file stored "truncated" (BRO-8084) has nothing better to fall back to, so selectBestExcerpt drops it there.
 */
const BODY_FURNITURE_PATTERNS = [
  /^\W*\d{1,2}\s*\/\s*\d{1,2}\s+[A-Z]/,
  new RegExp(`[a-z]\\d{1,2}\\s+(?:${MONTHS})\\s+(?:19|20)\\d\\d`),
  /\b(?:WHEN|WHERE|RUNTIME|TICKETS|BOOKINGS?)\s*\?\s*:/,
  /\bIs This Your Show\?/i,
  /\((?:Pictures?|Photos?|Images?)\s*:/i,
  /\bPictures?\s*:\s+[A-Z][a-z]+ [A-Z]/,
  /\bwas reviewed at the\b/i,
  // Site promo / widget text and a glued "Theater review by <name>" byline (seen in the stored-truncated quote A/B)
  /\bGift unlocked article\b/i,
  /\bbook your tickets\b/i,
  /\bSee all \d+\b|\bAccess Captioned\b/,
  /\bthe reviews are in\b|\bsee what the critics\b/i,
  /^\W*More from\b/i,
  /^\W*Back to\s+(?:Plays|Shows|Musicals|Listings|Search|Results|all)\b/i,
  /^\W*Synopsis\s*:/i,
  /\*{3,}\s*Written by\b/,
  /^\W*[A-Z][a-z]+ [A-Z][a-z]+ reviews [A-Z]/,
  new RegExp(`^\\W*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?,?\\s+\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})`),
  /^\W*Theat(?:er|re) review by\b/i,
  /\bComment\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/,
  /\bCOMMENTS(?=[A-Z])/,
  /[\u{1F4F7}\u{1F3A5}\u{1F3F7}\u{1F465}\u{1F3AD}]/u,
  /^\W*(?:the\s+)?(?:tour|show|production|run|season)\s+(?:continues|runs|plays)\s+(?:until|through|to)\s+(?:\d{1,2}\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i,
];

function hasBodyFurniture(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  return BODY_FURNITURE_PATTERNS.some(re => re.test(excerpt));
}

// Bug #13: Off-topic excerpt detection. Very loose — only fires when there are
// NO theater-domain words AND NO show-title keywords. False positives (blocking
// a real review) are worse than letting a bad excerpt through.
//
// No trailing \b on inflected base forms (act, perform, direct, danc, sing, stor)
// so that plurals/inflections match without listing every variant:
//   act → actor, actors, actress, acting, acts
//   perform → performance, performed, performing, performer
//   direct → director, directing, directed, direction
//   danc → dance, dances, dancing, dancer
//   sing → singer, singers, singing, sung, song
//   stor → story, stories
//   adapt → adaptation, adapted, adapting
const THEATER_DOMAIN_RE = /\b(?:perform|musical|stages?|act(?:or|ress|ing|s\b)?|direct(?:or|ion|ing|ed)?|cast|scene|theater|theatre|show(?:s\b)?|production|choreograph|danc|sing(?:er)?|song|script|lyric|revival|broadway|west[\s-]end|opening[\s-]night|curtain|audience|playwright|narrative|dramatic|stagecraft|ensemble|understudy|character|ticket|adaptation|adapt|stor[yi])/i;

function isOffTopicExcerpt(excerpt, showId) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  // Any theater domain word → passes
  if (THEATER_DOMAIN_RE.test(excerpt)) return false;
  // Any show title keyword (from showId) → passes
  if (showId && typeof showId === 'string') {
    const titleWords = showId.split('-').filter(w => !/^\d{4}$/.test(w) && w.length >= 3);
    for (const word of titleWords) {
      try {
        if (new RegExp(`\\b${word}\\b`, 'i').test(excerpt)) return false;
      } catch (_) { /* ignore bad regex */ }
    }
  }
  return true;
}

// Bug #15: Page-chrome lines that leak into the assignedExcerpt fallback.
// Lost Boys 2026-04-26 Exeunt: "Review: The Lost Boys: The Musical at the
// Palace Theatre\nPalace Theatre ⋄ March 27, 2026-open-ended\nThis vampire
// musical succeeds...". Without a chrome-skip pass on the line-split text,
// "Review: ..." landed in the first "substantive" sentence and into the
// assignedExcerpt. These patterns identify lines that are header chrome,
// not review content.
const CHROME_LINE_PATTERNS = [
  // "Review: ...", "By Author", "Photo: Photographer", "Credit: ...",
  // "Venue: ...", "Production: ..."
  /^(Review|By|Photo|Credit|Venue|Production)\b/i,
  // NYTG/LondonTheatre SEO standfirst — "Read our review of <show>, now in
  // performances at <venue>..." leads the article body (Whoopi 2026-07-14).
  /^read\s+(?:our|the)\s+(?:full\s+)?review\b/i,
  // Cititour-style ticket CTA lines ("Tickets from $122", "Buy Tickets")
  /^(?:buy\s+tickets|tickets\s+from\s+\$)/i,
  // Just-a-name lines (byline or credit on its own line). Two-token Anglo
  // names; intentionally narrow — three-word/initial/hyphenated bylines
  // fall through to the ambiguous-line stop in stripLeadingChrome (we
  // don't risk over-stripping). Audit catches residual leakage.
  /^[A-Z][a-z]+\s+[A-Z][a-z]+\s*$/,
  // Venue line — 1-3 capitalized words (or "St", "The") followed by
  // Theatre/Theater/Hall/Auditorium/Playhouse. Catches "Palace Theatre",
  // "New Amsterdam Theatre", "Lincoln Center Theater", "St James Theatre".
  /^(?:(?:[A-Z][\w'.-]*|St\.?|The)\s+){1,3}(?:Theatre|Theater|Hall|Auditorium|Playhouse)\b/,
  // Date line MM/DD/YYYY or MM-DD-YYYY
  /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/,
  // Share / gift toolbar text ("Gift this article", "Share this story").
  /^(?:gift|share|save|listen to)\s+this\s+(?:article|story)/i,
];

// A line that looks like the start of the actual review body. We stop the
// chrome skip here. Ambiguous starters that ALSO commonly start chrome
// lines were intentionally excluded:
//   "From the producers of..."     → marketing/preamble
//   "As performed by..."           → cast credit
//   "Now playing at the Booth..."  → venue announcement
//   "But"                          → mid-sentence pivot, almost never the
//                                    real opening of a review
// Including these would let chrome lines win the narrative classification
// and bypass the chrome-skip — see Codex review (Session C, P1).
const NARRATIVE_STARTER_RE = /^(In|The|This|It|A|An|At|On|With|When|Watching|There|We|If|Although|Despite|After|While|My|His|Her|Its|Their|Director|Writer|For)\s+/;

function isChromeLine(line) {
  if (line == null) return true;
  if (!line.trim()) return true; // blank
  return CHROME_LINE_PATTERNS.some(re => re.test(line));
}

function isNarrativeLine(line) {
  if (!line) return false;
  const trimmed = line.trim();
  const wordCount = trimmed.split(/\s+/).length;
  const endsSentence = /[.!?]["\u201c\u201d'\u2018\u2019]?\s*$/.test(trimmed);
  if (wordCount >= 5 && endsSentence) return true;
  if (NARRATIVE_STARTER_RE.test(trimmed)) return true;
  return false;
}

/**
 * Skip leading page-chrome lines from fullText (header, byline, photo credit,
 * venue line, date line, blank lines) and return text starting from the first
 * narrative line, sliced to `maxLen`.
 *
 * Defense-in-depth fallback for selectBestExcerpt when upstream excerpt
 * sources (LLM keyPhrases, llmPullQuote, aggregator excerpts) are absent.
 *
 * Returns null when the heuristic would skip more than `maxSkipPct` of the
 * text — that signals the caller should use the raw fullText slice rather
 * than risk slicing in the wrong place.
 *
 * @param {string} fullText
 * @param {object} [opts]
 * @param {number} [opts.maxLen=600]     Max output length (chars)
 * @param {number} [opts.maxSkipPct=0.7] Max fraction of fullText the heuristic may skip
 * @returns {string|null}                Stripped text, or null on bail
 */
function stripLeadingChrome(fullText, opts = {}) {
  if (!fullText || typeof fullText !== 'string') return null;
  const maxLen = opts.maxLen != null ? opts.maxLen : 600;
  const maxSkipPct = opts.maxSkipPct != null ? opts.maxSkipPct : 0.7;

  const lines = fullText.split(/\r?\n/).map(l => l.trim());

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Chrome FIRST — so a header line that happens to satisfy narrative
    // shape (e.g. "By Jesse Green for The New York Times." has 8 words +
    // ends with period and would otherwise be classified as narrative)
    // still gets stripped. Reordered per Codex review (Session C, P1).
    if (isChromeLine(line)) continue;
    if (isNarrativeLine(line)) { startIdx = i; break; }
    // Ambiguous line — neither chrome nor narrative. Stop here so we
    // don't over-skip and accidentally consume a real opening sentence.
    startIdx = i;
    break;
  }

  // No narrative line found anywhere — the heuristic can't help. Bail.
  if (startIdx === -1) return null;

  // No chrome detected — return the original slice (no-op).
  if (startIdx === 0) return fullText.slice(0, maxLen);

  const skippedChars = lines.slice(0, startIdx).join('\n').length;
  if (skippedChars / fullText.length > maxSkipPct) return null;

  const stripped = lines.slice(startIdx).join('\n').trim();
  return stripped.slice(0, maxLen);
}


// ---------------------------------------------------------------------------
// Photo caption / credit / byline chrome inside a quote (BRO-8105).
//
// Six shipped quotes opened with, or contained, a photo credit scraped out of
// the page: "The Cast Photo by Evan Zimmerman There is precious little...",
// "Friedman Theatre (Photo credit: Matthew Murphy) Seen first...", "Photo by
// Victoria Wai Unfortunately...", "...Music Box Theatre. Credit: Cylla von
// Tiedemann/ She really isn't...", and a "Broadway Review | ... By Matt
// Windman ... Comments Posted on March 24, 2024." header. They came from the
// fullText steps of selectBestExcerpt, whose line-based chrome strip cannot
// see a credit that shares a line with prose.
//
// stripCaptionChrome is deliberately conservative (three reviewers, ship-check
// 2026-11-23): it only ever returns a SUBSTRING of its input, and it only cuts
//   - a page header at the very start,
//   - a credit at the head of the quote, together with the text before it only
//     when that text looks like a caption (capitalised words: a venue name),
//   - a credit later in the quote, by ending the quote just before it.
// Prose before a credit, and a credit whose name cannot be told from the next
// sentence, are left alone: a leftover caption is a visible, auditable defect,
// a deleted critic sentence is not.
const NAME_STOP = '(?!(?:The|There|This|That|These|It|Its|In|A|An|He|She|They|We|I|As|At|On|If|But|And|When|While|After|Unfortunately|Seen|Maybe|With|For|Of|By|From|Photo)\\b)';
const NAME_WORD = "\\p{Lu}[\\p{L}'\u2019.-]+";
const CREDIT_NAME = NAME_STOP + '(?:\\p{Lu}\\.\\s+' + NAME_WORD + '\\s+' + NAME_STOP + NAME_WORD
  + '|' + NAME_WORD + '(?:\\s+(?:\\p{Lu}\\.|van|von|de|der|del|la|le|da|di|Mc\\p{Lu}\\p{L}+))?\\s+' + NAME_STOP + NAME_WORD + ')';
const CREDIT_PAREN_RE = new RegExp('\\(\\s*(?:Photos?(?:\\s+credit)?|Credit|Courtesy|Photographer)\\s*(?:by|:)\\s*[^()]{1,80}\\)\\s*', 'iu');
const CREDIT_PHOTO_BY_RE = new RegExp('(?:\\b(?:The\\s+)?(?:Cast\\s+|Company\\s+)?Photo\\s+(?:by|credit:?)\\s+' + CREDIT_NAME + '|\\bCredit:\\s*' + CREDIT_NAME + '\\s*/)(?:\\s*\\/?\\s*(?:Provided|Courtesy)\\b)?\\s*', 'u');
// An outlet's page header ("Broadway Review | Title ... By X ... Comments
// Posted on March 24, 2024.") that runs into the first sentence.
const PAGE_HEADER_RE = /^[\s"'\u201c\u2018]*(?:Broadway|Off-Broadway|Theat(?:er|re))\s+Review\s*\|.{0,400}?\bPosted\s+on\s+[A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4}\.?\s*/;
// Text before a head credit that reads as a caption, not a sentence: capitalised
// words and a few joiners ("Friedman Theatre", "...Music Box Theatre.").
const CAPTION_HEAD_RE = /^[\s\u2026."'\u201c\u2018]*(?:(?:\p{Lu}[\p{L}'\u2019.&-]*|of|the|at|and|in|for|on)[\s.,]*){0,8}$/u;
const MIN_QUOTE_AFTER_STRIP = 30;

function stripCaptionChrome(excerpt) {
  if (typeof excerpt !== 'string' || !excerpt) return excerpt;
  let out = excerpt;
  const hdr = out.match(PAGE_HEADER_RE);
  if (hdr) out = out.slice(hdr[0].length);
  // After a page header, the text up to the first credit is the photo's caption line.
  let afterHeader = !!hdr;
  for (let pass = 0; pass < 3; pass++) {
    let hit = null;
    for (const re of [CREDIT_PAREN_RE, CREDIT_PHOTO_BY_RE]) {
      const m = out.match(re);
      if (m && (!hit || m.index < hit.index)) hit = m;
    }
    if (!hit) break;
    const head = out.slice(0, hit.index);
    if (afterHeader || CAPTION_HEAD_RE.test(head)) out = out.slice(hit.index + hit[0].length);
    else out = head.trim(); // credit after real prose: the quote ends where the caption starts
    afterHeader = false;
  }
  if (out === excerpt) return excerpt;
  out = out.replace(/^[\s\u2026./]+(?=["\u201c\u2018']?\p{Lu})/u, '').trim();
  // Nothing worth quoting is left (a caption-only candidate): the caller drops it.
  return out.length >= MIN_QUOTE_AFTER_STRIP ? out : '';
}

// ---------------------------------------------------------------------------
// Candidate ranking (2026-08-01).
//
// The hedge-opener / mid-sentence-pivot guard and the lowercase-fragment guard
// were HARD rejects, which produced two bad outcomes on score>=70 reviews whose
// only good quote happens to be hedged:
//
//   - Body Count / Theater Scene: the (good) llmPullQuote "Body Count may not
//     function as a comprehensive treatise..., but it is undeniably electric as
//     a performance vehicle." was killed by the ", but" pivot, so selection fell
//     all the way through to a raw fullText slice that ended mid-word.
//   - Les Misérables Arena / Cititour: every candidate was soft-rejected, so the
//     review shipped with NO pull quote at all (owner report).
//
// Both guards are now SOFT: the candidate is deferred rather than dropped. A
// deferred candidate is used when the only alternative is a raw-fullText slice
// (rank >= rawSourceRank) or nothing at all. Hard rejects (internal notes,
// copyright/listing chrome, promo teasers, tag clouds, mid-word truncation,
// cross-show mentions) still drop the candidate outright.
//
// Source ranks — lower is better; must match the try-order in
// rebuild-all-reviews.js selectBestExcerpt().
const EXCERPT_SOURCE_RANK = {
  llmPullQuote: 0,
  keyPhrase: 1,
  keyQuote: 2,
  showScoreExcerpt: 3,
  bwwExcerpt: 4,
  nycTheatreExcerpt: 5,
  stagedoorExcerpt: 6,
  dtliExcerpt: 7,
  // BRO-767: theatreReviewsExcerpt (761 files) and westEndTheatreExcerpt
  // (1,832 files) are curated evaluative quotes scraped from theatre.reviews
  // and West End Theatre, same shape as the aggregator excerpts above, but
  // were never wired into selectBestExcerpt — every review whose only
  // content was one of these fields shipped with pullQuote:null. lboRoundupExcerpt
  // (760 files) is lower quality (often a linked article's lead paragraph
  // rather than a hand-picked quote) but already treated as equivalent to
  // bwwExcerpt/dtliExcerpt everywhere else in the pipeline (contentTier
  // classification, hasExcerpt checks) — added here for consistency and
  // because the same validateExcerpt() guard chain screens it.
  theatreReviewsExcerpt: 8,
  westEndTheatreExcerpt: 9,
  lboRoundupExcerpt: 10,
  fullText: 11,
  'fullText-chrome-skip': 12,
  // Last-resort sources, deliberately ranked AFTER every fullText path so they
  // only fill reviews that would otherwise ship with no quote (zero churn on
  // existing quotes). theStageExcerpt (The Stage roundup blurbs, ~sweep-we-
  // aggregators/scrape-thestage-roundups) was stored but never read here;
  // outletStandfirst is the outlet's own standfirst salvaged from a
  // registration-walled page (walled-page-meta.js).
  theStageExcerpt: 13,
  outletStandfirst: 14,
  // BRO-5794: headline + standfirst of the review page (page-meta-evidence.js).
  metaExcerpt: 15,
};

// The first rank that is a raw scrape of the article body rather than a curated
// or LLM-selected quote. At or beyond this, a deferred higher-priority
// candidate is the better display choice.
const RAW_SOURCE_RANK = EXCERPT_SOURCE_RANK.fullText;

/**
 * Choose the excerpt to display from the accepted and deferred candidates.
 *
 * @param {object} args
 * @param {{rank:number, excerpt:string}|null} [args.accepted] First candidate that passed every guard
 * @param {Array<{rank:number, excerpt:string}>} [args.deferred] Soft-rejected candidates, any order
 * @param {number} [args.rawSourceRank=RAW_SOURCE_RANK]
 * @returns {string|null}
 */
function pickExcerptCandidate({ accepted = null, deferred = [], rawSourceRank = RAW_SOURCE_RANK } = {}) {
  const soft = (deferred || [])
    .filter(d => d && typeof d.excerpt === 'string' && d.excerpt)
    .slice()
    .sort((a, b) => a.rank - b.rank);

  // Only a HEDGE deferral may outrank an accepted raw-body slice. A hedge
  // deferral is a complete critic sentence that merely opens with "But"/"Yet"
  // or contains a ", but" pivot — still better prose than a page scrape.
  //
  // A LOWERCASE-FRAGMENT deferral is not: "and the score is sublime." reads as
  // broken mid-sentence text on the card, which is worse than a clean body
  // sentence that passed every guard (Codex adversarial review, 2026-08-01).
  // Fragments therefore only win when nothing at all was accepted.
  //
  // NON-CONTIGUOUS and OVERLONG deferrals are not either: a quote the critic
  // never wrote as one passage, or one hard-cut mid-sentence, must not displace
  // a contiguous body sentence. They are last resorts, ordered after every
  // hedge/fragment deferral (overlong first: its cut is an honest trailing
  // elision of a real passage), so a review is still never left quote-less.
  // Within the deferrals, a lower reason tier wins before source rank (a
  // hedged verbatim aggregator quote beats a paraphrased LLM one).
  const tier = d => DEFERRAL_REASON_TIER[d.reason] || 0;
  const byTier = soft.slice().sort((a, b) => tier(a) - tier(b) || a.rank - b.rank);
  const bestHedgeAboveRaw = byTier.find(d => d.rank < rawSourceRank && !FALLBACK_ONLY_REASONS.has(d.reason)) || null;

  if (accepted && accepted.excerpt) {
    if (accepted.rank < rawSourceRank) return accepted.excerpt;
    return bestHedgeAboveRaw ? bestHedgeAboveRaw.excerpt : accepted.excerpt;
  }
  return byTier.length ? byTier[0].excerpt : null;
}

// Deferral reasons that may never outrank an accepted candidate.
// 'non-contiguous' is NOT here: an unsnappable LLM/aggregator verdict that
// paraphrases slightly still beats a raw-body plot summary (Deadline / 1984,
// Variety / 1776 ship-check, 2026-10-19). It still loses to every accepted
// curated quote, which returns before raw ranks are reached.
// 'source-truncated' (BRO-6631) is deliberately NOT fallback-only: a clipped
// curated blurb still beats a raw body slice, but loses to any complete
// critic sentence that was only hedge- or contiguity-deferred (tier below).
const FALLBACK_ONLY_REASONS = new Set(['lowercase-fragment', 'overlong', 'sentiment-mismatch', 'page-chrome', 'parenthetical-aside']);
// When nothing was accepted: lower tier wins, then source rank.
// 'parenthetical-aside' (BRO-7675) ranks last: an aside is never the verdict.
const DEFERRAL_REASON_TIER = { overlong: 1, 'non-contiguous': 2, 'source-truncated': 2.5, 'sentiment-mismatch': 3, 'page-chrome': 4, 'parenthetical-aside': 5 };

module.exports = {
  combinedColumnQuoteLacksOwnShow,
  isContextDependentQuote,
  CONTEXT_DEPENDENT_PATTERNS,
  startsMidClause,
  startsAsFragment,
  FRAGMENT_START_RE,
  PUNCT_FRAGMENT_START_RE,
  PAREN_ASIDE_START_RE,
  stripLeadingParenAside,
  expandToSentenceStart,
  endsWithSourceEllipsis,
  isClippedAggregatorBlurb,
  llmQuoteHardRejectReason,
  hasUsableLlmQuote,
  pullQuoteSourceText,
  quoteOutsideTargetSection,
  quoteFromOtherShowPassage,
  HEDGE_OPENER_RE,
  MID_SENTENCE_PIVOT_RE,
  MIN_QUOTE_LENGTH,
  MAX_QUOTE_LENGTH,
  isBadCandidateLength,
  isHedgeOpener,
  hasMidSentencePivot,
  shouldRejectAsReservation,
  phraseContradictsScore,
  isInternalNote,
  hasCopyrightChrome,
  isPromoTeaser,
  isInServiceSection,
  SERVICE_SECTION_HEADING_RE,
  PROMO_TEASER_PATTERNS,
  isOffTopicExcerpt,
  COPYRIGHT_CHROME_PATTERNS,
  THEATER_DOMAIN_RE,
  CHROME_LINE_PATTERNS,
  NARRATIVE_STARTER_RE,
  isChromeLine,
  isNarrativeLine,
  stripLeadingChrome,
  stripCaptionChrome,
  // Listing / credits chrome
  LISTING_CHROME_PATTERNS,
  LISTING_TERMINATOR_RE,
  RUN_DATES_RE,
  hasListingChrome,
  stripListingPrelude,
  stripLeadingCredits,
  CREDITS_HEADER_RE,
  // Tag clouds
  isTagCloudExcerpt,
  // Mid-word truncation
  isMidWordTruncation,
  normalizeForSourceMatch,
  // Contiguity against the review body
  isContiguousInSource,
  normalizeForContiguity,
  snapToSourceSpan,
  isExcerptAnchoredInSource,
  isTrustedContiguitySource,
  startsWithPageChrome,
  hasBodyFurniture,
  // Candidate ranking
  EXCERPT_SOURCE_RANK,
  RAW_SOURCE_RANK,
  pickExcerptCandidate,
  FALLBACK_ONLY_REASONS,
};
