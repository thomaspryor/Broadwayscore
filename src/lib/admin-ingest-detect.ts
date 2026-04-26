import 'server-only';
import fs from 'fs';
import path from 'path';

// ─── Types ──────────────────────────────────────────────────────────

interface OutletRegistry {
  outlets: Record<string, {
    displayName: string;
    domain?: string;
    domainAliases?: string[];
    defaultCritic?: string;
  }>;
}

interface ShowsJson {
  shows: Array<{
    id: string;
    title: string;
    slug?: string;
    category?: string;
    status?: string;
    openingDate?: string | null;
    previewsStartDate?: string | null;
    closingDate?: string | null;
  }>;
}

export interface DetectionResult {
  outletId: string | null;
  outletDisplayName: string | null;
  criticName: string | null;
  criticSource: 'byline-regex' | 'outlet-default' | 'none' | null;
  publishDate: string | null;
  publishDateSource: 'url-path' | 'none' | null;
  showId: string | null;
  showTitle: string | null;
  showConfidence: 'high' | 'medium' | 'low' | null;
  showCandidates: Array<{ id: string; title: string; openingDate: string | null }>;
  warnings: string[];
}

// ─── Caches (module-scoped; cold-reset on server restart) ────────────

let _outletRegistry: OutletRegistry | null = null;
let _outletDomainMap: Record<string, string> | null = null;
let _shows: ShowsJson['shows'] | null = null;

function loadOutletRegistry(): OutletRegistry {
  if (_outletRegistry) return _outletRegistry;
  const p = path.join(process.cwd(), 'data', 'outlet-registry.json');
  _outletRegistry = JSON.parse(fs.readFileSync(p, 'utf-8')) as OutletRegistry;
  return _outletRegistry;
}

function buildOutletDomainMap(): Record<string, string> {
  if (_outletDomainMap) return _outletDomainMap;
  const registry = loadOutletRegistry();
  const collect: Record<string, Set<string>> = {};
  for (const [id, o] of Object.entries(registry.outlets || {})) {
    const domains: string[] = [];
    if (o.domain) domains.push(String(o.domain).toLowerCase());
    if (Array.isArray(o.domainAliases)) o.domainAliases.forEach((d) => domains.push(String(d).toLowerCase()));
    for (const d of domains) (collect[d] ||= new Set()).add(id);
  }
  const map: Record<string, string> = {};
  for (const [domain, ids] of Object.entries(collect)) {
    if (ids.size === 1) map[domain] = Array.from(ids)[0];
  }
  _outletDomainMap = map;
  return map;
}

function loadShows(): ShowsJson['shows'] {
  if (_shows) return _shows;
  const p = path.join(process.cwd(), 'data', 'shows.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as ShowsJson;
  _shows = data.shows || [];
  return _shows;
}

// ─── Individual detectors ───────────────────────────────────────────

export function detectOutlet(url: string): { outletId: string | null; displayName: string | null } {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return { outletId: null, displayName: null };
  }
  const map = buildOutletDomainMap();
  const outletId = map[hostname] ?? null;
  if (outletId) {
    const registry = loadOutletRegistry();
    return { outletId, displayName: registry.outlets[outletId]?.displayName ?? outletId };
  }

  // Fallback: multi-tenant publishing platforms where every subdomain is a
  // distinct publication. We can't pre-register every Substack/Ghost newsletter,
  // but the subdomain itself is a stable, unique identifier.
  const platformMatch = hostname.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.(substack\.com|ghost\.io|beehiiv\.com)$/i);
  if (platformMatch) {
    const sub = platformMatch[1].toLowerCase();
    const platform = platformMatch[2].toLowerCase();
    const platformLabel = platform === 'substack.com' ? 'Substack' : platform === 'ghost.io' ? 'Ghost' : 'Beehiiv';
    return {
      outletId: sub,
      displayName: `${titleCaseSlug(sub)} (${platformLabel})`,
    };
  }

  return { outletId: null, displayName: null };
}

