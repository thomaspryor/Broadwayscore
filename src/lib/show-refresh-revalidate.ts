// BRO-8056 phase 2: what one call to /api/show-refresh/revalidate may do. Pure,
// so tests drive it without Next. The route applies the plan.
import { createHash, timingSafeEqual } from 'crypto';

/** Per call; the publisher batches targets (plan 1.5), the kill switch lists every prerendered page. */
export const MAX_REVALIDATE_SLUGS = 1200;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every cached surface of one show that reads getShowForRender (gap 6: the OG
 * image too). A path missing here keeps serving the old data after a publish
 * or a kill until its own ISR expiry. tests/unit/show-refresh-revalidate.test.ts
 * checks this list against the route files under src/app/show/[slug]/.
 */
export function showSurfacePaths(slug: string): string[] {
  return [`/show/${slug}`, `/show/${slug}/reviews.json`, `/show/${slug}/opengraph-image`];
}

/**
 * Every call also drops the kill/home pointer cache (pointerTag): a page this
 * call re-renders must read the current pointers, not ones cached before the
 * publish or kill that caused the call. `tag` drops every cached store read,
 * slices included (the kill switch). `all` expands to every show this
 * deployment could have refreshed (prerendered and not held at build).
 */
export type RevalidatePlan =
  | { ok: true; tag: boolean; pointerTag: true; paths: string[]; refreshable?: number }
  | { ok: false; status: number; error: string };

function sameSecret(a: string, b: string): boolean {
  // Compare fixed-length digests so a length difference leaks nothing.
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** The secret check alone, run before the route reads the body. null = authorised. */
export function revalidateAuth(configuredSecret: string | undefined, givenSecret: string | null): { status: number; error: string } | null {
  const secret = configuredSecret ?? '';
  // Unset or short secret: the route does not exist yet.
  if (secret.length < 32) return { status: 404, error: 'not found' };
  if (!givenSecret || !sameSecret(givenSecret, secret)) return { status: 401, error: 'unauthorized' };
  return null;
}

export function planRevalidate(input: {
  configuredSecret?: string; givenSecret: string | null; body: unknown;
  /** Slugs `all` expands to (the build manifest's non-held shows); null when the deployment has no manifest. */
  refreshableSlugs?: () => string[] | null;
}): RevalidatePlan {
  const denied = revalidateAuth(input.configuredSecret, input.givenSecret);
  if (denied) return { ok: false, ...denied };
  const body = input.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, status: 400, error: 'body must be an object' };
  const { slugs = [], home = false, tag = false, all = false } = body as { slugs?: unknown; home?: unknown; tag?: unknown; all?: unknown };
  if (!Array.isArray(slugs) || typeof home !== 'boolean' || typeof tag !== 'boolean' || typeof all !== 'boolean') return { ok: false, status: 400, error: 'bad fields' };
  if (slugs.length > MAX_REVALIDATE_SLUGS) return { ok: false, status: 400, error: `at most ${MAX_REVALIDATE_SLUGS} slugs` };
  const bad = slugs.find(s => typeof s !== 'string' || !SLUG.test(s) || s.length > 200);
  if (bad !== undefined) return { ok: false, status: 400, error: 'bad slug' };
  let expanded: string[] = [];
  if (all) {
    const listed = input.refreshableSlugs?.() ?? null;
    // No manifest: this deployment never refreshed a page, but the caller asked
    // for a full sweep, so say so instead of reporting a silent success.
    if (!listed) return { ok: false, status: 503, error: 'no build manifest in this deployment' };
    expanded = listed.filter(s => typeof s === 'string' && SLUG.test(s));
  }
  const unique = [...new Set([...(slugs as string[]), ...expanded])];
  if (!unique.length && !home && !tag && !all) return { ok: false, status: 400, error: 'nothing to revalidate' };
  const paths = unique.flatMap(showSurfacePaths);
  if (home) paths.push('/');
  return { ok: true, tag, pointerTag: true, paths, ...(all ? { refreshable: expanded.length } : {}) };
}
