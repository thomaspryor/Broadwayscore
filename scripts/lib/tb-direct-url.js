// Talkin' Broadway direct-URL helper.
// SERP returns the All That Chat forum instead of the review, so we construct the review URL
// directly. BUT: TB 404s return an old-production review for revivals, or a soft-404 page that
// passes naive byte-length gates. This helper verifies the fetched page before storing.
//
// Usage:
//   const { tryTbDirectUrl, buildTbCandidateUrls, verifyTbPage } = require('./scripts/lib/tb-direct-url');
//   const result = await tryTbDirectUrl({
//     show,            // { id, title, openingDate, tbReviewUrl? }
//     year,            // show year (number, e.g. 2026)
//     overrideUrl,     // optional CLI override
//     fetchPage,       // from scripts/lib/scraper
//     isRevival,       // bool — if true, date gate is tighter (openingDate - 1d)
//   });
//   // → { found: true, url, source, reason? } | { found: false, reason }

const ARTICLES = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for']);
const ROMAN_NUMERAL_RE = /^(?:I{1,3}|IV|VI{0,3}|IX|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX)$/i;
const TB_HOST = 'https://www.talkinbroadway.com';
const MIN_CONTENT_BYTES = 800; // TB 404 pages are <500 bytes; real reviews are >3KB

const { foldDiacritics } = require('./title-match');
const { shortTitleCandidate } = require('./title-normalization');
const { containsAsWords } = require('./title-containment');

// Same floor used by verifyTbPage's short-title fallback below — short titles under this
// length (e.g. "Oh, Mary!" → "Oh") are too generic to build a reliable URL slug from.
const MIN_SHORT_VARIANT_CHARS = 4;

function toCamelSlug(title) {
  return foldDiacritics(title)
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      if (ROMAN_NUMERAL_RE.test(w)) return w.toUpperCase();
      const lower = w.toLowerCase();
      if (i > 0 && ARTICLES.has(lower)) return lower;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join('');
}

function toLowerSlug(title) {
  return foldDiacritics(title).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildTbCandidateUrls(title, year) {
  const camel = toCamelSlug(title);
  const lower = toLowerSlug(title);
  const y4 = String(year);
  const y2 = y4.slice(-2);
  const urls = [
    `${TB_HOST}/page/world/${camel}${y4}.html`,
    `${TB_HOST}/page/world/${camel}${y2}.html`,
    `${TB_HOST}/page/world/${camel}.html`,
    `${TB_HOST}/page/world/${lower}${y4}.html`,
  ];
  // Comma-subtitled shows ("Beaches, A New Musical") get indexed by TB under the
  // short title only ("Beaches.html"). See verifyTbPage's short-title fallback for
  // the same guard rationale (Beaches 2026-04-22 opening night).
  //
  // Length check uses normalizeText (strips punctuation) to match the floor verifyTbPage
  // applies to the same short title — a raw-character check would disagree with it (e.g.
  // "Oh!!" is 4 raw chars but normalizes to "oh", 2 chars).
  //
  // Dated variants are tried before the bare short-title page: an undated short-title URL
  // has no publish-date signal, so for a revival it could match an old production's page
  // before a same-titled dated page is ever tried (verifyTbPage's date-window gate only
  // rejects it if a date happens to be extractable from the page).
  // Short-title variants. Two sources, most specific first:
  //   1. the title cut at its first ';' or ':' — TB files subtitled shows under the main
  //      title only ("School Girls; Or, The African Mean Girls Play" → SchoolGirls.html,
  //      School Girls opening night 2026-09-28; shortTitleCandidate only knows commas,
  //      which gave "School Girls; Or" → SchoolGirlsOr*.html, never tried the real page);
  //   2. shortTitleCandidate's comma cut ("Beaches, A New Musical" → Beaches.html).
  const shortTitles = [];
  const punctCut = (typeof title === 'string' ? title : '').split(/[;:]/)[0].trim();
  if (punctCut && punctCut !== title) shortTitles.push(punctCut);
  const commaShort = shortTitleCandidate(title);
  if (commaShort && !shortTitles.includes(commaShort)) shortTitles.push(commaShort);
  const seen = new Set(urls);
  for (const shortTitle of shortTitles) {
    if (normalizeText(shortTitle).length < MIN_SHORT_VARIANT_CHARS) continue;
    const camelShort = toCamelSlug(shortTitle);
    const lowerShort = toLowerSlug(shortTitle);
    if (!camelShort || camelShort === camel) continue;
    // All dated variants (camel + lowercase) before the bare undated one, so a
    // revival can't match an old production's page before any dated page is tried.
    for (const u of [
      `${TB_HOST}/page/world/${camelShort}${y4}.html`,
      `${TB_HOST}/page/world/${camelShort}${y2}.html`,
      `${TB_HOST}/page/world/${lowerShort}${y4}.html`,
      `${TB_HOST}/page/world/${camelShort}.html`,
    ]) {
      if (!seen.has(u)) { seen.add(u); urls.push(u); }
    }
  }
  return urls;
}

function normalizeText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return m ? m[1].trim() : '';
}