function titleCaseSlug(slug: string): string {
  // "offbookcincinnati" → "Offbookcincinnati"; "off-book-cincinnati" → "Off Book Cincinnati"
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function detectPublishDateFromUrl(url: string): string | null {
  // Matches /YYYY/MM/DD/ in URL path — covers nytimes, variety, washingtonpost,
  // theatermania, most T1/T2 outlets. Not all (vulture uses slugs without dates).
  const m = url.match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})\//);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = mo.padStart(2, '0');
  const day = d.padStart(2, '0');
  const iso = `${y}-${month}-${day}`;
  // Sanity: is this a plausible publishDate (within 2 years past, 1 week future)?
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const now = Date.now();
  const twoYearsAgo = now - 2 * 365 * 86400000;
  const oneWeekFuture = now + 7 * 86400000;
  if (ts < twoYearsAgo || ts > oneWeekFuture) return null;
  return iso;
}

export function detectCriticFromByline(fullText: string): string | null {
  // Scan BOTH the head (first 3000) AND the tail (last 2000). Major outlets
  // (NYT, Variety, Guardian) put bylines at the top; theater blogs (Queer
  // Review, Talkin' Broadway, theater-specific Substacks) put "By Name" at
  // the BOTTOM. Tail scan was added 2026-04-25 after Queer Review's James
  // Kleinmann byline at position ~14,500 was missed.
  const head = fullText.slice(0, 3000);
  const tail = fullText.slice(-2000);
  // Avoid double-scanning when the review is short.
  const segments = fullText.length <= 5000 ? [head] : [head, tail];

  // Pattern 1: "By Helen Shaw" — accepts byline at line start, after a
  // sentence-ending punctuation, or after a dash separator. The 'By' itself
  // must follow whitespace or punctuation (not appear inside a word like "Bypass").
  const p1 = /(?:^|\n|[.!?]\s+|—\s*|–\s*)\s*(?:By|BY)\s+([A-Z][a-zA-Z.'’\-]+(?:\s+[A-Z][a-zA-Z.'’\-]+){1,3})(?=\s*(?:\n|[,.]|$))/m;

  // Pattern 2: "— Helen Shaw" (em-dash byline, e.g., NYT print bylines)
  const p2 = /(?:^|\n)\s*[—–-]\s*([A-Z][a-zA-Z.'’\-]+(?:\s+[A-Z][a-zA-Z.'’\-]+){1,3})\s*(?:\n|$)/m;

  // Pattern 3: "Posted by JK at 9:44 PM" — Blogger.com convention. JKS
  // Theatre Scene and many other Blogger blogs use this. Allows 1-word
  // names because the surrounding context ("Posted by ... at TIME") is
  // distinctive enough that single names like "JK" are reliably bylines.
  const p3 = /(?:^|\n|\s)Posted\s+by\s+([A-Z][a-zA-Z.'’\-]+(?:\s+[A-Z][a-zA-Z.'’\-]+){0,3})\s+(?:at|on|@)\b/;

  // Pattern 4: "Reviewed by Helen Shaw" / "Review by Helen Shaw"
  const p4 = /(?:^|\n|\s)(?:Reviewed|Review|Written|Authored)\s+by\s+([A-Z][a-zA-Z.'’\-]+(?:\s+[A-Z][a-zA-Z.'’\-]+){1,3})(?=\s*(?:\n|[,.]|$))/m;

  // Pattern 5: "By: Helen Shaw" (with colon — alt format)
  const p5 = /(?:^|\n)\s*(?:By|BY)\s*[:|]\s*([A-Z][a-zA-Z.'’\-]+(?:\s+[A-Z][a-zA-Z.'’\-]+){1,3})(?=\s*(?:\n|[,.]|$))/m;

  for (const segment of segments) {
    for (const pat of [p1, p2, p3, p4, p5]) {
      const m = segment.match(pat);
      if (m) {
        const candidate = m[1].trim();
        // Pattern 3 (Posted by) allows 1-word names; others require 2+
        const allowSingleWord = pat === p3;
        if (isPlausibleCriticName(candidate, { allowSingleWord })) return candidate;
      }
    }
  }

  return null;
}

