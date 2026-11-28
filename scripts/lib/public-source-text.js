'use strict';

// Which commercial source text is safe to print, and which capitalization is
// our estimate rather than a reported figure. Plain CommonJS so the site
// (src/lib/commercial-display.ts re-exports both) and the newsletter
// (scripts/newsletter/generate.mjs) share one rule (BRO-5517).

// Internal research-tooling language that must never be printed as a public
// source line (records carried "GPT DR Batch 3: ~$800-900K...", "Trade press /
// deep research synthesis", "SEC filings (GPT Deep Research)"). The data text
// is being cleaned separately; this is the guard against it coming back.
// "Auto-enrolled stub; awaiting model + curation." is the placeholder note
// scripts/initialize-commercial-stub.js writes on every new record.
// "Per policy applied 2026-05-24: ..." and "Kept ... per owner review" are
// hand-edit notes about our own process (BRO-4669). A blog or Reddit
// characterisation ("Financing Broadway blog states it closed at a loss") is
// not a citation the page may print (BRO-5020 Group C); the label still shows.
const INTERNAL_SOURCE_RE =
  /(?:chat)?gpt|deep[\s-]*research|\bDR\s*batch\b|\breddit\b|\bblog(?:s|ger|post)?\b|\bconsensus\b|\bsynthes[ie][sz]|\binferred\b|industry[\s-]*estimate|\bauto[\s-]*enroll?ed\b|\bawaiting\s+(?:the\s+)?(?:model|curation|research)\b|\bper\s+policy\b|\bowner\s+(?:review|decision|sign-?off)\b/i;

// Record field names written as code: "recouped:null because no public
// citation", "designation=Nonprofit" (BRO-4669). Case-sensitive (a lowercase
// field name) so prose like "Based on a True story" never matches; tested with
// URLs removed so a query string ("?type=D") is not mistaken for one.
const INTERNAL_TOKEN_RE = /\b[a-z][A-Za-z]*\s?[:=]\s?(?:true|false|null)\b|\b[a-z][A-Za-z]*=[A-Z]/;
const URL_RE = /\bhttps?:\/\/\S+/gi;
// The New York Times ran its theater news (ArtsBeat) on blogs.nytimes.com, so
// a link there is the newspaper, not a blog (BRO-5562).
const NEWSPAPER_BLOG_HOST_RE = /\b[\w.-]*blogs\.nytimes\.com(?!\.?[\w-])/gi;

// A source line that is only a vague attribution ("Industry sources", "Trade
// sources") names no source, so it cannot make a figure read as reported
// (BRO-5562: proof's $500K weekly cost printed as reported on "Industry
// sources"). Rewordings of the same nothing count too ("Per industry sources",
// "Industry source(s)", "Sources say", "Sources:"). A longer line that names
// one ("Sources: SEC Form D", "Industry sources (Variety)") is judged as a whole.
const VAGUE_ATTRIBUTION_RE =
  /^(?:(?:according to|per|via|from|citing)\s+)?(?:(?:unnamed|anonymous|unidentified)\s+)?(?:(?:industry|trade|insider|producer|production|theat(?:er|re)|broadway|market|press|financial)\s+)?sources?(?:\s*\(s\))?(?:\s*\((?:unnamed|anonymous|not named)\))?(?:\s+(?:say|says|said|report|reports|reported|indicate|indicated|suggest|suggested))?[\s.:;,–—-]*$/i;

// Bracketed pipeline annotations appended to otherwise publishable notes:
// "[Auto-designated Fizzle: ...]" (scripts/cleanup-commercial-data.js) and
// "[PLAUSIBILITY WARNING: ...]" (the research/backfill scripts). Only the
// bracket is internal, so it is cut and the rest of the note survives.
const INTERNAL_ANNOTATION_RE = /\[\s*(?:auto[\s-]*(?:designated|enroll?ed)|plausibility\s+warning)\b[^\]]*\]/gi;