function hasBylineSignal(html) {
  // Real TB reviews credit: "reviewed by Matthew Murray" or "by Matthew Murray"
  return /(?:reviewed\s+)?by\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(html || '');
}

function hasStarRatingSignal(html) {
  // TB doesn't use a formal star widget, but review pages commonly include
  // explicit verdict tokens that pure 404 / index pages don't carry.
  return /verdict|recommended|rave|must[-\s]see|four\s+stars|three\s+stars|five\s+stars/i.test(html || '');
}

function extractPublishDateCandidate(html) {
  // TB format: "April 19, 2026" appears near the byline.
  // Return the first Date-parseable match near the top of the page.
  const head = (html || '').slice(0, 4000);
  const m = /([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/.exec(head);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d.getTime()) ? null : d;
}

function withinDateWindow(publishDate, openingDate, { isRevival = false } = {}) {
  if (!openingDate) return true; // No opening date to gate against
  if (!publishDate) return null; // unknown — caller decides
  const opening = new Date(openingDate);
  if (isNaN(opening.getTime())) return true;
  const msPerDay = 86400000;
  // Revival: tight lower bound to reject old-production reviews.
  const lowerDays = isRevival ? 1 : 7;
  const upperDays = 30;
  const lower = opening.getTime() - lowerDays * msPerDay;
  const upper = opening.getTime() + upperDays * msPerDay;
  const t = publishDate.getTime();
  return t >= lower && t <= upper;
}

function verifyTbPage(html, { showTitle, openingDate, isRevival = false } = {}) {
  if (!html || html.length < MIN_CONTENT_BYTES) {
    return { ok: false, reason: `content too short (${(html || '').length} bytes, need ${MIN_CONTENT_BYTES})` };
  }
  const pageTitle = extractTitle(html);
  const normPage = normalizeText(pageTitle);
  // Short-title fallback for comma-subtitled shows: TB page titles carry the short title only
  // ("Beaches" not "Beaches, A New Musical"). Beaches 2026-04-22 opening night.
  //
  // Guard: normalized short title must be ≥4 chars. "Oh, Mary!" must not fall back
  // to the generic word "Oh". Whole-word matching below also rejects substrings
  // such as "oh" inside "Wholesome".
  // 4 chars is safe for known cases: "Beaches" (7), "Grey" (4 — would work if subtitled).
  const titleVariants = [showTitle];
  // Same two short forms buildTbCandidateUrls() tries: the main title before a ';' or ':'
  // and the comma cut. A candidate URL the builder reaches must not then be rejected
  // here because TB's page title carries only that main title.
  const punctCut = (typeof showTitle === 'string' ? showTitle : '').split(/[;:]/)[0].trim();
  for (const shortTitle of [punctCut !== showTitle ? punctCut : '', shortTitleCandidate(showTitle)]) {
    if (shortTitle && !titleVariants.includes(shortTitle) && normalizeText(shortTitle).length >= MIN_SHORT_VARIANT_CHARS) {
      titleVariants.push(shortTitle);
    }
  }
  const titleMatched = titleVariants.some(variant => {
    const normVariant = normalizeText(variant);
    return containsAsWords(normPage, normVariant);
  });
  if (!titleMatched) {
    return { ok: false, reason: `title mismatch (page="${pageTitle.slice(0, 80)}", show="${showTitle}")` };
  }
  const byline = hasBylineSignal(html);
  const stars = hasStarRatingSignal(html);
  if (!byline && !stars) {
    return { ok: false, reason: 'no review signal (byline or verdict keyword)' };
  }
  const publishDate = extractPublishDateCandidate(html);
  const inWindow = withinDateWindow(publishDate, openingDate, { isRevival });
  if (inWindow === false) {
    return {
      ok: false,
      reason: `publishDate ${publishDate.toISOString().slice(0, 10)} outside window for opening ${openingDate}${isRevival ? ' (revival — strict)' : ''}`,
    };
  }
  return { ok: true, publishDate };
}

// Total wall-clock budget for one tryTbDirectUrl() call. Each candidate that fails at the
// scraper layer can cost 60-90 s (provider chain: Scrapingdog 400 → stealth 500 → Bright
// Data timeout → Playwright timeout); on 2026-09-28 the loop ate 9 of the poller's 10
// per-show minutes and the pass was killed before any review file was written (BRO-4217).
// Candidates are now fetched together (BRO-6589), so the budget only bounds a hung fetch.
const DEFAULT_TB_BUDGET_MS = 240000;
const TB_PARALLEL = 5;
function tbBudgetMs(explicit) {
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  // An unset workflow var arrives as '' (env: X: ${{ vars.X }}) and Number('') is 0,
  // which would silently mean "one candidate, no index fallback". Blank means unset.
  const raw = String(process.env.TB_DIRECT_URL_BUDGET_MS || '').trim();
  const env = raw ? Number(raw) : NaN;
  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_TB_BUDGET_MS;
}

// Index fallback: TB always shows the latest review at /page/world/index.html.
// Title format: `Talkin' Broadway on Broadway Review: "{TITLE}" {date}`.
// Verify the quoted title matches the show before accepting.
function verifyTbIndexPage(content, { show, isRevival }) {
  if (!content || content.length < MIN_CONTENT_BYTES) return { ok: false, reason: 'index page empty' };
  const pageTitle = extractTitle(content);
  const quotedMatch = pageTitle.match(/"([^"]+)"/);
  const indexShowTitle = quotedMatch ? quotedMatch[1].trim() : '';
  const normIndex = normalizeText(indexShowTitle);
  const normShow = normalizeText(show.title);
  const titleMatches = containsAsWords(normIndex, normShow) || containsAsWords(normShow, normIndex);
  if (!titleMatches) {
    return { ok: false, reason: `title "${indexShowTitle}" does not match show "${show.title}"`, mismatch: true };
  }
  // Run the same byline/date verification we run on the candidate URLs.
  const v = verifyTbPage(content, {
    showTitle: indexShowTitle, // Use the index's title since we already matched
    openingDate: show.openingDate,
    isRevival,
  });
  return v.ok ? { ...v, indexShowTitle } : v;
}

