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
// never a newspaper's editorial. It errs toward "unannounced" on purpose: a
// false match only downgrades the label, while a miss prints an unannounced
// recoupment as announced and refuses a correctly flagged write. So there is
// no "confirmed later" exception: a lookahead for one (BRO-5562 review) also
// cancelled plain wordings ("estimated at the time of closing", "confirmed by
// grosses analysis"), and "previously unannounced, confirmed by Deadline"
// reads as unannounced. Write a later report as the source itself instead.
const NOT_ANNOUNCED_RE = new RegExp([
  String.raw`\bno (?:public |producer |formal )?(?:recoupment )?announcement\b`,
  String.raw`\bno (?:public |formal )?recoupment (?:was |has been |had been |is )?(?:formally |publicly )?announced\b`,
  String.raw`\bwithout (?:an? |any )?(?:public |formal )?announcement\b`,
  String.raw`\bunannounced\b`,
  String.raw`\bnever (?:formally |publicly )?announce[sd]?\b`,
  String.raw`\b(?:not|(?:is|are|was|were|has|have|had)n['’]t) (?:been )?(?:formally |publicly )?announced\b`,
  String.raw`\b(?:does|do|did)(?: not|n['’]t) (?:formally |publicly )?announce(?:s|ments?)?\b`,
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
  if (ESTIMATE_SOURCE_RE.test(commercial.capitalizationSource || '')) return true;
  return !publicSourceText(commercial.capitalizationSource);
}

module.exports = { publicSourceText, isEstimatedCapitalization, saysRecoupmentUnannounced };
