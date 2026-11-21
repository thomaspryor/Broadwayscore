'use strict';
/**
 * Seat-guidance re-verification core (BRO-8018). Pure functions, no I/O, no model clients.
 *
 * Used by scripts/reverify-seat-sections.js to re-check the April 2026 seating sections
 * (structuredTips.seating.sections in data/theater-metadata.json) against their own cited
 * sources with two model families, under a strict grounding rule:
 *   - every kept claim carries an evidence quote that is a VERBATIM substring of a fetched
 *     source page, and that page must name the theater (checked here, not by a model);
 *   - a second model must then agree the quote supports the claim;
 *   - anything unproven is removed. A section with no supported verdict or rationale is dropped.
 *
 * Why the strict rule: the April pipeline sent each model only the first 2,000 characters of
 * each source page and accepted "consistent context" as support. A hand check of Gershwin
 * (2026-11-21) found about half of the rationales' quoted phrases are not on the cited pages
 * today, and one quote came from a source the section never cited.
 */

const crypto = require('crypto');
const { foldDiacritics } = require('./title-match');

const VERDICTS = new Set(['sweet-spot', 'solid', 'skip']);
const PRICE_TIERS = new Set(['budget', 'mid', 'premium', 'top']);
// Must match SeatingHazardType in src/lib/data-types.ts (the UI prints the type as a label).
const HAZARD_TYPES = new Set(['mezz-overhang', 'pillar', 'obstructed-view', 'side-angle', 'steep-rake', 'tight-legroom', 'distant', 'partial-stage', 'sound-dead-spot']);
// April data used a few off-list types; map the ones that mean the same thing, drop the rest.
const HAZARD_ALIASES = { distance: 'distant', legroom: 'tight-legroom', 'rail-obstruction': 'obstructed-view', 'side-on-view': 'side-angle', 'neck-turn': 'side-angle', 'corner-cutoff': 'partial-stage', 'staging-blocked': 'partial-stage', hearing: 'sound-dead-spot' };
const hazardType = (t) => (HAZARD_TYPES.has(t) ? t : HAZARD_ALIASES[t] || null);
const SHOW_TAGS = new Set(['musical', 'play', 'dance-heavy', 'spectacle', 'intimate-drama']);
const DEFAULT_LABEL = { 'sweet-spot': 'Top pick', solid: 'Solid choice', skip: 'Skip' };
const MAX_QUOTE_CHARS = 400;
const MIN_QUOTE_CHARS = 12;
const MIN_SECTIONS_PER_THEATER = 3;

// Former names that sources still use. A page only counts as evidence for a theater when it
// names that theater (current or former name), so a roundup of another house can't "support" it.
const FORMER_NAMES = {
  'Lena Horne Theatre': ['Brooks Atkinson'],
  'James Earl Jones Theatre': ['Cort Theatre', 'Cort Theater'],
  'Todd Haimes Theatre': ['American Airlines Theatre', 'American Airlines Theater'],
  'Helen Hayes Theater': ['Hayes Theater', 'Hayes Theatre', 'Little Theatre'],
  'Stephen Sondheim Theatre': ["Henry Miller's Theatre", 'Henry Millers Theatre'],
  'Gerald Schoenfeld Theatre': ['Plymouth Theatre'],
  'Bernard B. Jacobs Theatre': ['Royale Theatre', 'Jacobs Theatre', 'Jacobs Theater'],
  'Samuel J. Friedman Theatre': ['Biltmore Theatre', 'Friedman Theatre', 'Friedman Theater'],
  'Lyric Theatre': ['Foxwoods Theatre', 'Hilton Theatre', 'Ford Center for the Performing Arts'],
  'Al Hirschfeld Theatre': ['Martin Beck Theatre'],
  'Neil Simon Theatre': ['Alvin Theatre'],
  'August Wilson Theatre': ['Virginia Theatre'],
  'Vivian Beaumont Theater': ['Vivian Beaumont Theatre', 'Beaumont Theater', 'Beaumont Theatre'],
  'Circle in the Square Theatre': ['Circle in the Square'],
  'Studio 54': ['Studio 54'],
};