async function tryTbDirectUrl({ show, year, overrideUrl, fetchPage, isRevival = false, logger = console, budgetMs, now = Date.now }) {
  if (!show || !show.title) return { found: false, reason: 'no show title' };
  const candidates = overrideUrl
    ? [overrideUrl]
    : buildTbCandidateUrls(show.title, year);
  const indexUrl = `${TB_HOST}/page/world/index.html`;
  const urls = overrideUrl ? candidates : [...candidates, indexUrl];

  // BRO-6589: every candidate is a ~60 s paid unlocker fetch behind Cloudflare, and before
  // the review publishes all of them miss on every poll pass. Fetching up to TB_PARALLEL at
  // a time takes one fetch of wall time for a plain title instead of five. The budget works
  // as before: no new fetch starts once it is spent, and a fetch already started is awaited
  // (fetchPage has its own provider timeouts). Once a candidate verifies, nothing of lower
  // priority starts; the first verified candidate in priority order wins, then the index.
  const deadline = now() + tbBudgetMs(budgetMs);
  const answered = urls.map(() => 'budget');
  let next = 0;
  let bestVerified = Infinity;
  const worker = async () => {
    // The first candidate always goes out, so an override URL is fetched even at budget 0.
    while (next < urls.length && next < bestVerified && (next === 0 || now() < deadline)) {
      const i = next++;
      logger.log(urls[i] === indexUrl ? `  Talkin' Broadway: trying index.html fallback...` : `  Checking Talkin' Broadway: ${urls[i]}`);
      answered[i] = await fetchPage(urls[i], { renderJs: false }).then(page => ({ page }), err => ({ err }));
      const content = answered[i].page && answered[i].page.content;
      if (i < candidates.length && content && verifyTbPage(content, { showTitle: show.title, openingDate: show.openingDate, isRevival }).ok) {
        bestVerified = Math.min(bestVerified, i);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TB_PARALLEL, urls.length) }, worker));
  const timedOut = answered.filter(p => p === 'budget').length;

  for (let i = 0; i < candidates.length; i++) {
    const r = answered[i];
    if (r === 'budget') continue;
    if (r.err) { logger.log(`    fetch error (${candidates[i]}): ${r.err.message}`); continue; }
    if (!r.page || !r.page.content) continue;
    const v = verifyTbPage(r.page.content, {
      showTitle: show.title,
      openingDate: show.openingDate,
      isRevival,
    });
    if (v.ok) {
      logger.log(`  Talkin' Broadway: verified — ${candidates[i]}`);
      return {
        found: true,
        url: candidates[i],
        source: overrideUrl ? 'direct-url-override' : 'direct-url-construction',
        publishDate: v.publishDate ? v.publishDate.toISOString() : null,
      };
    }
    logger.log(`    rejected (${candidates[i]}): ${v.reason}`);
  }

  if (!overrideUrl) {
    const r = answered[candidates.length];
    if (r !== 'budget' && r.err) logger.log(`    index fetch error: ${r.err.message}`);
    else if (r !== 'budget' && r.page) {
      const v = verifyTbIndexPage(r.page.content, { show, isRevival });
      if (v.ok) {
        logger.log(`  Talkin' Broadway: index.html matched — "${v.indexShowTitle}"`);
        return {
          found: true,
          url: indexUrl,
          source: 'direct-url-index-fallback',
          publishDate: v.publishDate ? v.publishDate.toISOString() : null,
        };
      }
      logger.log(v.mismatch ? `  Talkin' Broadway index: ${v.reason}` : `    index rejected: ${v.reason}`);
    }
  }

  if (timedOut > 0) {
    logger.log(`  Talkin' Broadway: time budget exhausted with ${timedOut}/${urls.length} fetch(es) never started — stopping so the poll cycle can finish`);
    return { found: false, reason: `time budget exhausted with ${timedOut} of ${urls.length} fetches never started` };
  }
  return { found: false, reason: `all ${candidates.length} candidates${overrideUrl ? '' : ' + index fallback'} failed verification` };
}

