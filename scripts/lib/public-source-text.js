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
const NEWSPAPER_BLOG_HOST_RE = /\b[\w.-]*blogs\.nytimes\.com\b/gi;

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
  if (!trimmed) return null;
  if (INTERNAL_SOURCE_RE.test(trimmed.replace(NEWSPAPER_BLOG_HOST_RE, 'nytimes.com')) || INTERNAL_TOKEN_RE.test(trimmed.replace(URL_RE, ' '))) return null;
  return trimmed;
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

module.exports = { publicSourceText, isEstimatedCapitalization };
