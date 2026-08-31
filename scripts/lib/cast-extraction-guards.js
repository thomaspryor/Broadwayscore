// Sanity checks for LLM-extracted cast data. Catches the contamination
// patterns seen in 12+ historical bad cast files (Met Opera singers as
// Kavalier-and-Clay cast, TV-show titles as Much-Ado roles, LASTNAME-FIRSTNAME
// names from BWW alphabetical listings). Used by:
//   - scripts/backfill-cast-web.js (pre-write gate)
//   - scripts/audit-cast-contamination.js (post-hoc sweep)
//
// If you extend the patterns here, also extend the audit script's signal list.

const { foldDiacritics } = require('./title-match');

const OPERA_TITLES = [
  'cavalleria rusticana', 'pagliacci', 'nabucco', 'rigoletto', 'tristan', 'isolde',
  'madama butterfly', 'eugene onegin', 'la traviata', 'tosca', 'la boheme',
  'don giovanni', 'aida', 'carmen', 'turandot', 'la sonnambula', 'abigaille',
  'figaro', 'fidelio', 'lohengrin', 'parsifal',
];

const TV_PATTERNS = [
  'bridgerton', 'top boy', 'unforgotten', 'dumping ground',
  'in his first professional role', 'in her first professional role',
];

const COLUMN_HEADER_RE = /^(original|replacement|standby|alternate|swing|ensemble|covering)$/i;

const KNOWN_SWAP_SURNAMES = new Set([
  'jenkins', 'williams', 'smith', 'brown', 'jones', 'morgan',
  'lumsden', 'malpass', 'woodyatt', 'thompson', 'johnson',
]);

// Domains that publish opera coverage. A SERP→LLM extraction landing on
// one of these pages will return opera-singer cast even when the target
// show is a play that shares the title (the Kavalier-Clay case: target was
// the OB play, scraper landed on parterre.com's Met Opera podcast about
// the 2025-26 season). The OPERA_TITLES role check is a downstream backstop;
// blocking at the source-URL level prevents the LLM call entirely.
const OPERA_SOURCE_DOMAINS = [
  'parterre.com',
  'metopera.org',
  'metoperafamily.org',
  'operanews.com',
  'operawire.com',
  'operatoday.com',
  'opera-online.com',
];

function isOperaSourceUrl(url) {
  if (!url) return false;
  const lower = String(url).toLowerCase();
  return OPERA_SOURCE_DOMAINS.some(d => lower.includes(d));
}

// ============================================================================
// SERP result scoring — keeps backfill-cast-web from picking pages for the
// wrong show even when the page itself looks structured.
// ============================================================================

const TITLE_STOPWORDS = new Set([
  'the', 'and', 'with', 'from', 'into', 'over', 'this', 'that',
  'a', 'an', 'of', 'in', 'on', 'to', 'or', 'is', 'it',
]);

// Extract title tokens specific enough to use as relevance signals. Short
// tokens ("the", "of") and 1-3 char words match too freely; only ≥4-char
// non-stopword tokens carry signal.
function meaningfulTitleTokens(title) {
  return foldDiacritics(String(title || ''))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !TITLE_STOPWORDS.has(t));
}

// Parse a 4-digit year from a URL. Matches ONLY exactly-4-digit runs
// (plain years like /2024/) and exactly-8-digit YYYYMMDD stamps (BWW
// article URLs like `Cast-Announced-...-20230329`). 5/6/7-digit runs are
// rejected — a 5-digit non-year like `19999` would slice to `1999` and
// false-positive (caught by Codex ship-check on 2026-05-24). Returns
// null when no year is present.
function parseYearFromUrl(url) {
  const s = String(url || '');
  const years = new Set();
  // Plain 4-digit year (word-bounded)
  for (const m of s.matchAll(/(?<!\d)(\d{4})(?!\d)/g)) {
    const y = parseInt(m[1], 10);
    if (y >= 1950 && y <= 2099) years.add(y);
  }
  // YYYYMMDD — exactly 8 digits, take leading 4 as year
  for (const m of s.matchAll(/(?<!\d)(\d{4})\d{4}(?!\d)/g)) {
    const y = parseInt(m[1], 10);
    if (y >= 1950 && y <= 2099) years.add(y);
  }
  if (years.size === 0) return null;
  // Pick the most recent year if multiple — older-year URLs are usually
  // the contamination case (e.g., an article from 2023 about a 2023 show
  // surfacing on a SERP for a 2026 show with the same title).
  return Math.max(...years);
}