// Off-Broadway TB reviews live at /page/ob/MM_DD_YY.html (optional b/c suffix for a second
// or third review the same day), not under /page/world/. Show Score links TB's OB front
// page (/page/ob/index.html), which only showed the review at fetch time, so the stored
// URL is a listing page and the review never publishes (BRO-4437).
const TB_OB_INDEX_RE = /^https?:\/\/(?:www\.)?talkinbroadway\.com\/page\/ob\/index\.html?\/?(?:[?#].*)?$/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function isTbObIndexUrl(url) {
  return typeof url === 'string' && TB_OB_INDEX_RE.test(url.trim());
}

// "Theatre Review by Marc Miller - September 29, 2026" -> { y, m, d } (null when absent).
// Only the first 1500 chars are searched: the date line sits in the header, and a body
// that mentions another date must not win.
function extractTbReviewDate(text) {
  const head = String(text || '').slice(0, 1500);
  const m = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i.exec(head);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  const day = Number(m[2]);
  if (!month || day < 1 || day > 31) return null;
  return { y: Number(m[3]), m: month, d: day };
}

function buildTbObCandidateUrls(date) {
  if (!date || !date.y || !date.m || !date.d) return [];
  const pad = (n) => String(n).padStart(2, '0');
  const base = `${TB_HOST}/page/ob/${pad(date.m)}_${pad(date.d)}_${pad(date.y % 100)}`;
  return [`${base}.html`, `${base}b.html`, `${base}c.html`];
}

// Resolve a TB OB index URL to the dated review page. Accepts a candidate only when
// verifyTbPage passes (title + review signal) AND the critic's surname is on the page,
// so a same-day review of another show or by another critic is never taken.
async function resolveTbObIndexUrl({ url, reviewText, showTitle, criticName, fetchPage, logger = console }) {
  if (!isTbObIndexUrl(url)) return { found: false, reason: 'not a TB Off-Broadway index url' };
  const date = extractTbReviewDate(reviewText);
  if (!date) return { found: false, reason: 'no date line in review text' };
  const surname = String(criticName || '').replace(/\b(?:jr|sr|ii|iii|iv)\.?$/i, '').trim().split(/\s+/).pop().replace(/[^\p{L}'-]/gu, '').toLowerCase();
  if (!surname || surname === 'unknown') return { found: false, reason: 'no critic name to verify against' };
  const surnameRe = new RegExp(`\\bby\\s+[^<]{0,40}\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  for (const candidate of buildTbObCandidateUrls(date)) {
    let page;
    try {
      page = await fetchPage(candidate, { renderJs: false });
    } catch (e) {
      logger.log(`    fetch error: ${e.message}`);
      continue;
    }
    if (!page || !page.content) continue;
    const v = verifyTbPage(page.content, { showTitle, openingDate: null });
    if (!v.ok) { logger.log(`    rejected ${candidate}: ${v.reason}`); continue; }
    if (!surnameRe.test(page.content)) {
      logger.log(`    rejected ${candidate}: critic "${criticName}" not on page`);
      continue;
    }
    return { found: true, url: candidate, source: 'tb-ob-date-resolution' };
  }
  return { found: false, reason: 'no dated candidate verified' };
}

module.exports = {
  buildTbCandidateUrls,
  verifyTbPage,
  tryTbDirectUrl,
  isTbObIndexUrl,
  extractTbReviewDate,
  buildTbObCandidateUrls,
  resolveTbObIndexUrl,
  _internal: { toCamelSlug, toLowerSlug, extractTitle, hasBylineSignal, hasStarRatingSignal, extractPublishDateCandidate, withinDateWindow, tbBudgetMs, DEFAULT_TB_BUDGET_MS },
};
