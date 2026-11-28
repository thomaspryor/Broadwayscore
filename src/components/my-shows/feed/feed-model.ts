/**
 * Pure grouping for the Feed (BRO-6170), mirroring the iOS app's
 * hooks/usePhotoFeed.ts: Timeline = dated entries grouped by month, newest
 * first; Photo wall = every photo, flat.
 */
import type { UserReview, ShowLookup } from '@/types/user';
import type { FeedPhoto } from '@/lib/review-photos';

export interface FeedEntry {
  review: UserReview;
  photos: FeedPhoto[];
}

export interface FeedMonthGroup {
  key: string; // YYYY-MM
  label: string; // "October 2026"
  entries: FeedEntry[];
}

/** A photo with the diary entry it belongs to (wall tiles, lightbox slides). */
export interface FeedSlide {
  photo: FeedPhoto;
  review: UserReview;
}

function byDateSeenDesc(a: UserReview, b: UserReview): number {
  if (a.date_seen !== b.date_seen) return (b.date_seen ?? '') < (a.date_seen ?? '') ? -1 : 1;
  return b.created_at < a.created_at ? -1 : b.created_at > a.created_at ? 1 : 0;
}

export function monthLabel(dateSeen: string): string {
  return new Date(`${dateSeen}T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function buildMonthGroups(reviews: UserReview[], photosByReview: Record<string, FeedPhoto[]>): FeedMonthGroup[] {
  const dated = reviews.filter(r => !!r.date_seen).sort(byDateSeenDesc);
  const groups: FeedMonthGroup[] = [];
  for (const review of dated) {
    const key = review.date_seen!.slice(0, 7);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: monthLabel(review.date_seen!), entries: [] };
      groups.push(group);
    }
    group.entries.push({ review, photos: photosByReview[review.id] ?? [] });
  }
  return groups;
}

/** Every photo, newest night first; undated entries' photos go last. */
export function buildWallSlides(reviews: UserReview[], photosByReview: Record<string, FeedPhoto[]>): FeedSlide[] {
  const withPhotos = reviews.filter(r => (photosByReview[r.id]?.length ?? 0) > 0);
  const dated = withPhotos.filter(r => r.date_seen).sort(byDateSeenDesc);
  const undated = withPhotos.filter(r => !r.date_seen).sort(byDateSeenDesc);
  return [...dated, ...undated].flatMap(review => photosByReview[review.id].map(photo => ({ photo, review })));
}

export function showHref(show: ShowLookup | undefined, showId: string): string {
  const slug = show?.slug || show?.id || showId;
  return show?.diaryOnly ? `/diary-show/${slug}` : `/show/${slug}`;
}

/** Readable fallback when a show id is missing from the lookup ("wicked-2003" → "Wicked"). */
export function titleFor(show: ShowLookup | undefined, showId: string): string {
  if (show?.title) return show.title;
  return showId
    .replace(/-(\d{4})$/, '')
    .split('-')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export function dayMonth(dateSeen: string): { day: string; month: string } {
  const d = new Date(`${dateSeen}T00:00:00`);
  return { day: String(d.getDate()), month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase() };
}

export function longDate(dateSeen: string | null): string | null {
  if (!dateSeen) return null;
  return new Date(`${dateSeen}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