// Detect West-End-show URL pointing at a Broadway-only path (or vice
// versa). Looks at category and URL structure together so that
// /broadway/article/... pages aren't accepted for a West End show.
function detectMarketMismatch(url, category) {
  if (!url || !category) return null;
  const u = String(url).toLowerCase();
  const isWestEnd = category === 'west-end' || category === 'off-west-end';
  const isBroadway = category === 'broadway' || category === 'off-broadway';
  // Broadway domain paths that are Broadway-specific (not /westend/).
  // BWW uses /shows/{Slug-Broadway}/cast (plural) — earlier draft used
  // singular /show/ and missed real URLs (Codex ship-check 2026-05-24).
  const hasBroadwayPath = /broadway\.com\b|\/broadway\b|\/shows?\/[^/]*-broadway\b/.test(u);
  const hasWestEndPath = /\/westend\b|\/west-end\b|westendtheatre\.com\b|londonboxoffice\.co\.uk\b/.test(u);
  if (isWestEnd && hasBroadwayPath && !hasWestEndPath) return 'we-show-on-bw-path';
  if (isBroadway && hasWestEndPath && !hasBroadwayPath) return 'bw-show-on-we-path';
  return null;
}

// Pure score for a single SERP result against a show. Higher = more
// likely the right show's cast page. Caller filters by SERP_MIN_SCORE.
//
// @param {{url?:string, link?:string, title?:string}} result - SERP hit
// @param {string|{title:string, year?:number|string, category?:string}} show
//   Target show. Strings are accepted for backward compat (treated as title-
//   only) but year / market signals require the object form.
function scoreSerpResult(result, show) {
  // Backward-compat: callers passing a bare title string get the title-only
  // scoring path (no year/market signals).
  const showObj = (typeof show === 'string') ? { title: show } : (show || {});
  const showTitle = showObj.title || '';
  const showYear = showObj.year ? Number(String(showObj.year).slice(0, 4)) : null;
  const showCategory = showObj.category || null;

  const url = (result.url || result.link || '').toLowerCase();
  const t = (result.title || '').toLowerCase();
  const titleLower = String(showTitle).toLowerCase().split(':')[0].trim();
  const titleTokens = meaningfulTitleTokens(titleLower);
  let score = 0;

  // Domain bonuses — sites known for structured cast pages
  if (url.includes('broadwayworld.com') && url.includes('/show/')) score += 5;
  if (url.includes('lortel.org')) score += 5;
  if (url.includes('playbill.com') && url.includes('/production/')) score += 4;
  if (url.includes('theatermania.com') && url.includes('/show/')) score += 4;
  if (url.includes('whatsonstage.com')) score += 3;
  if (url.includes('timeout.com')) score += 2;

  // URL path signals — word-bounded so "broadcast" / "podcast" / "forecast"
  // don't masquerade as "cast" (the parterre.com Kavalier-Clay URL was
  // /broadcast/104032/... which the substring check used to falsely reward).
  if (/\b(cast|credits?|people)\b/.test(url)) score += 3;

  // SERP-title signals
  if (t.includes('cast')) score += 2;
  if (t.includes('starring') || t.includes('stars')) score += 2;
  if (t.includes(titleLower)) score += 1;

  // Title-token relevance gate — the single most effective contamination
  // defense. If the URL and SERP title contain NONE of the meaningful title
  // tokens, this is almost certainly a different show. Historical misroutes
  // this catches:
  //   Sting WE      → thelastship-musical.com/cast-and-creatives/
  //   Relics WE     → londonboxoffice.co.uk/news/post/.../oliver
  //   Loves Labours → rsc.org.uk/the-resistible-rise-of-arturo-ui/...
  //   Man to Man    → londonboxoffice.co.uk/news/post/man-and-boy-...
  //   Wedding March → broadwayworld.com/.../FANNY-at-Kings-Head
  // Allow titles whose meaningful tokens are all stopwords ("It", "Six") to
  // fall through by skipping when no tokens survive filtering.
  if (titleTokens.length > 0) {
    const haystack = url + ' ' + t;
    const hits = titleTokens.filter(tok => haystack.includes(tok)).length;
    if (hits === 0) score -= 6;
  }

  // Penalty for review/ticket/news pages (unlikely to have full cast)
  if (url.includes('review') || url.includes('ticket') || url.includes('news')) score -= 2;

  // Year-mismatch defense — catches older productions surfacing for a
  // current show. Historical example caught: Much Ado WE 2026 SERP picked
  // a BWW article about "Shakespeare in the Abbey 20230329". When the URL
  // contains a parseable year ≥2 off the show's year, penalise. Doesn't
  // help the short-titled cases (Pride/Man to Man/Six) — their bad URLs
  // don't contain years.
  if (showYear) {
    const urlYear = parseYearFromUrl(url);
    if (urlYear && Math.abs(urlYear - showYear) >= 2) score -= 4;
  }

  // Market-mismatch defense — catches West End shows landing on Broadway-
  // only pages (or vice versa). Latent defense; doesn't fire on any of the
  // 11 historical bad URLs in the parity fixtures but cheap and obvious.
  if (showCategory) {
    if (detectMarketMismatch(url, showCategory)) score -= 3;
  }

  return { score, url: result.url || result.link || '', title: result.title || '' };
}

