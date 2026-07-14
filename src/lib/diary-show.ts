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
