// Live user-added shows (user_show_stubs). No fs, so both the server
// (diary-show.ts, shared links) and My Shows in the browser use it.
import type { DiaryShowDetail } from './diary-show-types';

// Card 174 stub id pattern: <slug>-<category>-mz<mezzProdId> — only ids
// shaped like this are worth a network round-trip to user_show_stubs.
const STUB_ID_RE = /-mz[a-zA-Z0-9]+$/;

type StubRow = { id: string; title: string; venue: string | null; city: string | null; category: string; opening_date: string | null; poster_url: string | null };

function stubToDetail(r: StubRow): DiaryShowDetail {
  return {
    id: r.id,
    title: r.title,
    slug: r.id,
    venue: r.venue || '',
    city: r.city,
    country: null,
    category: r.category,
    openingDate: r.opening_date,
    posterUrl: r.poster_url,
  };
}

/** Ids per request: keeps the URL well under proxy limits (~60 chars each). */
export const STUB_BATCH_SIZE = 100;

/** Fallback for shows added via live Mezzanine search since the last
 *  nightly resolver run (resolve-unmatched-imports.js), not yet in
 *  diary-lookup.json. Public SELECT, no auth needed. One request per
 *  STUB_BATCH_SIZE ids, so a shared diary with many such shows doesn't fan
 *  out one request per show. A miss or network error leaves the id out. */
export async function getShowStubsByIds(
  ids: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, DiaryShowDetail>> {
  const out = new Map<string, DiaryShowDetail>();
  // Quoted in the in.() list below, so a quote or backslash can't be in one.
  const wanted = Array.from(new Set(ids)).filter(id => STUB_ID_RE.test(id) && !/["\\]/.test(id));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!wanted.length || !url || !key) return out;
  const chunks: string[][] = [];
  for (let i = 0; i < wanted.length; i += STUB_BATCH_SIZE) chunks.push(wanted.slice(i, i + STUB_BATCH_SIZE));
  await Promise.all(chunks.map(async chunk => {
    const list = encodeURIComponent(`(${chunk.map(id => `"${id}"`).join(',')})`);
    try {
      const res = await fetchImpl(
        `${url}/rest/v1/user_show_stubs?id=in.${list}&select=id,title,venue,city,category,opening_date,poster_url`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store' },
      );
      if (!res.ok) return;
      const rows: StubRow[] = await res.json();
      for (const r of rows) if (chunk.includes(r.id)) out.set(r.id, stubToDetail(r));
    } catch {
      // This chunk's shows are left out, as for any unknown id.
    }
  }));
  return out;
}
