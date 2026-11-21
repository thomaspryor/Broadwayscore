/**
 * Inter for @vercel/og images (newsletter badges, link-preview cards).
 *
 * @vercel/og inherits nothing from the page: with no `fonts` option it silently
 * renders in its bundled Noto Sans, which is how the newsletter score badge
 * changed typeface unnoticed (2026-09-20) and how the Shared Plans preview card
 * came out off-brand (owner, 2026-10-02). Moved here from
 * src/app/api/newsletter-badge/route.tsx so every generated image loads Inter
 * the same way. Works on both the edge and Node runtimes (plain fetch).
 *
 * WOFF, not WOFF2 — satori, which @vercel/og renders through, cannot parse
 * WOFF2 (the site's own self-hosted Inter is WOFF2, so it can't be reused).
 * Pinned to an exact @fontsource version so a CDN "latest" republish can never
 * silently change a typeface.
 */
export type InterWeight = 400 | 600 | 700 | 800;
export type InterFont = { name: 'Inter'; data: ArrayBuffer; weight: InterWeight; style: 'normal' };

const INTER_URL: Record<InterWeight, string> = {
  400: 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.16/files/inter-latin-400-normal.woff',
  600: 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.16/files/inter-latin-600-normal.woff',
  700: 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.16/files/inter-latin-700-normal.woff',
  800: 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.16/files/inter-latin-800-normal.woff',
};

// Hard ceiling on the CDN fetch. Without it a HANGING (as opposed to
// failing) jsdelivr blocks the image until the platform's own limit, and
// because the pending promise is module-cached every concurrent request in
// that isolate hangs with it (QA review, 2026-09-20).
const FONT_FETCH_TIMEOUT_MS = 1500;

// Module scope, per weight set: an isolate reuses this across invocations, so
// a warm instance pays the fetch once. Never rejects — a font-CDN blip must
// degrade to the default-font render, never 500 an image.
const cache = new Map<string, Promise<InterFont[]>>();

export function loadInter(weights: readonly InterWeight[]): Promise<InterFont[]> {
  const key = [...weights].sort().join(',');
  let promise = cache.get(key);
  if (!promise) {
    promise = Promise.all(
      weights.map(weight =>
        fetch(INTER_URL[weight], { signal: AbortSignal.timeout(FONT_FETCH_TIMEOUT_MS) })
          .then(r => (r.ok ? r.arrayBuffer() : null))
          .then((data): InterFont | null => (data ? { name: 'Inter', data, weight, style: 'normal' } : null))
          .catch(() => null),
      ),
    ).then(fonts => {
      const loaded = fonts.filter((f): f is InterFont => f !== null);
      // Cache only a COMPLETE load. Caching a partial load makes satori
      // synthesize the missing weight from the one it has — exactly the
      // weight drift this exists to prevent — with no retry (QA review,
      // 2026-09-20). Anything less: clear, so the next request retries.
      if (loaded.length !== weights.length) cache.delete(key);
      return loaded;
    });
    cache.set(key, promise);
  }
  return promise;
}

/**
 * Spread into ImageResponse's options: `{ ...size, ...(await interFontOption([700])) }`.
 * Register every weight the image uses — a missing one gets synthesized.
 * Set `fontFamily: 'Inter'` on the root element.
 */
export async function interFontOption(weights: readonly InterWeight[]): Promise<{ fonts?: InterFont[] }> {
  const fonts = await loadInter(weights);
  if (fonts.length === 0) return {};
  return { fonts };
}
