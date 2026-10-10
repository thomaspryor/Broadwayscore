/**
 * Deterministic wrong-production guard for recoupment findings (BRO-4623).
 *
 * The shared LLM classifier (recoupment-classify.js) only ever saw a show
 * TITLE, so it had no way to tell productions of that title apart. Real
 * misses from commercial-friday run 37083591866 (2026-10-03):
 *   - death-of-a-salesman (2026 revival, first preview 2026-03-06) was
 *     matched to theatermania's 2012-revival article, recoupedDate 2012-05-16
 *   - beetlejuice-2025 (2025 Broadway return, opened 2025-10-08) was matched
 *     to playbill.com/article/beetlejuice-national-tour-recoups, 2023-10-30
 * and from commercial-weekly run 37151980535 the reconciler accepted
 * Deadline's "'The Outsiders' Recoups $11 Million North American Tour" as
 * the Broadway production's recoupment.
 *
 * Two independent, deterministic rules (no LLM judgement involved):
 *   1. DATE: a recoupment cannot be dated, or reported, before the
 *      production's first preview (previewsStartDate, else openingDate).
 *      Partial dates compare at their own precision ("2025-10" precedes a
 *      2025-11-01 preview; "2025" precedes nothing in 2025).
 *   2. PRODUCTION TYPE: an article whose headline or URL is about a tour, a
 *      West End or an Off-Broadway production, and does not also put the
 *      recoupment on Broadway, is not this Broadway production's news. The
 *      classifier's own productionType answer is honoured too.
 *
 * Used at the single classification chokepoint (classifyArticle with
 * opts.show: Friday SERP scan, hourly RSS poller, reconciler) and again at
 * promotion (commercial-apply-gate.isAutoApplyableClaim) for entries already
 * sitting in the pending queue.
 */

// Qualified tour phrases only: a bare "tour" also appears in Broadway
// headlines ("Hamilton Recoups, Plans Tour") and must not reject them.
const TOUR_RE = /\b(?:national|north american|first national|second national|us|u\.s\.|uk|u\.k\.|international|world|european|australian|asian|non[- ]equity|equity|touring|road)\s+tour\b|\btouring\s+(?:production|company|cast)\b/i;
// Words that start a NEW clause after the recoup verb. A tour / West End run
// named after one of them is the show's next plan, not the production that
// recouped: Broadway News' "Stereophonic Recoups Investment, Will Tour and
// Play West End in 2025" (a real stereophonic source in commercial.json) and
// URL slugs, where textFromUrl() has already erased the comma
// ("hamilton-recoups-plans-tour", "aladdin-recoups-ahead-of-national-tour").
const CLAUSE_WORDS = 'will|and|plus|plans?|planning|sets?|launch\\w*|announc\\w*|heads?|eyes?|ahead|before|after|following|with|as|then|next|while|to';
// "<title> Tour Recoups" / "Recoups $11 Million North American Tour ...":
// the recoupment itself is the tour's, whatever else the headline says. The
// up-to-3 words between the verb and "tour" may not be a clause word or
// "broadway" ("recoups on broadway national tour launches" is a Broadway
// recoupment plus a tour plan, in URL form).
const TOUR_RECOUP_RE = new RegExp(
  '\\btour\\s+(?:has\\s+|have\\s+)?recoup' +
  '|\\brecoup\\w*\\s+(?:its\\s+|their\\s+)?(?:\\$?[\\d.,]+\\s*(?:million|m|k)?\\s+)?' +
  `(?:(?!(?:${CLAUSE_WORDS}|broadway)\\b)[a-z.]+\\s+){0,3}tour\\b`,
  'i',
);
const WEST_END_RE = /\bwest end\b|\blondon (?:production|run|transfer|staging)\b/i;
const OFF_BROADWAY_RE = /\boff[-\s]broadway\b/i;
const BROADWAY_RE = /\bbroadway\b/i;
const RECOUP_VERB_RE = /\brecoup\w*/i;
// End of the recoup clause: punctuation that separates clauses (a comma only
// when followed by a space, so "$11,000,000" stays whole), or a clause word.
const CLAUSE_END_RE = new RegExp(`,\\s|[;:|–—]|\\s-\\s|\\b(?:${CLAUSE_WORDS})\\b`, 'i');

const NON_BROADWAY_TYPES = new Set(['tour', 'national-tour', 'west-end', 'off-broadway', 'regional', 'international', 'film', 'other']);

function textFromUrl(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname).replace(/[-_/.+]+/g, ' ');
  } catch {
    return '';
  }
}

function mentionsBroadwayProper(text) {
  return BROADWAY_RE.test(String(text || '').replace(/\boff[-\s]broadway\b/gi, ' '));
}

