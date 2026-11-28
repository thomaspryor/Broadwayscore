// BRO-8170 gap 3: the "more reviews" rows (/show/<slug>/reviews.json) must come
// from the same data as the five rows embedded in the page. The page and
// reviews.json are separate ISR entries: after a publish or kill one can be
// regenerated before the other, so for a while they can hold different
// revisions. A mixed list could repeat or drop a review and disagree with the
// score above it.
//
// While the show-refresh reader is on, the page passes its own marker as
// `expectedRev` and reviews.json answers with the x-show-refresh-hash header.
// A mismatch is retried once after a pause, bypassing the browser cache (the
// first stale hit has started the CDN's background regeneration). Still
// mismatched => 'mismatch' carrying the retry's rows as latestRows. The caller
// decides: a background prefetch drops them (the list keeps only the inline
// rows); an explicit click uses them (BRO-8176: a tab left open past a publish
// must not get a Show more button that never loads, and the owner chose no note).
// With no expectedRev (reader off: the page never passes one) the response is
// used as before, header unchecked. Client-safe: no server imports.
import { SHOW_REFRESH_REV_HEADER, isRefreshedRev } from './show-refresh-core';

export type MoreRowsResult<T> = { state: 'ok'; rows: T[] } | { state: 'mismatch'; latestRows: T[] } | { state: 'error'; error: string };

/**
 * Same data? 'base' and 'base-error' both mean the build's data, and an absent
 * header (reader off when that response was made) does too. Two slice hashes
 * must be equal.
 */
export function sameRenderData(pageRev: string, responseRev: string | null): boolean {
  const norm = (r: string | null) => (isRefreshedRev(r) ? r : 'base');
  return norm(pageRev) === norm(responseRev);
}

export const MORE_RETRY_DELAY_MS = 2000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'json'>>;

export async function fetchMoreRows<T>(
  url: string,
  expectedRev: string | undefined,
  deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MoreRowsResult<T>> {
  const doFetch: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  try {
    const first = await doFetch(url);
    if (!first.ok) throw new Error(`${url} HTTP ${first.status}`);
    if (expectedRev === undefined || sameRenderData(expectedRev, first.headers.get(SHOW_REFRESH_REV_HEADER))) {
      return { state: 'ok', rows: (await first.json()) as T[] };
    }
    await sleep(MORE_RETRY_DELAY_MS);
    const again = await doFetch(url, { cache: 'no-store' });
    if (!again.ok) throw new Error(`${url} HTTP ${again.status}`);
    if (sameRenderData(expectedRev, again.headers.get(SHOW_REFRESH_REV_HEADER))) {
      return { state: 'ok', rows: (await again.json()) as T[] };
    }
    return { state: 'mismatch', latestRows: (await again.json()) as T[] };
  } catch (e) {
    return { state: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}
