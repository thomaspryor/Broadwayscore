'use strict';
// Broadway Journal (Substack) helpers for the weekly AG-filing sweep (BRO-6167).
// Pure functions + an injectable archive walker, so tests require() the real code.

const HOST_RE = /https?:\/\/(?:www\.)?broadwayjournal\.com\/(?:p\/)?([a-z0-9][a-z0-9-]*)\/?(?=[\s"'<>)\]?#,]|$)/gi;
const NON_POST_SLUGS = new Set(['feed', 'archive', 'about', 'subscribe', 'category', 'tag', 'api']);

// Terms that mark a post as quoting a financial filing or recoupment/cost data.
const FINANCIAL_PATTERNS = [
  ['attorney general', /attorney general/i],
  ['AG filing', /\bAG(?:'s)?\s+(?:filing|office|offering|financial)/i],
  ['financial statement', /financial statements?/i],
  ['FOIL', /\bFOIL\b|freedom of information/i],
  ['recoup', /recoup/i],
  ['capitalization', /capitali[sz]ation|capitali[sz]ed at/i],
  ['running costs', /running costs?|weekly (?:operating )?(?:costs?|expenses)|operating (?:costs?|expenses)/i],
  ['offering circular', /offering (?:circular|documents?)|\bprospectus\b/i],
];

/** Normalize any BJ URL (Substack /p/<slug>, legacy WordPress /<slug>, with/without www) to its slug. */
function slugFromUrl(url) {
  if (!url) return null;
  const m = /^https?:\/\/(?:www\.)?broadwayjournal\.com\/(?:p\/)?([a-z0-9][a-z0-9-]*)\/?(?:[?#].*)?$/i.exec(String(url).trim());
  if (!m) return null;
  const slug = m[1].toLowerCase();
  return NON_POST_SLUGS.has(slug) ? null : slug;
}

/** All BJ post slugs cited anywhere in a blob of text (e.g. JSON.stringify(commercial.json)). */
function citedSlugs(text) {
  const out = new Set();
  const re = new RegExp(HOST_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const slug = slugFromUrl(m[0]);
    if (slug) out.add(slug);
  }
  return out;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#x27;|&#39;|&rsquo;|&lsquo;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Which financial-filing terms appear in the text. */
function scanFinancialTerms(text) {
  const hay = String(text || '');
  const terms = FINANCIAL_PATTERNS.filter(([, re]) => re.test(hay)).map(([name]) => name);
  return { hit: terms.length > 0, terms };
}

/**
 * Walk the whole Substack archive. Substack caps page size below the requested
 * limit (limit=50 returned 23 live), so advance by what came back, never by limit.
 * @param {(url:string)=>Promise<any[]>} fetchJson
 */
async function fetchArchive(fetchJson, { base = 'https://www.broadwayjournal.com', limit = 50, maxPages = 200 } = {}) {
  const posts = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchJson(`${base}/api/v1/archive?sort=new&limit=${limit}&offset=${offset}`);
    if (!Array.isArray(batch) || batch.length === 0) return { posts, complete: true };
    posts.push(...batch);
    offset += batch.length;
  }
  return { posts, complete: false };
}

/**
 * Decide what the sweep reports.
 * @param {object[]} analyzed [{slug,title,url,postDate,audience,truncated,terms:string[]}]
 * @param {Set<string>} cited
 * @param {{before?: string}} opts posts dated before `before` belong to the BRO-6160 backfill
 */
function selectUncited(analyzed, cited, { before = null } = {}) {
  const cutoff = before ? Date.parse(before) : null;
  const uncited = analyzed.filter(a => a.terms.length > 0 && !cited.has(a.slug));
  const fresh = [];
  const backlog = [];
  for (const a of uncited) {
    (cutoff && Date.parse(a.postDate) < cutoff ? backlog : fresh).push(a);
  }
  return { fresh, backlog };
}

const SWEEP_CONDITION_KEY = 'commercial-broadway-journal-uncited-posts';

function sweepAlertOpts(fresh, nowIso = new Date().toISOString()) {
  const lines = fresh.map(a => `- ${a.postDate.slice(0, 10)} ${a.title} ${a.url} [${a.terms.join(', ')}]`);
  return {
    // One aggregate condition per sweep so a backlog files one card, not a burst.
    conditionKey: SWEEP_CONDITION_KEY,
    // Weekly cron: a 168h default cooldown would mute alternate weeks.
    cooldownHours: 24,
    title: `Broadway Journal: ${fresh.length} post${fresh.length > 1 ? 's' : ''} quoting financial filings are not cited in commercial data`,
    description: `Weekly sweep (scripts/sweep-broadway-journal.js) found posts mentioning AG filings, financial statements, recoupment or capitalization whose URL is not cited in data/commercial.json. Nothing was applied.\n${lines.join('\n')}\nSwept ${nowIso}.`,
    hint: 'Read each post, extract capitalization, weekly running costs and recoupment figures with a citation, and add them to data/commercial.json by hand (or via the pending-review path).',
    disposition: 'auto',
    severity: 'warning',
  };
}

module.exports = { slugFromUrl, citedSlugs, stripHtml, scanFinancialTerms, fetchArchive, selectUncited, sweepAlertOpts, SWEEP_CONDITION_KEY, FINANCIAL_PATTERNS };
