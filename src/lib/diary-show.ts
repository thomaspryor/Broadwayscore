// Server-only — reads public/data/diary-lookup.json via fs. Never import
// this from a 'use client' component; use diary-show-types.ts for the type.
import fs from 'fs';
import path from 'path';
import type { DiaryShowDetail } from './diary-show-types';

export type { DiaryShowDetail };
export { marketLabel } from './diary-show-types';

let cache: Map<string, DiaryShowDetail> | null = null;

/** Reads public/data/diary-lookup.json once per process (86400s revalidate
 *  on the page means this reloads at most once a day per rebuild). */
function loadDiaryLookup(): Map<string, DiaryShowDetail> {
  if (cache) return cache;
  try {
    const filePath = path.join(process.cwd(), 'public/data/diary-lookup.json');
    const raw: Record<string, unknown>[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const loaded = new Map<string, DiaryShowDetail>();
    for (const r of raw) {
      const id = r.id as string;
      loaded.set(id, {
        id,
        title: r.t as string,
        slug: (r.s as string) || id,
        venue: (r.v as string) || '',
        city: (r.ci as string) || null,
        country: (r.co as string) || null,
        category: (r.c as string) || null,
        openingDate: (r.od as string) || null,
        posterUrl: (r.p as string) || null,
      });
    }
    cache = loaded;
  } catch {
    // diary-lookup.json missing or unparseable — don't cache the failure, so
    // a later request (e.g. after the file finishes writing) can retry.
    return new Map();
  }
  return cache;
}

export function getDiaryShowById(id: string): DiaryShowDetail | null {
  return loadDiaryLookup().get(id) || null;
}

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

/** One stub (the /diary-show/[id] page). A miss/network error just falls
 *  through to notFound() same as any other unknown id. */
export async function getShowStubById(id: string): Promise<DiaryShowDetail | null> {
  return (await getShowStubsByIds([id])).get(id) ?? null;
}
