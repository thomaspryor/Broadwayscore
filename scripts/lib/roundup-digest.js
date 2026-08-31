'use strict';

const { isRegisteredOutlet, normalizeOutlet } = require('./review-normalization');
const { foldDiacritics } = require('./title-match');

/**
 * roundup-digest.js — detect a review record that is actually a REVIEW-ROUNDUP
 * digest (an aggregator's "Reviews are in for X" compilation), not an individual
 * critic's review.
 *
 * Why this exists (2026-06-30): WestEndTheatre.com roundup landing pages were
 * scraped and stored under INDIVIDUAL outlet ids (telegraph/timeout/standard)
 * with the WET staff byline ("Ghenet Pinderhughes Randall", "West End Theatre",
 * "Luke Dillon", "Julianna Barnaby") or an outlet-name-as-critic. 63 such files;
 * the write-time roundup guard only covered BWW (/article/Review-Roundup-/) and
 * LBO URLs, never WET. These digests carry a blended score (78-97) and, if ever
 * scored/included, would be a phantom review. (Only 1 of the 63 was a true
 * individual review — a real critic excerpt relayed via WET — so detection must
 * NOT fire on those.)
 *
 * Precision: a real critic's relayed excerpt (e.g. Tim Bano / FT prose on a WET
 * url) is a legitimate aggregator-sourced review and must be preserved. So we
 * flag ONLY on high-confidence digest signals:
 *   1. fullText opens with roundup-digest phrasing ("reviews are in/out/coming",
 *      "round-up of reviews", "the critics have delivered", "unanimous praise
 *      from the critics", ...).
 *   2. criticName is a PUBLICATION name (an outlet can't be an individual critic —
 *      that's an aggregation artifact).
 *   3. criticName is a known WET roundup author AND the url is a WET page (these
 *      names appear only/overwhelmingly on westendtheatre.com roundup pages).
 *
 * Pure function; unit-tested. Used by review-file-writer.js (write-time guard)
 * and the one-time flag-wet-roundup-misattributions.js cleanup.
 */

// Tight, roundup-SPECIFIC openings only — loose phrasing like "the critics have
// had their say" appears in ordinary reviews and caused false positives on legit
// ft.com / thestage.co.uk reviews (2026-06-30).
const ROUNDUP_DIGEST_TEXT = /(the\s+)?reviews are (in|out|coming out)\b|round-?up of reviews|review(s)? round-?up|a reviews round-?up|reviews are coming out from/i;

// criticName values that are actually publication names — an aggregation artifact.
const PUBLICATION_NAMES = new Set([
  'daily telegraph', 'the telegraph', 'the times', 'the independent',
  'evening standard', 'daily mail', 'the guardian', 'the stage',
  'financial times', 'metro', 'the observer', 'the sun', 'time out',
]);

// Known WestEndTheatre roundup compilers (grep-verified to appear only/almost-only
// on westendtheatre.com urls, never as a standalone outlet critic).
const WET_ROUNDUP_AUTHORS = new Set([
  'west end theatre', 'west end theatre editorial',
  'ghenet pinderhughes randall', 'luke dillon', 'julianna barnaby',
]);

function isWetUrl(url) {
  return typeof url === 'string' && /westendtheatre\.com/i.test(url);
}

/**
 * Detect a review record that is actually a WestEndTheatre review-roundup digest
 * mis-stored under an individual outlet id.
 *
 * PRECONDITION (eliminates false positives): the url must be a WestEndTheatre.com
 * page AND the outletId must NOT be westendtheatre. A legitimate review on its own
 * domain (ft.com bylined "Financial Times", thestage.co.uk) never matches — the
 * url/outlet mismatch is what makes a WET page mis-attributed. Within that set,
 * digest phrasing / publication-name byline / known WET roundup author separate a
 * roundup DIGEST (flag) from a real critic's excerpt relayed via WET (keep — e.g.
 * Tim Bano / FT).
 *
 * @param {object} rec - { fullText, criticName, url, outletId }
 * @returns {{ isRoundup: true, reason: string } | null}
 */
