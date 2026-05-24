#!/usr/bin/env node
/**
 * Scrape Off Broadway Alliance Awards (OBA) winners + nominees from Playbill.
 *
 * Why Playbill, not Wikipedia: OBA has no Wikipedia page. The OBA's own site
 * (offbroadwayalliance.com/oba-awards-YYYY/) is photo-gallery pages with no
 * structured data. Playbill publishes one round-up article per ceremony year
 * with categories in <p> blocks, nominees separated by <br>, show titles in
 * <em>, and winners prefixed "WINNER -".
 *
 * Operating mode: one-shot back-fill. Run locally to produce
 * data/precursors/oba.json; commit the JSON. A thin per-year follow-up
 * (scripts/scrape-oba-current-year.js) handles new ceremonies — out of scope
 * for this PR.
 *
 * Season-bucket convention: OBA ceremony year Y honors productions opening
 * during the (Y-1)-Y Broadway season (verified from Playbill article text:
 * "honoring productions that opened during the 2023-2024 season" for the
 * 2024 ceremony). This matches ceremonyYearToTonySeason(Y) exactly, so
 * standard applyDDOCCDL routing through Pass 5 works without a source-year
 * shift.
 *
 * Usage:
 *   node scripts/scrape-off-broadway-alliance.js                # dry run, all years
 *   node scripts/scrape-off-broadway-alliance.js --year=2024    # single year
 *   node scripts/scrape-off-broadway-alliance.js --write        # write JSON
 *   node scripts/scrape-off-broadway-alliance.js --force        # bypass shrink guard
 */

const { fetchPage } = require('./lib/scraper');
const { serpQuery } = require('./lib/url-discovery');
const { writePrecursorJson } = require('./lib/precursor-wikipedia');
const { JSDOM } = require('jsdom');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FORCE = args.includes('--force');
const yearArg = args.find((a) => a.startsWith('--year='));
const SINGLE_YEAR = yearArg ? parseInt(yearArg.split('=')[1], 10) : null;
const MIN_YEAR = 2011;
const MAX_YEAR = new Date().getUTCFullYear();

const CATEGORY_PATTERNS = [
  { canonical: 'Best New Musical', re: /^best new musical/i },
  { canonical: 'Best New Play', re: /^best new play/i },
  { canonical: 'Best Musical Revival', re: /^best musical revival|^best revival of a musical/i },
  { canonical: 'Best Play Revival', re: /^best play revival|^best revival of a play/i },
  { canonical: 'Best Revival', re: /^best revival(?!\s+of)/i },
  { canonical: 'Best Solo Performance', re: /^best solo performance/i },
  { canonical: 'Best Unique Theatrical Experience', re: /^best unique theatr/i },
  { canonical: 'Best Family Show', re: /^best family show/i },
];

function classifyHeader(line) {
  const trimmed = line.trim();
  for (const { canonical, re } of CATEGORY_PATTERNS) {
    if (re.test(trimmed)) return { canonical, remainder: trimmed.replace(re, '').trim() };
  }
  return null;
}

/** SERP-discover the Playbill winners article for a given ceremony year.
 *  Filter: playbill.com/article/ + alliance + winner-ish slug.
 *  No year-in-slug requirement: COVID skipped 2020, breaking ordinal math,
 *  and Playbill often uses "Nth Annual" rather than the calendar year. */
