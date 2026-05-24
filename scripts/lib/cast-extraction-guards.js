// Sanity checks for LLM-extracted cast data. Catches the contamination
// patterns seen in 12+ historical bad cast files (Met Opera singers as
// Kavalier-and-Clay cast, TV-show titles as Much-Ado roles, LASTNAME-FIRSTNAME
// names from BWW alphabetical listings). Used by:
//   - scripts/backfill-cast-web.js (pre-write gate)
//   - scripts/audit-cast-contamination.js (post-hoc sweep)
//
// If you extend the patterns here, also extend the audit script's signal list.

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
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !TITLE_STOPWORDS.has(t));
}

// Pure score for a single SERP result against a show title. Higher = more
// likely the right show's cast page. Caller filters by SERP_MIN_SCORE.
function scoreSerpResult(result, showTitle) {
  const url = (result.url || result.link || '').toLowerCase();
  const t = (result.title || '').toLowerCase();
  const titleLower = String(showTitle || '').toLowerCase().split(':')[0].trim();
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

  return { score, url: result.url || result.link || '', title: result.title || '' };
}

// Minimum score for a SERP result to count as a cast-page candidate. Set so
// a single domain bonus + cast-path signal alone is enough (≥2), but any
// negative-scoring result from the title-token gate is filtered out.
const SERP_MIN_SCORE = 2;

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
  SERP_MIN_SCORE,
  OPERA_TITLES,
  TV_PATTERNS,
  COLUMN_HEADER_RE,
  KNOWN_SWAP_SURNAMES,
  OPERA_SOURCE_DOMAINS,
  TITLE_STOPWORDS,
};
