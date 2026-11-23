// BRO-8056 phase 2: what one call to /api/show-refresh/revalidate may do. Pure,
// so tests drive it without Next. The route applies the plan.
import { createHash, timingSafeEqual } from 'crypto';

/** Per call; the publisher batches targets (plan 1.5), the kill switch lists every prerendered page. */
export const MAX_REVALIDATE_SLUGS = 1200;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type RevalidatePlan =
  | { ok: true; tag: boolean; paths: string[] }
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

export function planRevalidate(input: { configuredSecret?: string; givenSecret: string | null; body: unknown }): RevalidatePlan {
  const denied = revalidateAuth(input.configuredSecret, input.givenSecret);
  if (denied) return { ok: false, ...denied };
  const body = input.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, status: 400, error: 'body must be an object' };
  const { slugs = [], home = false, tag = false } = body as { slugs?: unknown; home?: unknown; tag?: unknown };
  if (!Array.isArray(slugs) || typeof home !== 'boolean' || typeof tag !== 'boolean') return { ok: false, status: 400, error: 'bad fields' };
  if (slugs.length > MAX_REVALIDATE_SLUGS) return { ok: false, status: 400, error: `at most ${MAX_REVALIDATE_SLUGS} slugs` };
  const bad = slugs.find(s => typeof s !== 'string' || !SLUG.test(s) || s.length > 200);
  if (bad !== undefined) return { ok: false, status: 400, error: 'bad slug' };
  const unique = [...new Set(slugs as string[])];
  if (!unique.length && !home && !tag) return { ok: false, status: 400, error: 'nothing to revalidate' };
  const paths = unique.flatMap(s => [`/show/${s}`, `/show/${s}/reviews.json`]);
  if (home) paths.push('/');
  return { ok: true, tag, paths };
}