/**
 * The part of a headline that says WHAT recouped: everything up to the recoup
 * verb (the subject: "Beetlejuice National Tour Recoups"), plus what follows
 * it up to the first clause break ("Six Recoups in the West End", but not
 * "Stereophonic Recoups Investment, Will Tour and Play West End"). Text with
 * no recoup verb (a bare URL slug) is returned whole.
 */
function recoupClause(text) {
  const t = String(text || '');
  const verb = RECOUP_VERB_RE.exec(t);
  if (!verb) return t;
  const end = verb.index + verb[0].length;
  const rest = t.slice(end);
  const cut = CLAUSE_END_RE.exec(rest);
  return t.slice(0, end) + (cut ? rest.slice(0, cut.index) : rest);
}

/**
 * Is this headline / URL text about a non-Broadway production's recoupment?
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.broadwayContext] - another headline or the URL for the
 *   same article already puts the recoupment on Broadway, which overrides a
 *   soft tour / West End / Off-Broadway mention (an og:title of "West End hit
 *   Operation Mincemeat recoups" next to a SERP title "... Recoups on
 *   Broadway"). An explicit "<X> tour recoups" is never overridden.
 * @returns {string|null} a label ('tour' | 'West End' | 'Off-Broadway') or null
 */
function nonBroadwayMarker(text, { broadwayContext = false } = {}) {
  const t = String(text || '');
  if (!t) return null;
  const clause = recoupClause(t);
  if (TOUR_RECOUP_RE.test(clause)) return 'tour';
  if (broadwayContext || mentionsBroadwayProper(clause)) return null;
  if (TOUR_RE.test(clause)) return 'tour';
  if (WEST_END_RE.test(clause)) return 'West End';
  if (OFF_BROADWAY_RE.test(clause)) return 'Off-Broadway';
  return null;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Attributes of every <meta> tag, one tag at a time. A single regex across
 * the document let `content=` match in one tag and `property=` in a later
 * one (playbill.com's head returned 9KB of scripts as the "og:title").
 */
function metaTags(html) {
  const out = [];
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : a[3];
    }
    out.push(attrs);
  }
  return out;
}

function metaContent(tags, names) {
  for (const t of tags) {
    const key = (t.property || t.name || t.itemprop || '').toLowerCase();
    if (names.includes(key) && typeof t.content === 'string' && t.content.trim()) return t.content;
  }
  return null;
}

/** The article's own headline candidates: og:title and <title>. */
function extractHeadlines(html) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const og = metaContent(metaTags(html), ['og:title', 'twitter:title']);
  if (og) out.push(decodeEntities(og));
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (title) out.push(decodeEntities(title[1]));
  return out.filter(Boolean);
}

/**
 * The article's own publish date (YYYY-MM-DD) from article:published_time
 * or JSON-LD datePublished, which every trade outlet in TRUSTED_RECOUPMENT_
 * HOSTS sets (verified on the theatermania 2012, playbill 2023, deadline 2026
 * pages from BRO-4623). Deterministic, so a misread articleDate from the LLM
 * cannot let an old article through.
 */
function extractPublishedDate(html) {
  if (!html || typeof html !== 'string') return null;
  const meta = metaContent(metaTags(html), ['article:published_time', 'og:published_time', 'datepublished', 'parsely-pub-date', 'sailthru.date', 'pubdate', 'publish-date']);
  const ld = /"datePublished"\s*:\s*"([^"]+)"/i.exec(html);
  for (const v of [meta, ld && ld[1]]) {
    const m = v && /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    if (m) return m[1];
  }
  return null;
}

