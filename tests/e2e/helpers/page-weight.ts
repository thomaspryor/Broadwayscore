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
