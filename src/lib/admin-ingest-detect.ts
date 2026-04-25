import 'server-only';
import fs from 'fs';
import path from 'path';

// ─── Types ──────────────────────────────────────────────────────────

interface OutletRegistry {
  outlets: Record<string, {
    displayName: string;
    domain?: string;
    domainAliases?: string[];
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
  criticSource: 'byline-regex' | 'none' | null;
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
  if (!outletId) return { outletId: null, displayName: null };
  const registry = loadOutletRegistry();
  return { outletId, displayName: registry.outlets[outletId]?.displayName ?? outletId };
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

  for (const segment of segments) {
    const m1 = segment.match(p1);
    if (m1) {
      const candidate = m1[1].trim();
      if (isPlausibleCriticName(candidate)) return candidate;
    }
    const m2 = segment.match(p2);
    if (m2) {
      const candidate = m2[1].trim();
      if (isPlausibleCriticName(candidate)) return candidate;
    }
  }

  return null;
}

// Re-export score parser (lives in admin-ingest-score.ts so client components
// can import it without dragging in 'server-only').
export { parseScore } from './admin-ingest-score';
export type { ScoreParseResult } from './admin-ingest-score';

function isPlausibleCriticName(name: string): boolean {
  // Reject obvious non-names (common false positives).
  const NEG = /\b(Broadway|Theater|Theatre|Review|Critic|Opening|The New York|Signed|The Critics?|Rocky Horror|Beaches)\b/i;
  if (NEG.test(name)) return false;
  // Must have 2-4 space-separated words.
  const words = name.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
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

  // Scan first 4000 chars of review text — show title usually appears here.
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
    // Fallback: try URL slug matching.
    const urlSlug = extractUrlSlug(url);
    if (urlSlug) {
      const slugLower = urlSlug.toLowerCase().replace(/-/g, ' ');
      for (const show of poolShows) {
        const titleNorm = show.title.toLowerCase();
        if (slugLower.includes(titleNorm)) {
          return {
            showId: show.id,
            showTitle: show.title,
            confidence: 'medium',
            candidates: [{ id: show.id, title: show.title, openingDate: show.openingDate ?? null }],
          };
        }
      }
    }
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

  // High confidence: clear winner (2x hits OR only match)
  const isClearWinner = !runnerUp || top.hits >= runnerUp.hits * 2 || top.hits - runnerUp.hits >= 3;

  const candidates = matches.slice(0, 5).map((m) => ({
    id: m.show.id,
    title: m.show.title,
    openingDate: m.show.openingDate ?? null,
  }));

  return {
    showId: top.show.id,
    showTitle: top.show.title,
    confidence: isClearWinner ? 'high' : 'medium',
    candidates,
  };
}

function extractUrlSlug(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    // Last path segment, stripped of extension
    const last = parts[parts.length - 1] || '';
    return last.replace(/\.[a-z]+$/i, '').replace(/-review$/i, '') || null;
  } catch {
    return null;
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

  const criticName = detectCriticFromByline(fullText);
  if (!criticName) warnings.push('No byline detected in first 3000 chars; set critic manually');

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
    criticSource: criticName ? 'byline-regex' : 'none',
    publishDate,
    publishDateSource: publishDate ? 'url-path' : 'none',
    showId: show.showId,
    showTitle: show.showTitle,
    showConfidence: show.confidence,
    showCandidates: show.candidates,
    warnings,
  };
}