/** Lowercase, unify quotes/dashes, collapse punctuation and spaces. Used for every comparison. */
function normalizeText(t) {
  return foldDiacritics(String(t || ''))
    .toLowerCase()
    .replace(/[‘’‛`´]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&lsquo;|&apos;/g, "'")
    .replace(/[^a-z0-9'& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** HTML -> readable text. Keeps the whole page (no truncation before passage selection). */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&lsquo;|&apos;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Names a page may use for the theater: "Gershwin Theatre", "Gershwin Theater", former names. */
function theaterNamePatterns(theaterName) {
  const names = new Set([theaterName]);
  const core = theaterName.replace(/\s+(Theatre|Theater)$/i, '').trim();
  if (core !== theaterName) {
    names.add(`${core} Theatre`);
    names.add(`${core} Theater`);
  }
  for (const n of FORMER_NAMES[theaterName] || []) names.add(n);
  return [...names].map(normalizeText).filter(Boolean);
}

function pageNamesTheater(text, theaterName) {
  const norm = ` ${normalizeText(text)} `;
  return theaterNamePatterns(theaterName).some((p) => norm.includes(` ${p} `) || norm.includes(` ${p}s `) || norm.includes(` ${p}'s `));
}

/** Words that tie a passage to this section: level names plus any row letters in its range. */
function sectionKeywords(section) {
  const words = new Set();
  const name = `${section.name || ''} ${section.rowRange || ''}`.toLowerCase();
  for (const w of ['orchestra', 'mezzanine', 'mezz', 'balcony', 'loge', 'box', 'boxes', 'stadium', 'rear', 'front', 'side', 'center', 'centre', 'aisle', 'partial', 'obstructed', 'overhang']) {
    if (name.includes(w)) words.add(w);
  }
  if (name.includes('mezz')) { words.add('mezzanine'); words.add('mezz'); }
  if (/\bside\b/.test(name)) { words.add('left'); words.add('right'); }
  const rows = (section.rowRange || '').match(/\b[A-Z]{1,2}\b/g) || [];
  for (const r of rows) words.add(`row ${r.toLowerCase()}`);
  return [...words];
}

/**
 * Pick the parts of a page that talk about this section. Splits into ~600-char windows, scores
 * by section keywords and the theater name, returns the best windows in page order up to maxChars.
 * The full text is still used for quote matching; this only bounds what a model reads.
 */
function selectPassages(text, theaterName, section, maxChars = 9000) {
  return wellFormed(selectPassagesRaw(text, theaterName, section, maxChars));
}

/** Fixed-width windows can split an emoji's surrogate pair; the OpenAI API rejects such a body. */
function wellFormed(s) {
  return String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

function selectPassagesRaw(text, theaterName, section, maxChars) {
  const t = String(text || '');
  if (t.length <= maxChars) return t;
  const kw = sectionKeywords(section);
  const names = theaterNamePatterns(theaterName);
  const WIN = 600;
  const wins = [];
  for (let i = 0; i < t.length; i += WIN) {
    const chunk = t.slice(i, i + WIN + 120);
    const n = normalizeText(chunk);
    let score = 0;
    for (const k of kw) if (n.includes(k)) score += 2;
    for (const p of names) if (n.includes(p)) score += 1;
    if (/\b(best|worst|avoid|recommend|view|sightline|obstruct|legroom|rake|overhang|value|cheap)/.test(n)) score += 1;
    wins.push({ i, chunk, score });
  }
  const picked = wins.filter((w) => w.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const out = [];
  let used = 0;
  for (const w of picked) {
    if (used + w.chunk.length > maxChars) continue;
    out.push(w);
    used += w.chunk.length;
  }
  out.sort((a, b) => a.i - b.i);
  return out.map((w) => w.chunk).join('\n[...]\n');
}

/** True when `quote` appears in `text` after normalization (word-for-word, ignoring punctuation/case). */
function quoteInText(quote, text) {
  const q = normalizeText(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return ` ${normalizeText(text)} `.includes(` ${q} `) || normalizeText(text).includes(q);
}

/**
 * Check one evidence list deterministically. sources: [{url, text, namesTheater}] indexed from 1.
 * Returns the evidence items that are real: valid source index, page names the theater, quote
 * found word-for-word, quote not too long.
 */
function groundEvidence(evidence, sources) {
  const ok = [];
  for (const e of Array.isArray(evidence) ? evidence : []) {
    const src = sources[(e && e.src) - 1];
    if (!src || !src.text || !src.namesTheater) continue;
    const quote = String(e.quote || '');
    if (quote.length > MAX_QUOTE_CHARS) continue;
    if (!quoteInText(quote, src.text)) continue;
    ok.push({ src: e.src, url: src.url, quote, context: quoteContext(quote, src.text) });
  }
  return ok;
}

/**
 * ~350 chars either side of the quote (normalized text), so the verifier can see which theater,
 * level and side the surrounding paragraph is about. Audit fix: a Right Orchestra quote was
 * accepted as support for the Rear Orchestra because the verifier saw the sentence alone.
 */
function quoteContext(quote, text, pad = 350) {
  const n = normalizeText(text);
  const i = n.indexOf(normalizeText(quote));
  if (i < 0) return '';
  return n.slice(Math.max(0, i - pad), i + normalizeText(quote).length + pad);
}

/** Copy rules for public seating text. Returns a list of problems (empty = fine). */
function copyProblems(text, { forbiddenTitles = [] } = {}) {
  const problems = [];
  const s = String(text || '');
  if (/[—]/.test(s)) problems.push('em dash');
  if (/["“”]/.test(s)) problems.push('quotation marks');
  if (/(^|[\s(])'[^']{3,}'(?=[\s,.;:)!?]|$)/.test(s)) problems.push('quotation marks');
  if (/\b(the|a|one|this) (source|reviewer|review|user|poster|commenter)s?\b|\baccording to\b|\b(is|are) (identified|described|considered|reported|regarded) as\b|\bwidely regarded\b|\breportedly\b/i.test(s)) problems.push('talks about sources instead of giving advice');
  const norm = ` ${normalizeText(s)} `;
  for (const title of forbiddenTitles) {
    const t = normalizeText(title);
    if (t.length >= 4 && norm.includes(` ${t} `)) problems.push(`names show "${title}"`);
  }
  return problems;
}

/**
 * Parse a model's JSON reply. Throws (never guesses) when the reply is not the expected shape,
 * so a bad reply is retried instead of being read as "unsupported".
 */
function parseJsonReply(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in model reply');
  return JSON.parse(m[0]);
}

function buildRewritePrompt({ theaterName, section, sources, allowedShowTitles = [] }) {
  const fields = [];
  if (section.rowRange) fields.push(`rowRange: "${section.rowRange}"`);
  if (section.bestRow) fields.push(`bestRow: "${section.bestRow}"`);
  if (section.priceTier) fields.push(`priceTier: "${section.priceTier}" (relative price at this theater)`);
  if (section.isValuePick) fields.push('isValuePick: true (best value for money at this theater)');
  if (section.bestFor && section.bestFor.length) fields.push(`bestFor: ${JSON.stringify(section.bestFor)}`);
  if (section.worstFor && section.worstFor.length) fields.push(`worstFor: ${JSON.stringify(section.worstFor)}`);
  const hazards = (section.hazards || []).map((h, i) => `  hazard ${i}: [${h.type}] ${h.note}`).join('\n') || '  (none)';
  const srcBlock = sources.map((s, i) => `=== SOURCE ${i + 1}: ${s.url}${s.namesTheater ? '' : ' (DOES NOT NAME THIS THEATER: never cite it)'}\n${s.passages || '(could not be fetched)'}`).join('\n\n');
  const tenants = allowedShowTitles.length ? allowedShowTitles.map((t) => `"${t}"`).join(', ') : 'none';
  return wellFormed(`You are fact-checking seating advice for ${theaterName} on Broadway against the source pages below.
Keep ONLY what the sources say about THIS section at THIS theater. When in doubt, drop it.

SECTION: "${section.name}"
VERDICT: ${section.verdict} (sweet-spot = among the best seats; solid = fine; skip = avoid)
LABEL: "${section.verdictLabel || ''}"
FIELDS:
${fields.join('\n') || '  (none)'}
HAZARDS:
${hazards}
OLD RATIONALE (unverified, may contain invented quotes):
${section.rationale || ''}

SOURCES:
${srcBlock}

RULES
- Every kept item needs evidence: {"src": <source number>, "quote": "<exact words copied from that source, 12 to 300 characters>"}.
  Copy quotes character for character from the source text. Do not paraphrase inside "quote". A quote that is not on the page is discarded by a program.
- The quote must be about this theater and this section (or the rows it covers), not another theater or level.
- name: "text" is the section name, corrected so every detail in it is backed by the sources (remove unsupported row letters or words like front, value; keep it short, e.g. "Rear Orchestra" or "Center Mezzanine (Rows A-D)"). keep=true if the sources talk about these seats.
- verdict: supported only if the sources say it about the WHOLE area named, not just part of it, and a source says this section is among the best (sweet-spot), fine/good (solid), or poor/to avoid (skip).
- rowRange/bestRow: only if a source names those rows for this section.
- isValuePick: only if a source says this section is good value / a deal / cheaper for what you get.
- priceTier: only if a source says this section is expensive (premium), mid-priced, or cheap (budget).
- bestFor/worstFor: only if a source ties this section to that kind of show (allowed tags: musical, play, dance-heavy, spectacle, intimate-drama).
- hazards: keep one only if a source describes that problem in this section AND the problem matches its [type] label. You may reword the note.
- rationale: rewrite as 1 to 4 short plain sentences of direct advice to a ticket buyer, each backed by evidence. Use your own words.
  Never talk about the sources (no "the source", "reviewers", "is described as", "is identified as", "reportedly", "according to").
  No quotation marks. No em dashes. Do not name websites or reviewers. Do not name any show except: ${tenants}.
- label: a 1 to 4 word label for the verdict that the evidence supports (e.g. "Best overall", "Good value", "Too far back"), no punctuation except hyphens.

Reply with ONLY this JSON:
{"name":{"text":"...","keep":true|false,"evidence":[...]},
 "verdict":{"supported":true|false,"evidence":[...]},
 "label":"...",
 "rowRange":{"keep":true|false,"evidence":[...]},
 "bestRow":{"keep":true|false,"evidence":[...]},
 "priceTier":{"keep":true|false,"evidence":[...]},
 "isValuePick":{"keep":true|false,"evidence":[...]},
 "bestFor":{"keep":["tag",...],"evidence":[...]},
 "worstFor":{"keep":["tag",...],"evidence":[...]},
 "hazards":[{"i":0,"keep":true|false,"note":"...","evidence":[...]}],
 "rationale":[{"text":"...","evidence":[...]}]}
Omit a field object when the section does not have that field.`);
}

/** The checker sees each claim next to its quotes and says yes or no per claim. */
function buildVerifyPrompt({ theaterName, sectionName, claims }) {
  const block = claims.map((c, i) => `CLAIM ${i + 1} [${c.kind}]: ${c.text}\n${c.evidence.map((e) => `  EVIDENCE (${e.url}): "${e.quote}"${e.context ? `\n    SURROUNDING TEXT: ...${e.context}...` : ''}`).join('\n')}`).join('\n\n');
  return wellFormed(`You are a strict fact-checker. Each claim below is about the "${sectionName}" seats at ${theaterName} on Broadway.
For each claim, decide if the EVIDENCE quotes, read literally, support the claim for this section at this theater.
Say false if the evidence is about a different section, a different theater, is vaguer than the claim, or only partly supports it.
Use the SURROUNDING TEXT to check which theater, level and side a quote is about: a quote from a paragraph about another area does not support this section.
The evidence must cover the WHOLE area the claim names. If the section is "Rear Mezzanine and Far Sides" and the evidence only says to avoid the far sides, a claim that the whole section is to avoid is false.
A [name] claim does NOT need the source to use the name or call it an official section. It is supported when the evidence talks about seats in that position, and is false only if a specific detail in the name (row letters, seat numbers, front/rear/side/center, value) is contradicted or not backed.
A [hazard] claim must match its TYPE label as well as its note (e.g. "steep rake" is false if the evidence is about stairs or a shallow rake).
A [verdict] claim of "good, reasonable seats" is supported by evidence that the seats are good, decent or worth buying; it does not need to say they are the best.

${block}

Reply with ONLY JSON: {"results":[{"i":1,"supported":true|false,"why":"<8 words>"}, ...]} with one entry per claim.`);
}

/** Verifier reply -> Map(claimIndex(1-based) -> boolean). Throws if any claim is missing. */
function parseVerifyReply(text, nClaims) {
  const j = parseJsonReply(text);
  const out = new Map();
  out.why = new Map();
  for (const r of j.results || []) if (Number.isInteger(r.i)) { out.set(r.i, r.supported === true); out.why.set(r.i, String(r.why || '').slice(0, 120)); }
  for (let i = 1; i <= nClaims; i++) if (!out.has(i)) throw new Error(`verifier reply missing claim ${i}`);
  return out;
}

/**
 * Turn a rewrite reply into grounded claims. Deterministic: drops every item whose evidence
 * isn't word-for-word on a page that names the theater, and every rationale sentence that breaks
 * the copy rules. Returns { claims, label } where claims feed the verifier.
 */
function groundRewrite(section, reply, sources, { forbiddenTitles = [] } = {}) {
  const claims = [];
  const add = (kind, text, evidence, extra = {}) => {
    const ev = groundEvidence(evidence, sources);
    if (ev.length) claims.push({ kind, text, evidence: ev, ...extra });
  };
  const r = reply || {};
  const v = { 'sweet-spot': 'are among the best seats in the house', solid: 'are good, reasonable seats', skip: 'are seats to avoid' }[section.verdict];
  // The section name is shown as a heading, so every qualifier in it is a claim (audit: "front", "rows 1-11", "value band").
  // The rewriter may drop unsupported qualifiers ("front", "value band", made-up rows); the verifier checks the result.
  let name = section.name;
  const proposed = r.name && typeof r.name.text === 'string' ? cleanName(r.name.text.trim()) : '';
  if (proposed && proposed.length <= 70 && !copyProblems(proposed, { forbiddenTitles }).length) name = proposed;
  if (r.name && r.name.keep) add('name', `The evidence describes the seats named "${name}", and every specific detail in that name (row letters, seat numbers, words like front, rear, side, center, value) matches the evidence.`, r.name.evidence, { name });
  if (r.verdict && r.verdict.supported) add('verdict', `The ${name} seats ${v}.`, r.verdict.evidence);
  // The row quote often only names the rows; the verdict quote says how good they are. The verifier sees both.
  if (section.rowRange && r.rowRange && r.rowRange.keep) add('rowRange', `In ${name}, rows ${section.rowRange} ${v}.`, [...(r.rowRange.evidence || []), ...((r.verdict && r.verdict.evidence) || [])]);
  if (section.bestRow && r.bestRow && r.bestRow.keep) add('bestRow', `${section.bestRow} is the single best row in ${name}.`, r.bestRow.evidence);
  if (section.priceTier && r.priceTier && r.priceTier.keep) add('priceTier', `${name} seats are ${section.priceTier === 'premium' || section.priceTier === 'top' ? 'among the most expensive' : section.priceTier === 'budget' ? 'among the cheapest' : 'mid-priced'} at this theater.`, r.priceTier.evidence);
  if (section.isValuePick && r.isValuePick && r.isValuePick.keep) add('isValuePick', `${name} is good value for the money at this theater.`, r.isValuePick.evidence);
  for (const key of ['bestFor', 'worstFor']) {
    const tags = ((r[key] && r[key].keep) || []).filter((t) => SHOW_TAGS.has(t) && (section[key] || []).includes(t));
    if (tags.length) add(key, `${name} is ${key === 'bestFor' ? 'especially good' : 'a poor choice'} for ${tags.join(', ')} shows.`, r[key].evidence, { tags });
  }
  for (const h of r.hazards || []) {
    const orig = (section.hazards || [])[h.i];
    if (!orig || !h.keep || !hazardType(orig.type)) continue;
    const note = String(h.note || orig.note || '').trim();
    if (!note || copyProblems(note, { forbiddenTitles }).length) continue;
    const type = hazardType(orig.type);
    add('hazard', `${name} has a ${type.replace(/-/g, ' ')} problem: ${note}`, h.evidence, { hazard: { type, note } });
  }
  (r.rationale || []).forEach((s) => {
    const text = String((s && s.text) || '').trim();
    if (!text || copyProblems(text, { forbiddenTitles }).length) return;
    add('rationale', text, s.evidence, { sentence: text });
  });
  let label = String(r.label || '').trim();
  if (!label || label.split(/\s+/).length > 4 || /[^A-Za-z0-9 \-'&]/.test(label)) label = '';
  return { claims, label };
}

/** April names used em dashes ("Center Orchestra (front \u2014 rows C-E)"); site copy bans them. */
function cleanName(n) {
  return String(n).replace(/\s*\u2014\s*/g, ', ').replace(/\(\s*,\s*/g, '(').replace(/,\s*\)/g, ')').trim();
}

/**
 * Build the final section from claims the verifier accepted. Returns { section } or
 * { dropped: reason }. Pure: the decision table lives here so the CLI and tests share it.
 */
function decideSection(original, claims, accepted) {
  const ok = claims.filter((c, i) => accepted.get(i + 1) === true);
  if (!ok.some((c) => c.kind === 'name')) return { dropped: 'section name not supported' };
  if (!ok.some((c) => c.kind === 'verdict')) return { dropped: 'verdict not supported' };
  let sentences = ok.filter((c) => c.kind === 'rationale').map((c) => c.sentence);
  // No rewritten sentence survived but a hazard did: the verified hazard note is the explanation.
  if (!sentences.length) sentences = ok.filter((c) => c.kind === 'hazard').map((c) => c.hazard.note.replace(/([^.!?])$/, '$1.'));
  if (!sentences.length) return { dropped: 'no supported rationale' };
  const has = (k) => ok.find((c) => c.kind === k);
  const nameClaim = ok.find((c) => c.kind === 'name');
  const out = { name: cleanName((nameClaim && nameClaim.name) || original.name) };
  if (original.rowRange && has('rowRange')) out.rowRange = original.rowRange;
  if (original.bestRow && out.rowRange && has('bestRow')) out.bestRow = original.bestRow;
  out.verdict = original.verdict;
  out.verdictLabel = DEFAULT_LABEL[original.verdict];
  if (original.priceTier && has('priceTier')) out.priceTier = original.priceTier;
  if (original.isValuePick && has('isValuePick')) out.isValuePick = true;
  out.rationale = sentences.join(' ');
  const hazards = ok.filter((c) => c.kind === 'hazard').map((c) => c.hazard);
  if (hazards.length) out.hazards = hazards;
  const bf = has('bestFor'); if (bf) out.bestFor = bf.tags;
  const wf = has('worstFor'); if (wf) out.worstFor = wf.tags;
  out.evidenceUrls = [...new Set(ok.flatMap((c) => c.evidence.map((e) => e.url)))];
  return { section: out };
}

/**
 * Theater-level keep rule, shared with tests/unit/seating-data-coverage.test.mjs:
 * enough sections to be useful, at least one highlight, at most one value pick.
 */
function theaterKeepProblems(sections) {
  const p = [];
  if (!Array.isArray(sections) || sections.length < MIN_SECTIONS_PER_THEATER) p.push(`fewer than ${MIN_SECTIONS_PER_THEATER} sections`);
  const list = sections || [];
  if (!list.some((s) => s.verdict === 'sweet-spot' || s.isValuePick)) p.push('no sweet-spot or value pick');
  if (list.filter((s) => s.isValuePick).length > 1) p.push('more than one value pick');
  return p;
}

function quoteHash(q) {
  return crypto.createHash('sha1').update(normalizeText(q)).digest('hex').slice(0, 12);
}

module.exports = {
  VERDICTS, PRICE_TIERS, SHOW_TAGS, HAZARD_TYPES, hazardType, DEFAULT_LABEL, MIN_SECTIONS_PER_THEATER, FORMER_NAMES,
  normalizeText, htmlToText, theaterNamePatterns, pageNamesTheater, sectionKeywords, selectPassages,
  wellFormed, cleanName, quoteInText, groundEvidence, copyProblems, parseJsonReply, buildRewritePrompt, buildVerifyPrompt,
  parseVerifyReply, groundRewrite, decideSection, theaterKeepProblems, quoteHash,
};