async function discoverArticleUrl(year) {
  const queries = [
    `site:playbill.com "Off Broadway Alliance" winners ${year}`,
    `site:playbill.com "Off Broadway Alliance Awards" winners ${year}`,
    `site:playbill.com "Off Broadway Alliance" ${year} winner`,
  ];
  for (const q of queries) {
    const results = await serpQuery(q, { nbResults: 8, preferSpeed: true });
    if (!results) continue;
    const candidates = results.filter((r) => {
      if (!/playbill\.com\/article\//.test(r.url)) return false;
      const slug = r.url.toLowerCase();
      const mentionsAlliance = /off.?broadway.?alliance/.test(slug);
      const looksLikeWinners = /\bwin(ner)?s?\b|\bhonor/.test(slug);
      return mentionsAlliance && looksLikeWinners;
    });
    if (candidates.length > 0) return candidates[0].url;
  }
  return null;
}

async function scrapeYearFromUrl(year, url) {
  if (!url) {
    console.log(`  ${year}: no winners article found`);
    return null;
  }
  console.log(`  ${year}: ${url}`);
  const r = await fetchPage(url, { name: 'oba-playbill' });
  const html = r && (r.content || r.html);
  if (!html) {
    console.log(`  ${year}: fetch failed`);
    return null;
  }
  const cleanHtml = html.replace(/&nbsp;/g, ' ').replace(/<\/?u(\s[^>]*)?>/gi, '');
  const dom = new JSDOM(cleanHtml);
  const doc = dom.window.document;
  // Pull the real ceremony year from JSON-LD datePublished BEFORE removing
  // <script> tags. SERP queries return the closest-relevant article which
  // may actually be the next or prior ceremony — trust the article, not the
  // query year. Fallback to query year if extraction fails.
  const realCeremonyYear = extractCeremonyYear(doc) || year;
  doc.querySelectorAll('script, style, nav, footer, header, aside').forEach((e) => e.remove());
  const article = doc.querySelector('article') || doc.querySelector('main') || doc.body;
  const paragraphs = Array.from(article.querySelectorAll('p'));
  const out = {};
  for (const p of paragraphs) {
    // Header may be <strong> (modern) or <b> (legacy Playbill pre-2020).
    const headerEl = p.querySelector('strong, b');
    if (!headerEl) continue;
    const headerText = (headerEl.textContent || '').trim();
    const classified = classifyHeader(headerText);
    if (!classified) continue;
    const parsed = parseParagraph(p, classified.canonical);
    if (!parsed || parsed.nominees.length === 0) continue;
    if (out[classified.canonical] && out[classified.canonical].nominees.length >= parsed.nominees.length) continue;
    out[classified.canonical] = parsed;
  }
  // Attach the real ceremony year so the caller can re-key the output if
  // SERP returned an article from a different year than queried.
  out.__ceremonyYear = realCeremonyYear;
  return out;
}

/** Extract the actual ceremony year from a Playbill article's JSON-LD
 *  datePublished or article title. Returns null if neither yields a 4-digit
 *  year in the plausible OBA range (2011..current). */
function extractCeremonyYear(doc) {
  const now = new Date().getUTCFullYear();
  // 1) JSON-LD datePublished — most reliable.
  const ldScripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  for (const s of ldScripts) {
    try {
      const j = JSON.parse(s.textContent);
      const dp = j.datePublished || (Array.isArray(j['@graph']) && j['@graph'].find((g) => g.datePublished)?.datePublished);
      if (dp) {
        const m = String(dp).match(/^(\d{4})/);
        if (m) {
          const yr = parseInt(m[1], 10);
          if (yr >= 2011 && yr <= now) return yr;
        }
      }
    } catch { /* ignore */ }
  }
  // 2) Title year mention.
  const title = (doc.querySelector('h1')?.textContent || doc.title || '').trim();
  const titleYears = (title.match(/\b(20\d{2})\b/g) || []).map((y) => parseInt(y, 10)).filter((y) => y >= 2011 && y <= now);
  if (titleYears.length > 0) return titleYears[titleYears.length - 1];
  return null;
}

/** Parse one category <p>: split innerHTML on <br>, extract title content
 *  (<em>/<i> for modern/legacy), mark winner via "WINNER -" or leading "*".
 *  Older Playbill (pre-2020): <b>*<i>Title</i></b>
 *  Newer Playbill: <strong>WINNER - <em>Title</em></strong> */
function parseParagraph(pEl, canonical) {
  const inner = pEl.innerHTML.replace(/<br\s*\/?>/gi, '<<BR>>');
  const segments = inner.split('<<BR>>');
  let winner = null;
  const nominees = [];
  const seen = new Set();
  for (const segHtml of segments) {
    const tmp = pEl.ownerDocument.createElement('div');
    tmp.innerHTML = segHtml;
    const segText = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
    if (!segText) continue;
    // Winner markers: "WINNER -" (modern) OR leading "*" before title (legacy).
    const isWinner = /\bWINNER\b\s*[-:]/i.test(segText) || /^\s*\*/.test(segText);
    // Extract titles from <em> (modern) or <i> (legacy).
    const titleEls = Array.from(tmp.querySelectorAll('em, i'));
    let titles = [];
    if (titleEls.length > 0) {
      titles = titleEls.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    } else {
      let s = segText.replace(/^.*?\bWINNER\b\s*[-:]\s*/i, '').replace(/^\s*\*+\s*/, '').trim();
      s = s.replace(new RegExp('^' + escapeRegex(canonical) + '\\s*', 'i'), '').trim();
      if (s) titles = [s];
    }
    for (const t of titles) {
      const cleaned = cleanTitle(t);
      if (!cleaned) continue;
      const k = cleaned.toLowerCase();
      if (!seen.has(k)) { seen.add(k); nominees.push(cleaned); }
      if (isWinner && !winner) winner = cleaned;
    }
  }
  if (winner && !nominees.some((n) => n.toLowerCase() === winner.toLowerCase())) {
    nominees.unshift(winner);
  }
  return { winner, nominees };
}

function cleanTitle(s) {
  if (!s) return null;
  const t = s.replace(/^\s*WINNER\s*[-:]\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[-\s,]+|[-\s,]+$/g, '')
    .trim();
  if (t.length < 2) return null;
  if (/^(by|winner|the winners|the nominees|honorees?)$/i.test(t)) return null;
  return t;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  const years = SINGLE_YEAR ? [SINGLE_YEAR] : [];
  if (!SINGLE_YEAR) {
    for (let y = MIN_YEAR; y <= MAX_YEAR; y++) years.push(y);
  }
  console.log(`Scraping OBA for ${years.length} year(s): ${years.join(', ')}`);

  const result = {};
  let okYears = 0;
  let failYears = 0;
  const seenUrls = new Map();      // url -> first query year that used it
  const seenCeremonyYears = new Set(); // canonical ceremony years already recorded
  for (const queryYear of years) {
    let perCat;
    let resolvedUrl;
    try {
      resolvedUrl = await discoverArticleUrl(queryYear);
      if (resolvedUrl && seenUrls.has(resolvedUrl)) {
        console.log(`  ${queryYear}: skipped (URL already used by query ${seenUrls.get(resolvedUrl)})`);
        failYears++;
        continue;
      }
      perCat = await scrapeYearFromUrl(queryYear, resolvedUrl);
      if (resolvedUrl) seenUrls.set(resolvedUrl, queryYear);
    } catch (e) {
      console.log(`  ${queryYear}: ERROR ${e.message}`);
      failYears++;
      continue;
    }
    if (!perCat || Object.keys(perCat).length === 0) {
      failYears++;
      continue;
    }
    const actualYear = perCat.__ceremonyYear || queryYear;
    delete perCat.__ceremonyYear;
    if (seenCeremonyYears.has(actualYear)) {
      console.log(`  ${queryYear}: skipped (ceremony year ${actualYear} already recorded)`);
      failYears++;
      continue;
    }
    seenCeremonyYears.add(actualYear);
    okYears++;
    let catsFound = 0;
    for (const [cat, payload] of Object.entries(perCat)) {
      if (!result[cat]) result[cat] = [];
      result[cat].push({ year: actualYear, winner: payload.winner, nominees: payload.nominees });
      catsFound++;
    }
    const yearLabel = actualYear === queryYear ? `${actualYear}` : `${actualYear} (queried ${queryYear})`;
    console.log(`  ${queryYear}: ${catsFound} categories parsed [ceremony ${yearLabel}]`);
  }

  for (const cat of Object.keys(result)) {
    result[cat].sort((a, b) => a.year - b.year);
  }

  const totalEntries = Object.values(result).reduce((s, arr) => s + arr.length, 0);
  console.log(`\nDone: ${okYears}/${years.length} years OK, ${failYears} fail, ${totalEntries} category-year entries.`);
  for (const [cat, arr] of Object.entries(result)) {
    console.log(`  ${cat}: ${arr.length} years`);
  }

  if (failYears > years.length / 2 && !FORCE) {
    console.error('\nMore than half of years failed to parse. Aborting write. Pass --force to override.');
    process.exit(2);
  }

  const out = writePrecursorJson('oba', result, {
    force: FORCE,
    dryRun: !WRITE,
    meta: {
      source: 'Playbill annual round-up articles',
      sourceNote: 'Categories + winners + nominees parsed from Playbill body text. WINNER marker variants normalized.',
      minYear: MIN_YEAR,
      maxYear: MAX_YEAR,
    },
  });
  console.log(out.written
    ? `\nWrote ${out.fp} (${out.newCount} entries, was ${out.oldCount})`
    : `\n(dry run; pass --write to commit; ${out.newCount} entries vs baseline ${out.oldCount})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
