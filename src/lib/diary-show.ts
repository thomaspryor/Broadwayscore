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

/** Fallback for a show added via live Mezzanine search since the last
 *  nightly resolver run (resolve-unmatched-imports.js) — not yet in
 *  diary-lookup.json. Public SELECT, no auth needed; a miss/network error
 *  just falls through to notFound() same as any other unknown id. */
export async function getShowStubById(id: string): Promise<DiaryShowDetail | null> {
  if (!STUB_ID_RE.test(id)) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/user_show_stubs?id=eq.${encodeURIComponent(id)}&select=id,title,venue,city,category,opening_date,poster_url`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store' },
    );
    if (!res.ok) return null;
    const rows: { id: string; title: string; venue: string | null; city: string | null; category: string; opening_date: string | null; poster_url: string | null }[] = await res.json();
    const r = rows[0];
    if (!r) return null;
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
  } catch {
    return null;
  }
}