/** First preview, else opening: the earliest date this production can have recouped. */
function productionStartDate(show) {
  const d = show && (show.previewsStartDate || show.openingDate);
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

/**
 * Does a (possibly partial) date fall strictly before `startIso`, compared at
 * the date's own precision? Unparseable input never "precedes" (fail open:
 * the date rule only rejects what it can prove).
 */
function datePrecedes(dateStr, startIso) {
  if (!dateStr || !startIso || typeof dateStr !== 'string') return false;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(dateStr.trim());
  if (!m) return false;
  if (m[3]) return `${m[1]}-${m[2]}-${m[3]}` < startIso;
  if (m[2]) return `${m[1]}-${m[2]}` < startIso.slice(0, 7);
  return m[1] < startIso.slice(0, 4);
}

/** A /YYYY/MM/ (or /YYYY/MM/DD/) date embedded in a URL path, e.g. deadline.com/2026/05/... */
function urlDate(url) {
  try {
    const m = /\/((?:19|20)\d{2})\/(0[1-9]|1[0-2])\/(?:(0[1-9]|[12]\d|3[01])\/)?/.exec(new URL(url).pathname);
    if (!m) return null;
    return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
  } catch {
    return null;
  }
}

/**
 * @param {object} args
 * @param {object} args.show - shows.json record of the production being checked
 * @param {object} [args.verdict] - classifier verdict ({recoupedDate, articleDate, productionType})
 * @param {string} [args.recoupedDate] - for pending entries without a verdict
 * @param {string} [args.url] - article URL
 * @param {string} [args.publishedDate] - the page's own publish date (extractPublishedDate)
 * @param {string[]|string} [args.headlines] - SERP/RSS title and/or the article's own titles
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkRecoupmentProduction({ show, verdict = {}, recoupedDate, url, publishedDate, headlines } = {}) {
  if (!show) return { ok: true };
  const start = productionStartDate(show);
  if (start) {
    const dates = [
      ['recoupedDate', recoupedDate !== undefined ? recoupedDate : verdict.recoupedDate],
      ['articleDate', verdict.articleDate],
      ['published date', publishedDate],
      ['URL date', url ? urlDate(url) : null],
    ];
    for (const [label, value] of dates) {
      if (datePrecedes(value, start)) {
        return { ok: false, reason: `${label} ${value} is before this production's first performance ${start}: an earlier production's recoupment` };
      }
    }
  }

  const type = typeof verdict.productionType === 'string' ? verdict.productionType.trim().toLowerCase() : '';
  if (type && NON_BROADWAY_TYPES.has(type)) {
    return { ok: false, reason: `classifier says the article is about a ${type} production, not Broadway` };
  }

  const heads = (Array.isArray(headlines) ? headlines : [headlines]).filter((h) => typeof h === 'string' && h.trim());
  const urlText = url ? textFromUrl(url) : '';
  // One article, several texts (SERP title, og:title, <title>, URL slug): if
  // any of them puts the recoupment on Broadway, a soft tour / West End
  // mention in another is not evidence against it.
  const broadwayContext = [...heads, urlText].some((t) => mentionsBroadwayProper(recoupClause(t)));
  for (const h of heads) {
    const marker = nonBroadwayMarker(h, { broadwayContext });
    if (marker) return { ok: false, reason: `headline is about a ${marker} production: "${h.slice(0, 120)}"` };
  }
  if (urlText) {
    const marker = nonBroadwayMarker(urlText, { broadwayContext });
    if (marker) return { ok: false, reason: `article URL is about a ${marker} production: ${url}` };
  }
  return { ok: true };
}

/**
 * Apply the guard to a classifier verdict. A rejected positive verdict comes
 * back with recouped:false and productionMatch 'wrong-production' (every
 * consumer gates on recouped===true AND productionMatch==='exact', so it
 * fails closed everywhere), keeping the LLM's answer in llmRecouped and the
 * reason in guardReason for the run log.
 */
function applyProductionGuard(verdict, ctx) {
  if (!verdict || verdict.recouped !== true || !ctx || !ctx.show) return verdict;
  const check = checkRecoupmentProduction({ ...ctx, verdict });
  if (check.ok) return verdict;
  return {
    ...verdict,
    recouped: false,
    llmRecouped: true,
    productionMatch: 'wrong-production',
    guardReason: check.reason,
  };
}

// GitHub Actions workflow-command escaping (actions/toolkit command.ts).
const escapeAnnotationData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeAnnotationProperty = (s) => escapeAnnotationData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * The `::warning::` line for a guard rejection, or null when the verdict was
 * not rejected. A rejected verdict is dropped (recouped:false, so no pending
 * entry is written and the same article is rejected again next week), so a
 * false rejection of a real Broadway recoupment would otherwise sit unseen in
 * a step log. The annotation puts it on the run page. Shared by the Friday
 * SERP scan, the RSS poller and the reconciler.
 */
function guardRejectionWarning(slug, url, verdict) {
  if (!verdict || !verdict.guardReason) return null;
  const title = escapeAnnotationProperty(`Recoupment production guard: ${slug}`);
  const body = escapeAnnotationData(
    `Rejected a recouped=true verdict for ${slug}: ${verdict.guardReason} (${url}). ` +
    'If the article really is about this Broadway production, add the recoupment to commercial.json by hand.'
  );
  return `::warning title=${title}::${body}`;
}

module.exports = {
  checkRecoupmentProduction,
  applyProductionGuard,
  guardRejectionWarning,
  nonBroadwayMarker,
  extractHeadlines,
  extractPublishedDate,
  productionStartDate,
  datePrecedes,
  urlDate,
};
