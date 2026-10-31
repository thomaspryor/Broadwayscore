/**
 * Read one private share link through its SECURITY DEFINER function
 * (get_shared_plans, get_shared_diary). Shared by every link type so the
 * outcomes, the cache rule and the token check can't drift apart.
 *
 * Three outcomes the page must keep apart:
 *   ok           — render it
 *   not-shared   — unknown, stopped or reset link → the neutral 404 page
 *   unavailable  — the database (or its config) failed → a "try again" 503.
 *                  Never a 404: a blip must not look like the owner turned
 *                  sharing off.
 *
 * Reads are never cached: a share that was just stopped must stop showing.
 */

export type LoadShareResult<P> =
  | { status: 'ok'; payload: P }
  | { status: 'not-shared' }
  | { status: 'unavailable' };

/** Same format the database CHECKs; anything else can't be a real link. */
export const SHARE_TOKEN_RE = /^[a-f0-9]{32}$/;

/**
 * The token part of a link's path segment. Some share sheets paste the
 * message right after the link ("<token> My theater plans on Broadway
 * Scorecard"), and a browser keeps it as %20-joined path text. Everything
 * after the first space is dropped; the rest must still be a real token.
 */
export function shareTokenFromParam(param: string): string {
  let s = param;
  try {
    s = decodeURIComponent(param);
  } catch {
    // keep it raw: a bad escape just fails the format check below
  }
  return s.trim().split(/\s/)[0];
}

/** A fetch that opts out of Next's fetch/Data Cache. */
export const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: 'no-store' });

/** The slice of a Supabase client this module uses (injectable for tests). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export async function loadShareWith<P>(
  token: string,
  client: RpcClient | null,
  fn: string,
  isPayload: (v: unknown) => v is P,
): Promise<LoadShareResult<P>> {
  token = shareTokenFromParam(token);
  // Malformed tokens never touch the database.
  if (!SHARE_TOKEN_RE.test(token)) return { status: 'not-shared' };
  if (!client) return { status: 'unavailable' };
  try {
    // supabase-js calls RPCs with POST, so the token travels in the body and
    // never in a URL (the functions refuse GET: 20261002_plan_shares_refuse_get).
    const { data, error } = await client.rpc(fn, { p_token: token });
    if (error) return { status: 'unavailable' };
    if (data === null || data === undefined) return { status: 'not-shared' };
    if (!isPayload(data)) return { status: 'unavailable' };
    return { status: 'ok', payload: data };
  } catch {
    return { status: 'unavailable' };
  }
}