// Minimum score for a SERP result to count as a cast-page candidate. Set so
// a single domain bonus + cast-path signal alone is enough (≥2), but any
// negative-scoring result from the title-token gate is filtered out.
const SERP_MIN_SCORE = 2;

// Minimum named cast members required to accept an LLM extraction as real
// data. Solo/one-person shows are a normal case in this catalogue ("Jeeves
// Takes Charge" — Sam Harrison playing every role solo, "We've Been Here
// Before: A One-Woman Musical") — requiring >=2 permanently starved every
// solo show of cast data: backfill-cast-web.js found the one legitimate
// actor, rejected the page for having "too few" cast members, exhausted
// its candidate URLs, and tombstoned the show as empty. Auto-remediation
// then retried the same broken threshold twice a day forever and gave up
// (BRO-504). enrich-cast-from-files.js already special-cases a 1-member
// cast (labels the role "Narrator"), so >=1 here is consistent with what
// downstream actually supports.
const MIN_CAST_SIZE = 1;

function isViableCastExtraction(cast) {
  return Array.isArray(cast) && cast.length >= MIN_CAST_SIZE;
}

/**
 * Validate LLM-extracted cast for the wrong-show / corrupted-role patterns.
 *
 * @param {Array<{name:string, role?:string}>} cast - LLM output
 * @param {string} showTitle - Target show title (used to exempt opera shows)
 * @returns {{ok:boolean, reasons:string[], cleaned:Array}}
 *   - ok=false → caller should reject this extraction and try the next URL
 *   - cleaned=array → with column-header roles stripped (safe to use even
 *     when ok=true; only column-header roles are mutated)
 */
function validateCastExtraction(cast, showTitle) {
  if (!Array.isArray(cast) || cast.length === 0) {
    return { ok: false, reasons: ['empty'], cleaned: [] };
  }

  const reasons = [];
  const titleLower = String(showTitle || '').toLowerCase();
  const showIsOpera = /\bopera\b|the met\b/.test(titleLower);

  if (!showIsOpera) {
    const operaHits = cast.filter(m =>
      m.role && OPERA_TITLES.some(o => m.role.toLowerCase().includes(o))
    );
    if (operaHits.length >= 2) reasons.push(`opera-role-contamination:${operaHits.length}`);
  }

  const tvHits = cast.filter(m =>
    m.role && TV_PATTERNS.some(t => m.role.toLowerCase().includes(t))
  );
  if (tvHits.length >= 2) reasons.push(`tv-role-contamination:${tvHits.length}`);

  const swapped = cast.filter(m => {
    if (!m.name) return false;
    const parts = m.name.split(/\s+/);
    return parts.length === 2 && KNOWN_SWAP_SURNAMES.has(parts[0].toLowerCase());
  });
  if (swapped.length >= 2) reasons.push(`name-swap-pattern:${swapped.length}`);

  // Safe-to-strip: column-header roles ("Original", "Standby") — drop the role
  // field, keep the name. The LLM grabbed a table column header instead of a
  // character name; the name itself is usually correct.
  const cleaned = cast.map(m => {
    if (m.role && COLUMN_HEADER_RE.test(m.role.trim())) {
      const { role, ...rest } = m;
      return rest;
    }
    return m;
  });

  return { ok: reasons.length === 0, reasons, cleaned };
}

module.exports = {
  validateCastExtraction,
  isOperaSourceUrl,
  scoreSerpResult,
  meaningfulTitleTokens,
  parseYearFromUrl,
  isViableCastExtraction,
  MIN_CAST_SIZE,
  detectMarketMismatch,
  SERP_MIN_SCORE,
  OPERA_TITLES,
  TV_PATTERNS,
  COLUMN_HEADER_RE,
  KNOWN_SWAP_SURNAMES,
  OPERA_SOURCE_DOMAINS,
  TITLE_STOPWORDS,
};