// Re-export score parser (lives in admin-ingest-score.ts so client components
// can import it without dragging in 'server-only').
export { parseScore } from './admin-ingest-score';
export type { ScoreParseResult } from './admin-ingest-score';

function isPlausibleCriticName(name: string, opts: { allowSingleWord?: boolean } = {}): boolean {
  // Reject obvious non-names (common false positives).
  const NEG = /\b(Broadway|Theater|Theatre|Review|Critic|Opening|The New York|Signed|The Critics?|Rocky Horror|Beaches)\b/i;
  if (NEG.test(name)) return false;
  // Word count: 2-4 normally, 1-4 when caller has high-confidence context.
  const words = name.split(/\s+/);
  const minWords = opts.allowSingleWord ? 1 : 2;
  if (words.length < minWords || words.length > 4) return false;
  // Each word should be capitalized + mostly alphabetic.
  for (const w of words) {
    if (!/^[A-Z]/.test(w)) return false;
    if (w.length > 25) return false;
  }
  return true;
}

export function detectShow(
  fullText: string,
  url: string,
): {
  showId: string | null;
  showTitle: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  candidates: Array<{ id: string; title: string; openingDate: string | null }>;
} {
  const shows = loadShows();

  // Candidate pool: open + recently-closed Broadway/West End shows (3-year window).
  // Filters out 700+ historical closed shows that'll never be subjects of new reviews.
  const cutoff = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
  const poolShows = shows.filter((s) => {
    const cat = (s.category || '').toLowerCase();
    if (cat && cat !== 'broadway' && cat !== 'west-end') return false;
    if (s.status === 'closed') {
      if (!s.closingDate || s.closingDate < cutoff) return false;
    }
    return true;
  });

  // ─── URL-slug match (HIGH PRIORITY) ───────────────────────────────
  // Walk EVERY path segment of the URL. The review's URL is the most reliable
  // signal of which show it's about — slug matches in the URL beat text
  // substring matches every time. Without this, critics who mention OTHER
  // recent productions (Outsiders, Home, Purpose) in passing get
  // misattributed (caught 2026-04-26 opening night — 6 of 9 batch reviews
  // attributed to wrong shows).
  const urlSegments = extractAllUrlSegments(url);
  for (const segment of urlSegments) {
    // Normalize segment to a slug-like form: lowercase, replace _ with -,
    // collapse non-alphanumerics to single hyphens.
    const segNorm = segment
      .toLowerCase()
      .replace(/_/g, '-')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (segNorm.length < 5) continue; // Skip tiny segments like IDs

    for (const show of poolShows) {
      const titleSlug = show.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      if (titleSlug.length < 5) continue;
      // Match in either direction: segment contains slug, OR slug contains segment
      // (the show's slug might be longer than the URL slug — e.g., "Joe Turner's Come and Gone"
      // → "joe-turner-s-come-and-gone" vs URL "Joe-Turners-Come-and-Gone" → "joe-turners-come-and-gone")
      const segHasSlug = segNorm.includes(titleSlug);
      const slugHasSeg = titleSlug.includes(segNorm);
      // Also try a "loose" comparison that ignores possessive 's: "joe-turner-s" vs "joe-turners"
      const titleSlugLoose = titleSlug.replace(/-s-/g, 's-').replace(/-s$/, 's');
      const segNormLoose = segNorm.replace(/-s-/g, 's-').replace(/-s$/, 's');
      const looseMatch = segNormLoose.includes(titleSlugLoose) || titleSlugLoose.includes(segNormLoose);
      if (segHasSlug || slugHasSeg || looseMatch) {
        return {
          showId: show.id,
          showTitle: show.title,
          confidence: 'high',
          candidates: [{ id: show.id, title: show.title, openingDate: show.openingDate ?? null }],
        };
      }
    }
  }

  // ─── Text substring fallback (LOW PRIORITY) ───────────────────────
  // Scan first 4000 chars of review text — show title usually appears here.
  // BUT only use this when URL slug match returned nothing, because critics
  // mention many other shows in passing and substring count is unreliable.
  const head = fullText.slice(0, 4000);
  const headLower = head.toLowerCase();

  const matches: Array<{ show: ShowsJson['shows'][number]; hits: number; firstIdx: number }> = [];
  for (const show of poolShows) {
    const titleNorm = show.title.toLowerCase();
    if (titleNorm.length < 3) continue; // Ignore one-word titles shorter than 3 chars
    // Escape regex special chars in title
    const escaped = titleNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'g');
    const hits = (headLower.match(pattern) || []).length;
    if (hits > 0) {
      matches.push({ show, hits, firstIdx: headLower.indexOf(titleNorm) });
    }
  }

  if (matches.length === 0) {
    return { showId: null, showTitle: null, confidence: null, candidates: [] };
  }

  // Rank: (hits desc, then firstIdx asc, then longer title wins — "Beaches" vs "Beaches 2026")
  matches.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    if (a.firstIdx !== b.firstIdx) return a.firstIdx - b.firstIdx;
    return b.show.title.length - a.show.title.length;
  });

  const top = matches[0];
  const runnerUp = matches[1];

  // Confidence rules — text-only matches are inherently shaky because critics
  // mention other shows in their reviews. Demand a HUGE margin for high
  // confidence; otherwise return medium and surface candidates so the
  // operator can verify or pick a different one.
  const isClearWinner = !runnerUp || top.hits >= runnerUp.hits * 3 || top.hits - runnerUp.hits >= 5;

  const candidates = matches.slice(0, 5).map((m) => ({
    id: m.show.id,
    title: m.show.title,
    openingDate: m.show.openingDate ?? null,
  }));

  return {
    showId: top.show.id,
    showTitle: top.show.title,
    // Text-substring matches are MEDIUM at best — too easy to false-positive
    // on critics who reference other recent shows.
    confidence: isClearWinner ? 'medium' : 'low',
    candidates,
  };
}