/**
 * Source text that is safe to print verbatim, else null. Callers render no
 * source line (or a methodology label) when this returns null.
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
function publicSourceText(text) {
  if (typeof text !== 'string') return null;
  const stripped = text.replace(INTERNAL_ANNOTATION_RE, ' ');
  const trimmed = (stripped === text ? text : stripped.replace(/[ \t]{2,}/g, ' ')).trim();
  if (!trimmed || VAGUE_ATTRIBUTION_RE.test(trimmed)) return null;
  if (INTERNAL_SOURCE_RE.test(trimmed.replace(NEWSPAPER_BLOG_HOST_RE, 'nytimes.com')) || INTERNAL_TOKEN_RE.test(trimmed.replace(URL_RE, ' '))) return null;
  return trimmed;
}

// recoupedSource prose that says outright there was no announcement. Used
// ONLY to downgrade the label ("Not publicly announced"), never to claim an
// announcement, so a missed phrase under-claims instead of fabricating one.
// (Aladdin: "Disney never formally announces recoupment."; Lion King and
// Aladdin later read "Disney does not announce recoupments.", which the
// pattern missed, so both printed as announced: BRO-4722.) The record checks
// read it too (BRO-5562), so the site and the data share one rule; there a
// missed phrase refuses a correctly flagged write, so the data's own wording
// ("No recoupment was announced.", "Recouped without an announcement.",
// contractions) is covered. "Editorial" counts only as our editorial judgment,
// never a newspaper's editorial. Each wording can only mean the recoupment
// went unannounced; words that also sit beside a reported recoupment are left
// out ("previously unannounced, confirmed by Deadline", "figures were not
// disclosed"), because an over-match silently labels a reported recoupment
// "Not publicly announced". A miss is loud instead: the record checks refuse
// the flagged write and name the sentence to write. No "confirmed later"
// lookahead either (BRO-5562 review): it cancelled plain wordings ("estimated
// at the time of closing", "confirmed by grosses analysis").
const NOT_ANNOUNCED_RE = new RegExp([
  String.raw`\bno (?:public |producer |formal |official )?(?:recoupment )?announcement\b`,
  String.raw`\bno (?:public |formal |official )?recoupment (?:was |has been |had been |is )?(?:formally |publicly |officially )?announced\b`,
  String.raw`\bwithout (?:an? |any )?(?:public |formal |official )?announc(?:ement|ing)\b`,
  String.raw`\bnever (?:formally |publicly |officially )?announce[sd]?\b`,
  String.raw`\b(?:not|(?:is|are|was|were|has|have|had)n['’]t) (?:yet )?(?:been )?(?:formally |publicly |officially )?announced\b`,
  String.raw`\b(?:does|do|did)(?: not|n['’]t) (?:formally |publicly |officially )?announce(?:s|ments?)?\b`,
  String.raw`(?:\b(?:never|not)|n['’]t) (?:made?|make|issued?) (?:an? |any )?(?:public |formal |official )?announcement\b`,
  String.raw`\beditorial judg(?:e)?ment\b`,
].join('|'), 'i');

/**
 * True when a recoupedSource says the recoupment was never announced.
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
function saysRecoupmentUnannounced(text) {
  return NOT_ANNOUNCED_RE.test(text || '');
}

// A recoupedSource that calls the recoupment DATE our estimate: "No public report
// gives the date; March 1997 is our estimate." (Chicago), "the 1999 date is an
// estimate." (The Lion King). Such a record carries isEstimate.recoupedDate so the
// card prints "~" and /biz counts no weeks from it (BRO-5568).
const DATE_ESTIMATE_RE = /\b(?:date|month|year)\b[^.;]{0,40}\b(?:is|was)\b[^.;]{0,12}\b(?:an |our )?estimate\b|\bis our estimate\b|\bestimated (?:date|month|year)\b|\beditorial judgment\b[^.;]{0,30}\bdated to\b/i;

/**
 * True when the recoupment source says the recoupment date is an estimate.
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
function saysRecoupmentDateIsEstimate(text) {
  return DATE_ESTIMATE_RE.test(text || '');
}

// A source that opens by calling the figure an estimate: "Estimate: $2,000,887
// NYC theatrical tax credit ... at the 25% credit rate" (Plaza Suite),
// "Estimated from ...", "Est. $5M", "~$8M". Only an explicit marker counts:
// "About $12M per the SEC filing" is a reported figure, rounded.
const ESTIMATE_SOURCE_RE = /^\s*(?:estimat\w*|est\.|~)/i;

/**
 * True when the capitalization should carry the "~" estimate marker: the
 * record flags it, its source says it is an estimate, or it has no publishable
 * source. A cited capitalization is a reported figure (BRO-4623) and prints
 * plain; an uncited one cannot read as reported, the same rule as the weekly
 * cost (BRO-4666).
 * @param {{ isEstimate?: Record<string, boolean | undefined> | null, capitalizationSource?: string | null }} commercial
 * @returns {boolean}
 */
function isEstimatedCapitalization(commercial) {
  if (commercial.isEstimate?.capitalization === true) return true;
  if (sourceOpensAsEstimate(commercial.capitalizationSource)) return true;
  return !publicSourceText(commercial.capitalizationSource);
}

/**
 * True when the source opens by calling its figure an estimate, read after
 * publicSourceText strips leading annotations ("[Auto-designated ...]").
 */
