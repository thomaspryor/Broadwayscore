import 'server-only';

/**
 * Read a JSON file from the PRIVATE core-data repo at request time.
 *
 * Admin dashboards (/admin/finances, /admin/traffic) keep their data in
 * thomaspryor/broadway-scorecard-data, never in this public repo or the
 * build. Reads go through the GitHub contents API with REVIEW_TEXTS_TOKEN
 * (set in Vercel). A missing file returns `fallback` (not created yet),
 * any other non-2xx throws.
 */
const GH_API_BASE = 'https://api.github.com';
export const PRIVATE_DATA_REPO = 'thomaspryor/broadway-scorecard-data';

export async function fetchPrivateJson<T>(path: string, token: string, fallback: T): Promise<T> {
  const res = await fetch(
    `${GH_API_BASE}/repos/${PRIVATE_DATA_REPO}/contents/${path}?ref=main`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
      },
      cache: 'no-store',
    },
  );
  if (res.status === 404) return fallback;
  if (!res.ok) throw new Error(`GitHub ${res.status} reading ${path}`);
  return (await res.json()) as T;
}
