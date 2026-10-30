import { client } from './client';

/**
 * Every server-side Sanity read goes through here (BRO-6659).
 *
 * 1. Dedupe: one request per (query, params) per process. generateStaticParams,
 *    generateMetadata and the page all ask for the same data, and every
 *    /show/[slug] prerender asked for the full review list, so a single build
 *    made hundreds of identical requests. That burned the plan's API request
 *    quota (plan_limit_reached) and then every deploy failed at
 *    "Failed to collect page data for /blog/[slug]".
 * 2. During `next build`, a Sanity error (quota, outage, missing token) logs
 *    and resolves to the caller's last-good fallback, so a CMS problem can no
 *    longer block production deploys. At runtime (ISR revalidation) the error
 *    is rethrown instead: Next then keeps serving the last good page, where a
 *    swallowed error would cache the degraded fallback (or a 404) as the page.
 *
 * Entries expire after MEMO_TTL_MS. That still collapses a build's hundreds
 * of identical reads to a handful per worker, while a warm ISR function
 * (which can live for hours) refetches on its next hourly revalidation instead
 * of serving its first answer, or a fallback from a brief outage, forever.
 */
const MEMO_TTL_MS = 5 * 60 * 1000;
const MEMO_MAX = 500;
const memo = new Map<string, { at: number; value: Promise<unknown> }>();

// Next sets this in the build process before it forks the static workers.
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

function pruneExpired(now: number) {
  for (const [k, v] of Array.from(memo.entries())) {
    if (now - v.at >= MEMO_TTL_MS) memo.delete(k);
  }
}

export function sanityFetch<T>(
  query: string,
  params: Record<string, string> = {},
  fallback: () => T | Promise<T>,
): Promise<T> {
  const key = JSON.stringify([query, params]);
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < MEMO_TTL_MS) return hit.value as Promise<T>;
  // Crawlers hitting unknown slugs would otherwise grow the map without bound.
  if (memo.size >= MEMO_MAX) pruneExpired(now);
  const value = client.fetch<T>(query, params).catch(async (err: unknown) => {
    if (!isBuildPhase()) {
      memo.delete(key); // never pin a runtime failure; the next request retries
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[sanity] fetch failed, using last-good fallback: ${msg.slice(0, 200)}`);
    try {
      return await fallback();
    } catch (fallbackErr) {
      memo.delete(key);
      throw fallbackErr;
    }
  });
  memo.set(key, { at: now, value });
  return value;
}
