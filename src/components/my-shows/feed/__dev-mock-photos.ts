/**
 * Dev-only stand-in photos for the Feed design renders (?mock=1 / ?mock=large,
 * BRO-6170). Loaded lazily by useFeedPhotos in mock mode only.
 *
 * There are no real personal photos to show, so these are obviously
 * stand-ins: theatre exterior shots (public/images/theaters) play the
 * "outside the theatre that night" photo, and two on-stage production hero stills
 * (public/images/shows/<id>/hero.webp) play the "curtain call" photo. Most
 * hero images are logo key art, so only stage shots are used.
 * The proposal labels them "sample photos".
 */
import type { FeedPhoto } from '@/lib/review-photos';

const T = (slug: string) => `/images/theaters/${slug}.jpg`;
const H = (showId: string) => `/images/shows/${showId}/hero.webp`;

/** review id → photo URLs, in the order they were "added". */
const MOCK_PHOTO_SRCS: Record<string, string[]> = {
  // ?mock=large (src/app/my-shows/__dev-mock-data-large.ts): 19 of 115
  // entries, spread across the years, several with 2-4 photos.
  'r-l-115': [T('todd-haimes-theatre')],
  'r-l-112': [T('samuel-j-friedman-theatre'), T('music-box-theatre')],
  'r-l-108': [T('palace-theatre')],
  'r-l-107': [T('studio-54')],
  'r-l-099': [T('winter-garden-theatre'), T('broadway-theatre')],
  'r-l-098': [T('gershwin-theatre')],
  'r-l-096': [T('broadhurst-theatre'), T('lunt-fontanne-theatre')],
  'r-l-089': [T('imperial-theatre')],
  'r-l-083': [T('marquis-theatre')],
  'r-l-081': [T('richard-rodgers-theatre')],
  'r-l-078': [T('booth-theatre'), T('ethel-barrymore-theatre')],
  'r-l-071': [T('lyceum-theatre')],
  'r-l-052': [T('neil-simon-theatre'), T('lyric-theatre'), T('new-amsterdam-theatre'), T('nederlander-theatre')],
  'r-l-046': [T('al-hirschfeld-theatre')],
  'r-l-031': [T('shubert-theatre'), H('some-like-it-hot-2022'), T('stephen-sondheim-theatre')],
  'r-l-020': [T('walter-kerr-theatre')],
  'r-l-018': [T('lena-horne-theatre'), H('six-2021')],
  'r-l-014': [T('minskoff-theatre')],
  'r-l-001': [T('majestic-theatre')],
  // ?mock=1 (src/app/my-shows/__dev-mock-data.ts)
  r1: [T('gershwin-theatre')],
  r2: [T('richard-rodgers-theatre')],
  r3: [T('august-wilson-theatre'), H('six-2021'), T('studio-54')],
  r5: [T('hudson-theatre'), H('some-like-it-hot-2022'), T('booth-theatre'), T('lyceum-theatre')],
};

// Uploads and deletes made in mock mode (?mock=1 / ?mock=large). Module
// state, so it lasts until a full reload; never touches Supabase.
const added: FeedPhoto[] = [];
const deleted = new Set<string>();

export function buildMockPhotosByReview(opts: { seeded?: boolean } = {}): Record<string, FeedPhoto[]> {
  const out: Record<string, FeedPhoto[]> = {};
  if (opts.seeded !== false) {
    for (const [reviewId, srcs] of Object.entries(MOCK_PHOTO_SRCS)) {
      out[reviewId] = srcs.map((url, i) => ({
        id: `mock-photo-${reviewId}-${i + 1}`,
        reviewId,
        storagePath: '',
        url,
        width: null,
        height: null,
        takenAt: null,
        createdAt: `2026-01-01T00:00:0${i}Z`,
      }));
    }
  }
  for (const photo of added) (out[photo.reviewId] ||= []).push(photo);
  for (const reviewId of Object.keys(out)) {
    out[reviewId] = out[reviewId].filter(p => !deleted.has(p.id));
    if (out[reviewId].length === 0) delete out[reviewId];
  }
  return out;
}

export function addMockPhoto(photo: FeedPhoto): void {
  added.push(photo);
}

export function removeMockPhoto(photoId: string): void {
  deleted.add(photoId);
}
