/**
 * Client for the mezzanine-search edge function — live search against
 * Mezzanine's full production catalog for shows in neither our scored
 * catalog nor the diary-only catalog (Notion 39d637c5, card 174, Phase 2 of
 * the self-heal loop started by #170/#173).
 */
import { getSupabaseClient } from '@/lib/supabase';

/** One ranked search result — already shaped to become a user_show_stubs
 *  row or a diary-shows.json entry (id matches buildDiarySlug()'s output). */
export interface MezzanineCandidate {
  id: string;
  mezzShowId: string | null;
  mezzProdId: string;
  title: string;
  venue: string | null;
  city: string | null;
  country: string | null;
  category: string;
  openingDate: string | null;
  posterUrl: string | null;
  ratingsCount: number;
}

interface MezzanineSearchResponse {
  ok: boolean;
  error?: 'invalid_query' | 'unauthorized' | 'rate_limited' | 'upstream_auth' | 'internal';
  candidates?: MezzanineCandidate[];
  truncated?: boolean;
}

export const MEZZANINE_SEARCH_ERROR_COPY: Record<string, string> = {
  invalid_query: 'Type at least 2 characters to search the wider catalog.',
  unauthorized: 'Please sign in again and retry.',
  rate_limited: "You've hit the search limit for now — try again in an hour.",
  upstream_auth: "Can't reach the wider catalog right now.",
  internal: 'Something went wrong on our side. Try again in a few minutes.',
};

/** Search Mezzanine's full catalog by free-text title. Throws Error with
 *  user-ready copy on any handled failure. */
export async function searchMezzanineCatalog(query: string): Promise<MezzanineCandidate[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error(MEZZANINE_SEARCH_ERROR_COPY.unauthorized);

  const { data, error } = await supabase.functions.invoke<MezzanineSearchResponse>('mezzanine-search', {
    body: { query },
  });
  if (error || !data) throw new Error(MEZZANINE_SEARCH_ERROR_COPY.internal);
  if (!data.ok) throw new Error(MEZZANINE_SEARCH_ERROR_COPY[data.error || 'internal'] || MEZZANINE_SEARCH_ERROR_COPY.internal);
  return data.candidates || [];
}

/** Resolve a single Mezzanine Show by its known objectId (exact match — used
 *  by the import flow's per-row "find it" button when the export already
 *  carries entry.show.id, so no fuzzy title search is needed). */
export async function resolveMezzanineShow(mezzShowId: string): Promise<MezzanineCandidate[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error(MEZZANINE_SEARCH_ERROR_COPY.unauthorized);

  const { data, error } = await supabase.functions.invoke<MezzanineSearchResponse>('mezzanine-search', {
    body: { mezzShowId },
  });
  if (error || !data) throw new Error(MEZZANINE_SEARCH_ERROR_COPY.internal);
  if (!data.ok) throw new Error(MEZZANINE_SEARCH_ERROR_COPY[data.error || 'internal'] || MEZZANINE_SEARCH_ERROR_COPY.internal);
  return data.candidates || [];
}

/** Build the user_show_stubs insert row for a selected candidate. */
export function stubRowFromCandidate(candidate: MezzanineCandidate, userId: string) {
  return {
    id: candidate.id,
    title: candidate.title,
    venue: candidate.venue,
    city: candidate.city,
    category: candidate.category,
    opening_date: candidate.openingDate,
    poster_url: candidate.posterUrl,
    mezz_prod_id: candidate.mezzProdId,
    created_by: userId,
  };
}
