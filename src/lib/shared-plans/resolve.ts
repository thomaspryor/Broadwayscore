/**
 * Shared Plans: show ids → what the plans page renders (BRO-4481).
 *
 * Runs on the server, the same three-step chain `/diary-show/[id]` uses:
 * the main catalog (data-core), then diary-only shows from diary-lookup.json,
 * then live user-added stubs. Ids none of them know are dropped, never shown
 * as raw ids. The page renders them with My Shows' own Upcoming cards
 * (src/components/user/upcoming-cards.tsx).
 *
 * The lookups are injected so this stays testable without the private data
 * clone or Supabase; `resolve-server.ts` wires the real ones.
 */
import type { BookabilitySource } from '@/components/user/upcoming-cards';
import type { DiaryShowDetail } from '@/lib/diary-show-types';
import type { PlannedShowSource } from '@/lib/calendar-event';
import type { PlanShowLike } from './select';

export interface PlanShow extends PlanShowLike {
  title: string;
  /** Where a tap goes: the show page, or the diary page for catalog-only shows. */
  href: string;
  posterUrl: string | null;
  venue: string;
  /** Run status for the Watchlist-style poster badge; null for catalog-only shows. */
  bookability: BookabilitySource | null;
  /** What the calendar builders need. */
  calendar: PlannedShowSource;
}

/** The subset of a data-core ComputedShow this module reads. */
export interface CatalogShow {
  id: string;
  slug: string;
  title: string;
  venue: string;
  category?: string;
  status: string;
  images?: { thumbnail?: string; poster?: string; hero?: string };
  theaterAddress?: string;
  runtime?: string | null;
  previewsStartDate?: string | null;
  openingDate?: string | null;
  ticketLinks?: unknown[] | null;
}

export interface ResolveDeps<S extends CatalogShow = CatalogShow> {
  getShow(id: string): S | undefined;
  getDiaryShow(id: string): DiaryShowDetail | null;
  getStub(id: string): Promise<DiaryShowDetail | null>;
}

export async function resolvePlanShows<S extends CatalogShow>(
  ids: readonly string[],
  deps: ResolveDeps<S>,
): Promise<Map<string, PlanShow>> {
  const out = new Map<string, PlanShow>();
  const unique = Array.from(new Set(ids));

  await Promise.all(unique.map(async id => {
    const show = deps.getShow(id);
    if (show) {
      out.set(id, {
        id,
        title: show.title,
        href: `/show/${show.slug}`,
        posterUrl: show.images?.poster || show.images?.thumbnail || null,
        venue: show.venue || '',
        category: show.category ?? 'broadway',
        status: show.status,
        bookability: {
          status: show.status,
          previewDate: show.previewsStartDate ?? null,
          openingDate: show.openingDate ?? null,
          // Same rule as scripts/generate-show-lookup.js `tx` (My Shows' source).
          ticketsOnSale: (show.status === 'upcoming' || show.status === 'announced') && !!show.ticketLinks?.length,
        },
        calendar: {
          id, title: show.title, slug: show.slug,
          category: show.category ?? 'broadway',
          venue: show.venue, theaterAddress: show.theaterAddress ?? null, runtime: show.runtime ?? null,
        },
      });
      return;
    }
    const diary = deps.getDiaryShow(id) || await deps.getStub(id).catch(() => null);
    if (diary) {
      out.set(id, {
        id,
        title: diary.title,
        href: `/diary-show/${diary.slug}`,
        posterUrl: diary.posterUrl,
        venue: diary.venue,
        category: diary.category,
        // Catalog-only shows carry no run status; treat as not closed.
        status: null,
        bookability: null,
        calendar: {
          id, title: diary.title, slug: diary.slug, diaryOnly: true,
          category: diary.category, venue: diary.venue,
        },
      });
    }
  }));

  return out;
}