function sourceOpensAsEstimate(text) {
  return ESTIMATE_SOURCE_RE.test(publicSourceText(text) || text || '');
}

// What a capitalization figure is (BRO-5660). 'maximum': an SEC Form D total
// offering amount or a source's "up to" ceiling, printed "up to $X". 'sold': the
// amount a filing says was raised. 'reported': a stated capitalization.
const CAPITALIZATION_BASES = ['maximum', 'sold', 'reported'];

// A filing that says the money came in: "fully sold", "all of it sold",
// "$4,725,000 sold to 67 investors", "$20,000,000 sold of a $23,000,000
// offering", and a filing's own "Offering capitalized at $4,108,500" (BRO-5647),
// which wins over a "Maximum capitalization was" preamble beside it. A partial
// snapshot ("$400,000 sold by then") is not a raise.
const SOLD_SOURCE_RE = /(?<!\bnot )\bfully sold\b|\ball of it sold\b|\$[\d,.]+(?:\s?(?:M|million))? sold (?:to|of)\b|(?<!\b(?:max(?:imum)?|min(?:imum)?)(?:[\s-]+total)?[\s-]+)\b(?:offering|entity) (?:was |is )?capitalized at \$(?!\d[\d,]*(?:\.\d+)?(?:\s?(?:M|million))?\s*(?:\(max(?:imum)? cap\)|max(?:imum)?\b(?!\s+capitali)))/i;
// A ceiling: "capitalized for up to $18 million", "an offering of up to $20M",
// "total offering amount $5,500,000", "(max cap)", "maximum capitalization",
// "a maximum of $9.5 million" (Broadway Journal on Titanique, BRO-5647).
const MAXIMUM_SOURCE_RE = /\bup to \$|\bmaximum of \$|\btotal offering(?: amount)? (?:of )?\$|\(max(?:imum)? cap\)|\bmaximum (?:capitali[sz]ation|offering)\b|\bForm D maximum\b/i;

/**
 * The basis a capitalization source's wording states, else null. Writers use
 * it to tag a new figure; isMaximumCapitalization falls back to it for a
 * record with no capitalizationBasis.
 * @param {string | null | undefined} text
 * @returns {'maximum' | 'sold' | null}
 */
function capitalizationBasisFromText(text) {
  if (!text) return null;
  if (SOLD_SOURCE_RE.test(text)) return 'sold';
  if (MAXIMUM_SOURCE_RE.test(text)) return 'maximum';
  return null;
}

/**
 * True when a capitalizationSource only names an outlet: no basis wording, no
 * quoted sentence, no URL (BRO-5815). Such a source lets isMaximumCapitalization
 * guess, so a Form D ceiling cited this way prints as an amount raised.
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
function isBareCapitalizationSource(text) {
  if (!text || !String(text).trim()) return false;
  if (sourceOpensAsEstimate(text) || /\bnot (?:publicly )?disclosed\b|\bundisclosed\b/i.test(text)) return false;
  return !capitalizationBasisFromText(text) && !/["\u201c]/.test(text) && !/https?:/.test(text);
}

/**
 * True when the capitalization is a ceiling (a Form D offering maximum or an
 * "up to" figure) and must print "up to $X", never as an exact amount. An
 * explicit capitalizationBasis wins; otherwise the source's wording decides.
 * @param {{ capitalization?: number | null, capitalizationBasis?: string | null, capitalizationSource?: string | null }} commercial
 * @returns {boolean}
 */
function isMaximumCapitalization(commercial) {
  if (!commercial || commercial.capitalization == null) return false;
  if (commercial.capitalizationBasis) return commercial.capitalizationBasis === 'maximum';
  return capitalizationBasisFromText(commercial.capitalizationSource) === 'maximum';
}

/**
 * Re-tag a record whose capitalization or its source a writer just replaced:
 * the old basis described the old figure. Sets the basis the new source states,
 * else drops it (isMaximumCapitalization then reads the wording). Mutates rec.
 * @param {{ capitalizationSource?: string | null, capitalizationBasis?: string }} rec
 */
function retagCapitalizationBasis(rec) {
  const basis = capitalizationBasisFromText(rec.capitalizationSource);
  if (basis) rec.capitalizationBasis = basis;
  else delete rec.capitalizationBasis;
}

module.exports = {
  publicSourceText, isEstimatedCapitalization, saysRecoupmentUnannounced, saysRecoupmentDateIsEstimate, sourceOpensAsEstimate,
  CAPITALIZATION_BASES, capitalizationBasisFromText, isBareCapitalizationSource, isMaximumCapitalization, retagCapitalizationBasis,
};
