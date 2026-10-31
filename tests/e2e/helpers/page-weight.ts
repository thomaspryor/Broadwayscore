/**
 * Shared page-weight measurement for E2E budget tests (card #961).
 *
 * Card #419 found /show/hamilton shipping a 789KB document, 645KB of it an
 * inlined RSC flight payload carrying 21 other shows' review corpora — and
 * the only signal that anything was wrong was a weekly Lighthouse lab score
 * oscillating 64-81. This gives every route a real, byte-level assertion
 * instead.
 *
 * The flight payload is emitted as `self.__next_f.push([1,"...escaped
 * JSON..."])` chunks (same extraction as the foreign-showId regression guard
 * in show-pages.spec.ts) — summing those chunks' bytes isolates exactly the
 * part of the document that crossed a 'use client' boundary and got
 * serialized, as opposed to markup/CSS/other inline script.
 */
// Exported so callers (show-pages.spec.ts's foreign-showId guard included)
// extract flight chunks the same way — two copies of this regex drifting
// apart on a Next.js encoding change is exactly how a guard goes vacuous.
export const FLIGHT_CHUNK_RE = /self\.__next_f\.push\(\[1,"(?:[^"\\]|\\.)*"\]\)/g;

export interface PageWeight {
  documentBytes: number;
  rscBytes: number;
}

export function measurePageWeight(html: string): PageWeight {
  const documentBytes = Buffer.byteLength(html, 'utf8');
  const flight = (html.match(FLIGHT_CHUNK_RE) || []).join('');
  const rscBytes = Buffer.byteLength(flight, 'utf8');
  return { documentBytes, rscBytes };
}

// ANTI-VACUITY. Without this, the budget assertions below pass for free the
// moment Next.js changes its flight-chunk syntax/escaping: FLIGHT_CHUNK_RE
// stops matching, rscBytes is 0, and a ceiling that can no longer fail
// silently reports green forever. This is the same vacuous-guard shape that
// shipped three times in this repo (#766, #782, #793) and the exact failure
// mode the foreign-showId guard in show-pages.spec.ts already protects
// against — so this must be able to SEE the payload before asserting a
// budget on it.
export function noFlightPayloadDetectedMessage(route: string): string {
  return (
    `Could not find any self.__next_f.push(...) flight chunks for ${route}. ` +
    `Either the page genuinely inlines no RSC payload (unlikely for a data ` +
    `page) or Next.js changed its flight-chunk encoding and FLIGHT_CHUNK_RE ` +
    `needs updating. Until then the rscBytes budget below proves nothing.`
  );
}

export function overBudgetMessage(
  route: string,
  field: 'documentBytes' | 'rscBytes',
  measured: number,
  budget: number,
): string {
  const label = field === 'documentBytes' ? 'document' : 'inlined RSC payload';
  return (
    `${route} ${label} is ${measured.toLocaleString()} bytes, over budget of ` +
    `${budget.toLocaleString()}. If this is a real content increase, ` +
    `re-derive the budget (see the comment above PAGE_WEIGHT_BUDGETS) rather ` +
    `than deleting the assertion — that's the RSC-bloat class from #419/#962.`
  );
}

// Distinct show slugs in the flight payload. Listing routes (/, /west-end,
// /off-broadway) serialize one record per show in their market, so their
// bytes grow with the catalog; counting slugs lets a budget scale with that
// growth while still catching per-show bloat (#419's shape: bytes per show
// jumping because foreign review corpora rode along).
const FLIGHT_SLUG_RE = /\\"slug\\":\\"([a-z0-9-]+)\\"/g;

export function countFlightSlugs(html: string): number {
  const flight = (html.match(FLIGHT_CHUNK_RE) || []).join('');
  return new Set(Array.from(flight.matchAll(FLIGHT_SLUG_RE), (m) => m[1])).size;
}

// Past this much catalog growth the budget stops scaling and the test fails,
// asking for a re-derivation: +50% shows on one page is worth a look even if
// every per-show byte is honest.
export const MAX_CATALOG_SCALE = 1.5;

export interface CatalogBudget extends PageWeight {
  // distinct flight slugs on the route when its bytes were measured; omit for
  // fixed-content pages, whose budget is then never scaled
  baselineItems?: number;
}

export interface ScaledBudget extends PageWeight {
  scale: number;
  // set when the catalog outgrew MAX_CATALOG_SCALE
  outgrown: string | null;
}

export function scaleBudgetForCatalog(route: string, budget: CatalogBudget, items: number): ScaledBudget {
  if (!budget.baselineItems) {
    return { documentBytes: budget.documentBytes, rscBytes: budget.rscBytes, scale: 1, outgrown: null };
  }
  const ratio = items / budget.baselineItems;
  const scale = Math.min(Math.max(1, ratio), MAX_CATALOG_SCALE);
  const outgrown =
    ratio > MAX_CATALOG_SCALE
      ? `${route} now lists ${items} shows vs a baseline of ${budget.baselineItems} ` +
        `(x${ratio.toFixed(2)} > x${MAX_CATALOG_SCALE}). Re-measure production and re-derive ` +
        `its PAGE_WEIGHT_BUDGETS entry (bytes and baselineItems).`
      : null;
  return {
    documentBytes: Math.round(budget.documentBytes * scale),
    rscBytes: Math.round(budget.rscBytes * scale),
    scale,
    outgrown,
  };
}