function detectRoundupDigest(rec) {
  if (!rec) return null;
  // Precondition: WET url mis-attributed to a non-WET outlet.
  if (!isWetUrl(rec.url)) return null;
  const outlet = (rec.outletId || '').trim().toLowerCase();
  if (outlet === 'westendtheatre' || outlet === '') return null;

  const text = (rec.fullText || '').slice(0, 300);
  const critic = (rec.criticName || '').trim().toLowerCase();

  if (text && ROUNDUP_DIGEST_TEXT.test(text)) {
    return { isRoundup: true, reason: 'WET roundup digest: text opens with review-roundup phrasing' };
  }
  if (critic && PUBLICATION_NAMES.has(critic)) {
    return { isRoundup: true, reason: `WET roundup digest: criticName is a publication name ("${rec.criticName}")` };
  }
  if (critic && WET_ROUNDUP_AUTHORS.has(critic)) {
    return { isRoundup: true, reason: `WET roundup digest: WestEndTheatre roundup author ("${rec.criticName}")` };
  }
  return null;
}

// Matches "{Proper Name}, {Outlet Name}" immediately followed by a sentence
// terminator (period or colon) — the shape a compiler uses to attribute each
// quoted excerpt to its source critic. Name allows apostrophes/periods/hyphens
// (O'Hara, St. John); outlet allows "&", "/", apostrophes for names like
// "Time Out" or "Talkin' Broadway".
const ATTRIBUTION_RE = /\b([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3}),\s+([A-Z][A-Za-z0-9&'.\-/ ]{2,40}?)\s*[.:]/g;

// Matches the prose-narrative attribution shape a "sampling of the critical
// reaction" compilation uses instead of the "{Name}, {Outlet}." comma shape —
// "{Outlet}'s {Critic} {verb}..." (e.g. "Variety's Frank Rizzo agrees,
// writing:", "Time Out New York's Raven Snook pens a four-star rave"). Group 1
// is the outlet, group 2 the critic — reversed order from ATTRIBUTION_RE.
// `\s?'s` (not a bare `'s`) tolerates a stray space before the apostrophe —
// a real scraper artifact (Gold Derby's goldderby--ethan-alter.json fullText
// has "Entertainment Weekly 's Emlyn Travis", "Variety 's Frank Rizzo") that
// otherwise makes the whole signal a silent no-op on the exact file BRO-2520
// is about.
const POSSESSIVE_ATTRIBUTION_RE = /\b([A-Z][A-Za-z0-9&'.\-/ ]{2,40}?)\s?'s\s+([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3})\b/g;

// A THIRD prose shape: "{Critic} of {Outlet} {verb}..." (e.g. "Ron Fassler of
// Theater Pizzaz also yearned for something a bit more substantial"). Group 1
// is the critic, group 2 the outlet — same order as ATTRIBUTION_RE.
const OF_ATTRIBUTION_RE = /\b([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,2})\s+of\s+([A-Z][A-Za-z0-9&'.\-/ ]{2,40}?)\b(?=\s+(?:also|said|writes?|wrote|notes?|noted|adds?|added|argues?|argued))/g;

// A leading conjunction ("And Time Out New York's Raven Snook...") gets swept
// into the possessive shape's non-greedy outlet capture because the capture
// starts at the sentence's first capitalized word, not the outlet's actual
// first word. Strip it before the outlet is checked against the registry —
// "And Time Out New York" isn't a registered outlet, "Time Out New York" is.
const LEADING_CONJUNCTION_RE = /^(?:and|but|while|yet|so|meanwhile|then|similarly|however|also)\s+/i;
function stripLeadingConjunction(outlet) {
  return outlet.replace(LEADING_CONJUNCTION_RE, '');
}

// Phrases a "critical consensus" / pull-quote compilation page uses to
// introduce the block of other outlets' excerpts. Deliberately narrower than
// ROUNDUP_DIGEST_TEXT above (which is WET-specific and precondition-gated) —
// this one runs outlet-agnostic, so it only checks the opening of the text.
const CONSENSUS_INTRO_TEXT = /critical consensus|here'?s what (?:the )?critics (?:are saying|had to say)|reviews are in for/i;

function normalizeNameForCompare(name) {
  // Fold diacritics BEFORE the ASCII strip: without the fold, /[^a-z\s]/
  // DELETES accented letters outright ("Libération" -> "libration"), so an
  // accented byline never matches its unaccented attribution-block spelling.
  return foldDiacritics(name || '').toLowerCase().trim().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ');
}

// True when candidateName plausibly refers to the same person as byline —
// exact match, or shared last name (handles "Brian Lipton" byline vs "Brian
// Scott Lipton" attribution-block spelling).
function isSameCritic(candidateName, byline) {
  const a = normalizeNameForCompare(candidateName);
  const b = normalizeNameForCompare(byline);
  if (!a || !b) return false;
  if (a === b) return true;
  const lastA = a.split(' ').pop();
  const lastB = b.split(' ').pop();
  return lastA.length > 2 && lastA === lastB;
}

/**
 * Detect a "critical consensus" / pull-quote compilation page stored under an
 * individual critic's own byline — the New York Theater (newyorktheater.me)
 * shape (task #1888): the page opens with a sentence or two of the compiler's
 * own framing, then a flat list of "{Critic}, {Outlet}: {quoted excerpt}"
 * blocks for several OTHER outlets. No "Roundup" wording anywhere, and (unlike
 * the WET digest above) not gated to one aggregator host — the page reads
 * structurally like the byline critic's own review.
 *
 * Precision: a real critic's review that quotes ONE rival critic in passing
 * ("as The Guardian's Michael Billington wrote...") must not trip this. So we
 * require either (a) 3+ distinct OTHER outlets attributed via the
 * "{Name}, {Outlet}." pattern, cross-checked against the outlet registry so
 * random capitalized phrases can't count as an "outlet", or (b) a consensus-
 * intro phrase near the top of the text PLUS 2+ distinct other-outlet
 * attributions corroborating it (the intro phrase alone is too common in
 * ordinary review ledes to fire on its own).
 *
 * A second guard: if the file's OWN byline critic appears as one of the
 * attributed "{Name}, {Outlet}" blocks, this is a syndicated wire-service
 * digest that happens to carry THEIR verdict alongside others' (e.g. Howard
 * Kissel / NY Daily News inside a 1991 AP-style multi-critic newspaper
 * roundup on miss-saigon-1991) rather than a compilation mis-stored under an
 * uninvolved compiler's name — do not flag, since the file legitimately
 * represents that critic's own review.
 *
 * @param {object} rec - { fullText, outletId, criticName }
 * @returns {{ isRoundup: true, reason: string } | null}
 */
// Minimum characters of quoted material an attribution block must be followed
// by to count as evidence of a compilation. The outlet registry legitimately
// registers several bare common-English-word aliases (Time, Post, Stage,
// Mirror, Observer, People, Herald...), so isRegisteredOutlet() alone can't
// tell a real "{Critic}, {Outlet}: {excerpt}" compilation block apart from an
// ordinary review's marketing pull-quote footer ('"A must-see!" — J. Smith,
// Time. "Electrifying" — A. Jones, Observer.') — both hit the outlet-name
// shape, but the footer's "quotes" are one-line blurbs, not real excerpts.
// A genuine compilation always follows each attribution with a full-sentence
// excerpt; a marketing footer's punchy one-liners don't clear this bar.
const MIN_EXCERPT_CHARS = 60;

// A straight or curly DOUBLE quote mark — required inside a possessive-shape
// match's trailing span so "Variety's readers loved it" (no quoted excerpt)
// can't count as a compilation block the way "Variety's Frank Rizzo agrees,
// writing: "..."" does. The comma shape doesn't need this extra guard: its
// tighter "{Name}, {Outlet}." grammar is already compilation-specific.
// Deliberately DOUBLE-quote-only, not a bare ['''] apostrophe class — the
// possessive shape itself ends in "'s", and ordinary English prose is full of
// apostrophes (contractions like "didn't", "it's"), so an apostrophe-inclusive
// class matched almost any paragraph and made this guard a no-op (caught in
// review: a BBC News interview/profile piece with ordinary contractions
// tripped the old class even before reaching its own quoted excerpts).
// Known tradeoff (review, BRO-2520): a UK compilation that quotes exclusively
// with curly single quotes (‘…’) rather than double quotes will NOT satisfy
// this gate and stays unflagged via the possessive/of shapes — U+2019 (’) is
// also the character British typesetting uses for a contraction's apostrophe
// ("didn't"), so admitting it here would reopen the exact same false-positive
// class this guard exists to close. Double-quote-only is the safe default;
// see the "does NOT flag ... single/curly-single quotes" test below.
const QUOTE_CHAR_RE = /["“”]/;

function detectPullQuoteCompilation(rec) {
  if (!rec || !rec.fullText) return null;
  const text = rec.fullText;
  const ownOutlet = normalizeOutlet((rec.outletId || '').trim());
  const byline = rec.criticName || '';

  const rawMatches = [];
  let match;
  ATTRIBUTION_RE.lastIndex = 0;
  while ((match = ATTRIBUTION_RE.exec(text))) {
    rawMatches.push({
      name: match[1].trim(),
      outlet: match[2].trim(),
      start: match.index,
      end: match.index + match[0].length,
      requireQuote: false,
    });
  }
  POSSESSIVE_ATTRIBUTION_RE.lastIndex = 0;
  while ((match = POSSESSIVE_ATTRIBUTION_RE.exec(text))) {
    rawMatches.push({
      name: match[2].trim(),
      outlet: stripLeadingConjunction(match[1].trim()),
      start: match.index,
      end: match.index + match[0].length,
      requireQuote: true,
    });
  }
  OF_ATTRIBUTION_RE.lastIndex = 0;
  while ((match = OF_ATTRIBUTION_RE.exec(text))) {
    rawMatches.push({
      name: match[1].trim(),
      outlet: match[2].trim(),
      start: match.index,
      end: match.index + match[0].length,
      requireQuote: true,
    });
  }
  rawMatches.sort((a, b) => a.start - b.start);
  // Drop a match whose span overlaps the previous kept match's span — the
  // comma shape and possessive shape can't both match the SAME clause (their
  // grammars conflict), but this guards against either regex matching twice
  // within one sentence (e.g. two capitalized-name runs close together) from
  // being double-counted as two separate attribution blocks.
  const dedupedMatches = [];
  let lastEnd = -1;
  for (const m of rawMatches) {
    if (m.start < lastEnd) continue;
    dedupedMatches.push(m);
    lastEnd = m.end;
  }

  const distinctOutlets = new Set();
  for (let i = 0; i < dedupedMatches.length; i++) {
    const { name, outlet, end, requireQuote } = dedupedMatches[i];
    if (isSameCritic(name, byline)) {
      // The byline critic's own verdict is embedded here — this file is
      // legitimately theirs even though it quotes other outlets too.
      return null;
    }
    const excerptEnd = i + 1 < dedupedMatches.length ? dedupedMatches[i + 1].start : text.length;
    const excerpt = text.slice(end, excerptEnd);
    if (excerpt.length < MIN_EXCERPT_CHARS) continue; // one-line blurb, not a real excerpt
    if (requireQuote && !QUOTE_CHAR_RE.test(excerpt)) continue; // possessive shape needs a quoted excerpt, not just prose
    if (!isRegisteredOutlet(outlet)) continue;
    const resolved = normalizeOutlet(outlet);
    if (resolved === ownOutlet) continue; // don't count the byline's own outlet
    distinctOutlets.add(resolved);
  }

  if (distinctOutlets.size >= 3) {
    return {
      isRoundup: true,
      reason: `pull-quote compilation: fullText attributes excerpts to ${distinctOutlets.size} distinct outlets (${[...distinctOutlets].slice(0, 5).join(', ')})`,
    };
  }

  const head = text.slice(0, 600);
  const introMatch = head.match(CONSENSUS_INTRO_TEXT);
  if (introMatch && distinctOutlets.size >= 2) {
    return {
      isRoundup: true,
      reason: `pull-quote compilation: "${introMatch[0]}" intro phrase + ${distinctOutlets.size} distinct other-outlet attributions`,
    };
  }

  return null;
}

module.exports = {
  detectRoundupDigest,
  detectPullQuoteCompilation,
  ROUNDUP_DIGEST_TEXT,
  PUBLICATION_NAMES,
  WET_ROUNDUP_AUTHORS,
};
