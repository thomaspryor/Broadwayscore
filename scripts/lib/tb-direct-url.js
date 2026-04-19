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

function toCamelSlug(title) {
  return title
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
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildTbCandidateUrls(title, year) {
  const camel = toCamelSlug(title);
  const lower = toLowerSlug(title);
  const y4 = String(year);
  const y2 = y4.slice(-2);
  return [
    `${TB_HOST}/page/world/${camel}${y4}.html`,
    `${TB_HOST}/page/world/${camel}${y2}.html`,
    `${TB_HOST}/page/world/${camel}.html`,
    `${TB_HOST}/page/world/${lower}${y4}.html`,
  ];
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
  const normShow = normalizeText(showTitle);
  if (!normShow || !normPage.includes(normShow)) {
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

async function tryTbDirectUrl({ show, year, overrideUrl, fetchPage, isRevival = false, logger = console }) {
  if (!show || !show.title) return { found: false, reason: 'no show title' };
  const candidates = overrideUrl
    ? [overrideUrl]
    : buildTbCandidateUrls(show.title, year);
  for (const url of candidates) {
    logger.log(`  Checking Talkin' Broadway: ${url}`);
    let page;
    try {
      page = await fetchPage(url, { renderJs: false });
    } catch (e) {
      logger.log(`    fetch error: ${e.message}`);
      continue;
    }
    if (!page || !page.content) {
      continue;
    }
    const v = verifyTbPage(page.content, {
      showTitle: show.title,
      openingDate: show.openingDate,
      isRevival,
    });
    if (v.ok) {
      logger.log(`  Talkin' Broadway: verified — ${url}`);
      return {
        found: true,
        url,
        source: overrideUrl ? 'direct-url-override' : 'direct-url-construction',
        publishDate: v.publishDate ? v.publishDate.toISOString() : null,
      };
    }
    logger.log(`    rejected: ${v.reason}`);
  }

  // Fallback: TB always shows the latest review at /page/world/index.html.
  // Title format: `Talkin' Broadway on Broadway Review: "{TITLE}" {date}`.
  // Verify the quoted title matches the show before accepting.
  if (!overrideUrl) {
    const indexUrl = `${TB_HOST}/page/world/index.html`;
    logger.log(`  Talkin' Broadway: trying index.html fallback...`);
    try {
      const page = await fetchPage(indexUrl, { renderJs: false });
      if (page && page.content && page.content.length >= MIN_CONTENT_BYTES) {
        const pageTitle = extractTitle(page.content);
        const quotedMatch = pageTitle.match(/"([^"]+)"/);
        const indexShowTitle = quotedMatch ? quotedMatch[1].trim() : '';
        const normIndex = normalizeText(indexShowTitle);
        const normShow = normalizeText(show.title);
        const titleMatches = normIndex && normShow && (normIndex === normShow || normIndex.includes(normShow) || normShow.includes(normIndex));
        if (titleMatches) {
          // Run the same byline/date verification we run on the candidate URLs.
          const v = verifyTbPage(page.content, {
            showTitle: indexShowTitle, // Use the index's title since we already matched
            openingDate: show.openingDate,
            isRevival,
          });
          if (v.ok) {
            logger.log(`  Talkin' Broadway: index.html matched — "${indexShowTitle}"`);
            return {
              found: true,
              url: indexUrl,
              source: 'direct-url-index-fallback',
              publishDate: v.publishDate ? v.publishDate.toISOString() : null,
            };
          }
          logger.log(`    index rejected: ${v.reason}`);
        } else {
          logger.log(`  Talkin' Broadway index: title "${indexShowTitle}" does not match show "${show.title}"`);
        }
      }
    } catch (e) {
      logger.log(`    index fetch error: ${e.message}`);
    }
  }

  return { found: false, reason: `all ${candidates.length} candidates${overrideUrl ? '' : ' + index fallback'} failed verification` };
}

module.exports = {
  buildTbCandidateUrls,
  verifyTbPage,
  tryTbDirectUrl,
  _internal: { toCamelSlug, toLowerSlug, extractTitle, hasBylineSignal, hasStarRatingSignal, extractPublishDateCandidate, withinDateWindow },
};
