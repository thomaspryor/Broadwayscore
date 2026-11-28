/**
 * BRO-2075 — pure planning logic for draining data/audit/unknown-aggregator-outlets.json.
 *
 * The audit file lists outlet hosts the registry doesn't know. ingest-review-from-url.js
 * can now ingest them under a provisional (domain-derived) outlet id, so the drain walks
 * each host's sampleUrls and prepares one ingest per (show, url). Everything here is pure;
 * scripts/drain-unknown-outlets.js owns the I/O (fetch, ledger file, spawn).
 */
const { provisionalOutletIdFromHost } = require('./outlet-canonicalize');
const { titleTokens, urlMatchesShow, hostOf } = require('../audit-show-review-gap');

const MIN_OCCURRENCES = 2;

// CDN / social / search hosts that aren't review outlets. provisionalOutletIdFromHost
// already rejects aggregators; this is the domain sanity check for everything else.
const NON_OUTLET_HOST_RE = /(^|\.)(google\.[a-z.]+|cloudfront\.net|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|reddit\.com|wikipedia\.org|amazon\.[a-z.]+|ticketmaster\.com|ticketgenie\.com|uktw\.co\.uk|iloveny\.com|telecharge\.com|todaytix\.com|bit\.ly)$/i;

// Provisional ids that name a hosting platform's section, not a publication
// (open.substack.com/pub/<name> mints 'open'). Registering these would merge unrelated blogs.
const GENERIC_OUTLET_IDS = new Set(['open', 'news', 'blog', 'blogs', 'www', 'm', 'amp', 'app', 'web', 'site', 'pages', 'www2']);

function isSaneOutletHost(host) {
  if (!host || typeof host !== 'string') return false;
  return !NON_OUTLET_HOST_RE.test(host.replace(/^www\./, ''));
}

/** Stable per-ingest key: re-running the drain skips anything already in the ledger. */
function ledgerKey(showId, url) {
  return `${showId}|${url}`;
}

/**
 * Pair a sampleUrl to the show it is about. The audit file stores `shows` and
 * `sampleUrls` as unpaired lists, so match by title tokens against the URL path.
 * Returns the single matching show id, or null when none/ambiguous.
 */
function pairUrlToShow(url, showIds, showsById) {
  const hits = showIds.filter(id => {
    const show = showsById[id];
    if (!show) return false;
    const tokens = titleTokens(show.title);
    // urlMatchesShow accepts everything when a title has no significant tokens
    // ("MJ The Musical") — for a drain that is a wildcard, so treat it as unpaired.
    if (tokens.length === 0) return false;
    return urlMatchesShow(url, tokens);
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Latest 20xx year anywhere in the URL path (dated folder OR slug suffix like -2022-10), or null. */
function urlPathYear(url) {
  try {
    const years = [...new URL(url).pathname.matchAll(/(?:^|[\/_-])(20\d{2})(?=$|[\/_.-])/g)].map(m => Number(m[1]));
    return years.length ? Math.max(...years) : null;
  } catch { return null; }
}

const NON_REVIEW_PATH_RE = /\/(shows?|products?|shop|tickets?|events?|tours?|press-releases?)\/|world-premiere|press-release/i;
const TOUR_PATH_RE = /(^|[\/_-])(tour|touring|on-tour)([\/_.-]|$)/i;

/**
 * Wrong-production / non-review guards the title match can't see. Returns a skip reason or null.
 *  - non-review page (ticket/listing/shop/press-release path)
 *  - review dated before the production opened, or after it closed (earlier/later run)
 *  - tour-stop wording in the URL on a non-West-End show (tours are separate productions)
 *  - non-UK outlet paired to a West End production (a US tour stop)
 */
function productionMismatch(url, show) {
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch { return 'bad-url'; }
  if (NON_REVIEW_PATH_RE.test(pathname)) return 'non-review-url';
  const year = urlPathYear(url);
  const openYear = show && show.openingDate ? Number(String(show.openingDate).slice(0, 4)) : null;
  const closeYear = show && show.closingDate ? Number(String(show.closingDate).slice(0, 4)) : null;
  if (year && openYear && year < openYear) return 'predates-production';
  if (year && closeYear && year > closeYear) return 'after-closing';
  if (show && show.market !== 'west-end' && TOUR_PATH_RE.test(pathname)) return 'tour-stop';
  if (show && show.market === 'west-end') {
    const host = hostOf(url) || '';
    if (!/\.uk$/i.test(host)) return 'non-uk-outlet-for-west-end';
  }
  return null;
}

/**
 * @param {object} audit   parsed unknown-aggregator-outlets.json
 * @param {object} showsById  { [id]: { title } }
 * @param {{ledger?: object, minOccurrences?: number, batchSize?: number}} opts
 * @returns {{batch: object[], skipped: object[]}}
 */
function planDrain(audit, showsById, opts = {}) {
  const { ledger = {}, minOccurrences = MIN_OCCURRENCES, batchSize = 50 } = opts;
  const batch = [];
  const skipped = [];
  for (const o of (audit && audit.outlets) || []) {
    if (o.occurrences < minOccurrences) { skipped.push({ host: o.host, reason: 'below-min-occurrences' }); continue; }
    if (!isSaneOutletHost(o.host)) { skipped.push({ host: o.host, reason: 'non-outlet-host' }); continue; }
    // Derive the provisional id FIRST, from the host, never from the audit file's cached field.
    const outletId = provisionalOutletIdFromHost(o.host);
    if (!outletId) { skipped.push({ host: o.host, reason: 'no-provisional-id' }); continue; }
    if (GENERIC_OUTLET_IDS.has(outletId)) { skipped.push({ host: o.host, reason: 'generic-outlet-id' }); continue; }
    for (const url of o.sampleUrls || []) {
      if (hostOf(url) && !isSaneOutletHost(hostOf(url))) { skipped.push({ host: o.host, url, reason: 'non-outlet-host' }); continue; }
      const showId = pairUrlToShow(url, o.shows || [], showsById);
      if (!showId) { skipped.push({ host: o.host, url, reason: 'unpaired-show' }); continue; }
      const mismatch = productionMismatch(url, showsById[showId]);
      if (mismatch) { skipped.push({ host: o.host, url, reason: mismatch }); continue; }
      const key = ledgerKey(showId, url);
      if (ledger[key]) { skipped.push({ host: o.host, url, reason: 'already-ingested' }); continue; }
      batch.push({
        key, host: o.host, showId, url, outletId,
        args: ['scripts/ingest-review-from-url.js', `--show=${showId}`, `--url=${url}`, `--outlet=${outletId}`, '--provisional'],
      });
    }
  }
  const seen = new Set();
  const unique = batch.filter(b => !seen.has(b.key) && seen.add(b.key));
  return { batch: unique.slice(0, batchSize), skipped, remaining: Math.max(0, unique.length - batchSize) };
}

module.exports = { planDrain, pairUrlToShow, productionMismatch, urlPathYear, isSaneOutletHost, ledgerKey, MIN_OCCURRENCES };
