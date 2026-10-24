/**
 * Read-only access to diary photos for the web Feed (BRO-6170).
 *
 * Photos are uploaded from the iOS app (BroadwayScorecard-app,
 * lib/photo-storage.ts). Schema, owned by the app repo's migration
 * 20260727120000_user_review_photos.sql:
 *   - table  public.user_review_photos (owner-only RLS on user_id)
 *   - bucket diary-photos, PRIVATE (public = false), storage.objects RLS
 *     requires the first path segment to equal auth.uid()
 *   - path   {user_id}/{review_id}/{photo_id}.jpg
 *
 * Hard rule, same as the app: the bucket is private, so every read goes
 * through a short-lived signed URL. Never build a /object/public/ URL.
 * The web does not upload photos yet.
 */

import { getSupabaseClient } from './supabase';
import { supabaseRestSelect } from './supabase-rest';
import { instrumentedFetch } from './ugc-analytics';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const DIARY_PHOTOS_BUCKET = 'diary-photos';
/** Signed URL lifetime. Short on purpose; the hook re-signs when it lapses. */
export const PHOTO_SIGNED_URL_TTL_SECONDS = 900;
const SIGN_BATCH = 100;

/** One row of public.user_review_photos. */
export interface ReviewPhotoRow {
  id: string;
  review_id: string;
  user_id: string;
  storage_path: string;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  created_at: string;
}

/** A photo ready to render: the row plus a URL the browser can load. */
export interface FeedPhoto {
  id: string;
  reviewId: string;
  url: string;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  createdAt: string;
}

/** Every photo the signed-in user owns, newest first. RLS limits rows to the caller. */
export async function listUserReviewPhotos(userId: string): Promise<ReviewPhotoRow[]> {
  const params = [
    'select=id,review_id,user_id,storage_path,width,height,taken_at,created_at',
    `user_id=eq.${encodeURIComponent(userId)}`,
    'order=created_at.desc',
  ].join('&');
  const { data, error } = await supabaseRestSelect<ReviewPhotoRow>('user_review_photos', params);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function currentAccessToken(): Promise<string | null> {
  const client = await getSupabaseClient();
  if (!client) return null;
  const { data: { session } } = await client.auth.getSession();
  return session?.access_token ?? null;
}

/**
 * Batch-signs storage paths in the private bucket through the Storage REST
 * endpoint `POST /storage/v1/object/sign/diary-photos` ({ expiresIn, paths }).
 * Returns path → absolute signed URL; paths the server refuses are left out.
 */
export async function signReviewPhotoPaths(
  paths: string[],
  expiresIn: number = PHOTO_SIGNED_URL_TTL_SECONDS,
): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const token = await currentAccessToken();
  if (!token) throw new Error('No valid session. Please sign in again.');

  const out: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += SIGN_BATCH) {
    const batch = paths.slice(i, i + SIGN_BATCH);
    const res = await instrumentedFetch(`${SUPABASE_URL}/storage/v1/object/sign/${DIARY_PHOTOS_BUCKET}`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn, paths: batch }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || `HTTP ${res.status}`);
    }
    const rows = (await res.json()) as { path?: string; signedURL?: string | null; error?: string | null }[];
    for (const row of rows) {
      if (row.path && row.signedURL) out[row.path] = signedUrlToAbsolute(row.signedURL);
    }
  }
  return out;
}

/** The endpoint returns `/object/sign/<bucket>/<path>?token=…`, relative to /storage/v1. */
export function signedUrlToAbsolute(signedURL: string): string {
  if (/^https?:\/\//.test(signedURL)) return signedURL;
  return `${SUPABASE_URL}/storage/v1${signedURL.startsWith('/') ? '' : '/'}${signedURL}`;
}

/** Rows + signed URLs → renderable photos grouped by review id (oldest first within a review). */
export function groupPhotosByReview(rows: ReviewPhotoRow[], signed: Record<string, string>): Record<string, FeedPhoto[]> {
  const byReview: Record<string, FeedPhoto[]> = {};
  for (const row of rows) {
    const url = signed[row.storage_path];
    if (!url) continue;
    (byReview[row.review_id] ||= []).push({
      id: row.id,
      reviewId: row.review_id,
      url,
      width: row.width,
      height: row.height,
      takenAt: row.taken_at,
      createdAt: row.created_at,
    });
  }
  for (const list of Object.values(byReview)) {
    list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
  return byReview;
}