function extractAllUrlSegments(url: string): string[] {
  try {
    const u = new URL(url);
    return u.pathname
      .split('/')
      .filter(Boolean)
      .map(s => s.replace(/\.[a-z]+$/i, '').replace(/-review$/i, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Combined detector ──────────────────────────────────────────────

export function detectFromReview(opts: { url: string; fullText: string }): DetectionResult {
  const { url, fullText } = opts;
  const warnings: string[] = [];

  const outlet = detectOutlet(url);
  if (!outlet.outletId) {
    try {
      const hostname = new URL(url).hostname;
      warnings.push(`Unregistered outlet domain: ${hostname}`);
    } catch {
      warnings.push('URL could not be parsed');
    }
  }

  const publishDate = detectPublishDateFromUrl(url);
  if (!publishDate) warnings.push('Publish date not found in URL path; set manually if needed');

  // defaultCritic from the registry is the authority for single-author outlets
  // (306 entries set it). When the registry has it, it wins over byline detection
  // — keeps reviews from this outlet writing to a consistent filename.
  let criticName: string | null = null;
  let criticSource: 'byline-regex' | 'outlet-default' | 'none' = 'none';
  if (outlet.outletId) {
    const registry = loadOutletRegistry();
    const def = registry.outlets[outlet.outletId]?.defaultCritic;
    if (def) {
      criticName = def;
      criticSource = 'outlet-default';
    }
  }
  if (!criticName) {
    const byline = detectCriticFromByline(fullText);
    if (byline) {
      criticName = byline;
      criticSource = 'byline-regex';
    }
  }
  if (!criticName) warnings.push('No byline detected and no defaultCritic for this outlet; set critic manually');

  const show = detectShow(fullText, url);
  if (!show.showId) {
    warnings.push('No show match found; set showId manually');
  } else if (show.confidence === 'medium' && show.candidates.length > 1) {
    warnings.push(`Show match ambiguous (${show.candidates.length} candidates); verify selection`);
  }

  return {
    outletId: outlet.outletId,
    outletDisplayName: outlet.displayName,
    criticName,
    criticSource,
    publishDate,
    publishDateSource: publishDate ? 'url-path' : 'none',
    showId: show.showId,
    showTitle: show.showTitle,
    showConfidence: show.confidence,
    showCandidates: show.candidates,
    warnings,
  };
}
