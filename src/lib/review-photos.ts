/**
 * Diary photos on the web (BRO-6170): list, sign, upload, delete.
 *
 * Same storage contract as the iOS app (BroadwayScorecard-app,
 * lib/photo-storage.ts). Schema, owned by the app repo's migrations
 * 20260727120000_user_review_photos.sql and
 * 20260727130000_user_review_photos_path_constraint.sql:
 *   - table  public.user_review_photos (owner-only RLS on user_id; CHECK
 *     split_part(storage_path, '/', 1) = user_id::text)
 *   - bucket diary-photos, PRIVATE (public = false), storage.objects RLS
 *     requires the first path segment to equal auth.uid()
 *   - path   {user_id}/{review_id}/{photo_id}.jpg (buildPhotoStoragePath)
 *
 * Hard rule, same as the app: the bucket is private, so every read goes
 * through a short-lived signed URL. Never build a /object/public/ URL.
 *
 * Every photo is decoded and re-encoded to JPEG through a canvas before it
 * leaves the browser (long edge <= 2048, quality 0.82, the app's numbers).
 * The re-encode is also what strips EXIF (GPS, camera) from the upload.
 */

import { getSupabaseClient } from './supabase';
import { supabaseRestDelete, supabaseRestInsert, supabaseRestSelect } from './supabase-rest';
import { instrumentedFetch, reportUgcError } from './ugc-analytics';
import {
  DIARY_PHOTOS_BUCKET,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_DIMENSION,
  buildPhotoStoragePath,
  fitWithinMaxEdge,
  isHeicLike,
  isStorageDuplicate,
  photoFileProblem,
  signedUrlToAbsolute as toAbsolute,
  storageObjectUrl,
} from './review-photo-model';

export { DIARY_PHOTOS_BUCKET, MAX_PHOTOS_PER_REVIEW } from './review-photo-model';
import { MAX_PHOTOS_PER_REVIEW as MAX_PHOTOS } from './review-photo-model';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

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
  /** Object path in the bucket (needed to delete it). Empty for dev mock photos. */
  storagePath: string;
  url: string;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  createdAt: string;
}

/** A failure whose `message` is fit to show the user as-is. */
export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

const ROW_COLUMNS = 'id,review_id,user_id,storage_path,width,height,taken_at,created_at';

/**
 * The signed-in user's photos, newest first; pass `reviewId` for one entry.
 * RLS limits rows to the caller.
 */
export async function listUserReviewPhotos(userId: string, reviewId?: string): Promise<ReviewPhotoRow[]> {
  const params = [
    `select=${ROW_COLUMNS}`,
    `user_id=eq.${encodeURIComponent(userId)}`,
    ...(reviewId ? [`review_id=eq.${encodeURIComponent(reviewId)}`] : []),
    'order=created_at.desc',
  ].join('&');
  const { data, error } = await supabaseRestSelect<ReviewPhotoRow>('user_review_photos', params);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The current session's token and user id. getSession() refreshes an expired token. */
async function currentSession(): Promise<{ token: string; userId: string } | null> {
  const client = await getSupabaseClient();
  if (!client) return null;
  const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token || !session.user?.id) return null;
  return { token: session.access_token, userId: session.user.id };
}

function storageHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: ANON_KEY, Authorization: `Bearer ${token}`, ...extra };
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
  const session = await currentSession();
  if (!session) throw new Error('No valid session. Please sign in again.');

  const out: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += SIGN_BATCH) {
    const batch = paths.slice(i, i + SIGN_BATCH);
    const res = await instrumentedFetch(`${SUPABASE_URL}/storage/v1/object/sign/${DIARY_PHOTOS_BUCKET}`, {
      method: 'POST',
      headers: storageHeaders(session.token, { 'Content-Type': 'application/json' }),
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
  return toAbsolute(signedURL, SUPABASE_URL);
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
      storagePath: row.storage_path,
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

// ─── Upload pipeline ─────────────────────────────────────────────────────

export interface PreparedPhoto {
  blob: Blob;
  width: number;
  height: number;
}

const CANT_READ_HEIC = 'This browser can’t open HEIC photos. Save it as a JPEG first, or add it from the iPhone app.';
const CANT_READ = 'Couldn’t read that photo. Try a different one.';

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

/**
 * createImageBitmap with imageOrientation 'from-image' applies the EXIF
 * rotation, so a portrait phone photo isn't saved sideways. Browsers without
 * it (or that reject the option) fall back to an <img>, which also honours
 * EXIF orientation by default (CSS image-orientation: from-image).
 */
async function decodeImage(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode → downscale (long edge <= 2048) → JPEG at 0.82. Throws PhotoError with a readable message. */
export async function prepareReviewPhoto(file: File): Promise<PreparedPhoto> {
  const problem = photoFileProblem(file);
  if (problem) throw new PhotoError(problem);

  let decoded: Decoded;
  try {
    decoded = await decodeImage(file);
  } catch {
    throw new PhotoError(isHeicLike(file) ? CANT_READ_HEIC : CANT_READ);
  }
  try {
    if (!decoded.width || !decoded.height) throw new PhotoError(CANT_READ);
    const { width, height } = fitWithinMaxEdge(decoded.width, decoded.height, PHOTO_MAX_DIMENSION);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PhotoError(CANT_READ);
    // JPEG has no alpha: give transparent PNG/WebP pixels a white ground
    // instead of the black the encoder would otherwise produce.
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', PHOTO_JPEG_QUALITY));
    if (!blob) throw new PhotoError(CANT_READ);
    return { blob, width, height };
  } finally {
    decoded.close();
  }
}

async function errorBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

const NETWORK_MESSAGE = 'Couldn’t upload. Check your connection and try again.';
const SESSION_MESSAGE = 'You were signed out. Sign in again to add photos.';

/** Never overwrites an existing object (x-upsert: false); a duplicate counts as already uploaded. */
async function putObject(token: string, path: string, blob: Blob): Promise<void> {
  let res: Response;
  try {
    res = await instrumentedFetch(storageObjectUrl(SUPABASE_URL, path), {
      method: 'POST',
      headers: storageHeaders(token, { 'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'cache-control': 'max-age=3600' }),
      body: blob,
    });
  } catch {
    throw new PhotoError(NETWORK_MESSAGE);
  }
  if (res.ok) return;
  const body = await errorBody(res);
  // A retry after a lost response: the object is already there.
  if (isStorageDuplicate(res.status, body)) return;
  reportUgcError('storage upload diary-photos', { message: String(body.message || body.error || `HTTP ${res.status}`), status: res.status });
  if (res.status === 401 || res.status === 403) throw new PhotoError(SESSION_MESSAGE);
  if (res.status === 413) throw new PhotoError('That photo is too large to upload.');
  throw new PhotoError('Couldn’t upload this photo. Try again.');
}

/** Removes objects from the bucket. Storage's bulk delete: DELETE /object/<bucket> { prefixes }. */
async function removeObjects(token: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const res = await instrumentedFetch(`${SUPABASE_URL}/storage/v1/object/${DIARY_PHOTOS_BUCKET}`, {
    method: 'DELETE',
    headers: storageHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!res.ok) {
    const body = await errorBody(res);
    const message = String(body.message || body.error || `HTTP ${res.status}`);
    reportUgcError('storage delete diary-photos', { message, status: res.status });
    throw new Error(message);
  }
}

export interface UploadReviewPhotoInput {
  /** Who the caller thinks is signed in; refused if the session says otherwise. */
  userId: string;
  reviewId: string;
  /** Client-generated (newPhotoId); reuse it on retry so a half-done attempt completes. */
  photoId: string;
  file: File;
}

/**
 * Uploads one photo to `{uid}/{reviewId}/{photoId}.jpg`, then inserts its
 * user_review_photos row. If the row insert fails, the uploaded object is
 * deleted so nothing is left orphaned in the bucket. Idempotent per photoId.
 */
export async function uploadReviewPhoto({ userId, reviewId, photoId, file }: UploadReviewPhotoInput): Promise<ReviewPhotoRow> {
  const prepared = await prepareReviewPhoto(file);
  const session = await currentSession();
  if (!session) throw new PhotoError(SESSION_MESSAGE);
  if (session.userId !== userId) throw new PhotoError('You’re signed in as a different account. Reload the page.');

  // The path's first segment is the session's own uid: the storage RLS
  // policy and the table's CHECK constraint both compare against it.
  const path = buildPhotoStoragePath(session.userId, reviewId, photoId);
  await putObject(session.token, path, prepared.blob);

  const row = {
    id: photoId,
    review_id: reviewId,
    user_id: session.userId,
    storage_path: path,
    width: prepared.width,
    height: prepared.height,
    // The app stores null too: lastModified is when the file was saved, not
    // when the photo was taken, and EXIF is never read.
    taken_at: null,
  };
  let insertError: { message: string; code?: string } | null = null;
  let inserted: ReviewPhotoRow | null = null;
  try {
    const result = await supabaseRestInsert<ReviewPhotoRow>('user_review_photos', row);
    insertError = result.error;
    inserted = result.data;
  } catch {
    insertError = { message: NETWORK_MESSAGE, code: 'network' };
  }
  // 23505: this photoId's row already landed on an earlier attempt.
  if (!insertError || insertError.code === '23505') {
    return inserted ?? { ...row, created_at: new Date().toISOString() };
  }

  // A lost response is ambiguous: the INSERT may have committed. Deleting the
  // object then would leave a row pointing at nothing, invisible in the feed
  // but holding one of the six slots. Look before cleaning up; if we can't
  // tell, keep the object (a retry is idempotent: duplicate upload + 23505).
  if (insertError.code === 'network') {
    const landed = await supabaseRestSelect<ReviewPhotoRow>(
      'user_review_photos',
      `select=*&id=eq.${encodeURIComponent(photoId)}`,
    ).catch(() => null);
    if (landed && !landed.error && landed.data?.length) return landed.data[0];
    if (!landed || landed.error) throw new PhotoError(NETWORK_MESSAGE);
  }

  // No orphans: the row never landed, so take the object back out.
  await removeObjects(session.token, [path]).catch(() => {});
  if (insertError.code === '23503') throw new PhotoError('This diary entry no longer exists.');
  // 23514: the user_review_photos_limit trigger (20261028_diary_photo_limits.sql) refused a 7th photo.
  if (insertError.code === '23514') throw new PhotoError(`Up to ${MAX_PHOTOS} photos per entry. Delete one to add another.`);
  if (insertError.code === 'network') throw new PhotoError(NETWORK_MESSAGE);
  if (/session|jwt/i.test(insertError.message)) throw new PhotoError(SESSION_MESSAGE);
  throw new PhotoError('Couldn’t save this photo. Try again.');
}

/**
 * Deletes the row first, so the photo leaves the feed even if the object
 * removal then fails; a leftover object is private and is swept when its
 * diary entry is deleted (removeReviewPhotoFolder).
 */
export async function deleteReviewPhoto(photo: { id: string; storagePath: string }): Promise<void> {
  const session = await currentSession();
  if (!session) throw new PhotoError(SESSION_MESSAGE);
  const { error } = await supabaseRestDelete(
    'user_review_photos',
    `id=eq.${encodeURIComponent(photo.id)}&user_id=eq.${encodeURIComponent(session.userId)}`,
  );
  if (error) throw new PhotoError('Couldn’t delete this photo. Try again.');
  if (photo.storagePath) await removeObjects(session.token, [photo.storagePath]).catch(() => {});
}

/**
 * Deleting a diary entry cascades its photo rows but leaves the storage
 * objects. Lists the entry's folder (`{uid}/{reviewId}/`, the same prefix as
 * buildPhotoStoragePath) and removes what is there, as the app's
 * removeReviewPhotoFiles does. Best effort: callers ignore failures.
 */
export async function removeReviewPhotoFolder(reviewId: string): Promise<void> {
  const session = await currentSession();
  if (!session || !reviewId || reviewId.includes('/')) return;
  const prefix = `${session.userId}/${reviewId}`;
  const res = await instrumentedFetch(`${SUPABASE_URL}/storage/v1/object/list/${DIARY_PHOTOS_BUCKET}`, {
    method: 'POST',
    headers: storageHeaders(session.token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix, limit: 100, offset: 0 }),
  });
  if (!res.ok) return;
  const entries = (await res.json().catch(() => [])) as { id?: string | null; name?: string }[];
  // Folder placeholders come back with a null id; only real objects are removed.
  const paths = entries.filter(e => e.id && e.name).map(e => `${prefix}/${e.name}`);
  await removeObjects(session.token, paths);
}

// ─── Change notifications ────────────────────────────────────────────────

const CHANGED_EVENT = 'bsc:review-photos-changed';

/** Tell every photo list on the page (feed, editor row) to refresh. */
export function emitReviewPhotosChanged(reviewId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { reviewId } }));
}

export function onReviewPhotosChanged(cb: (reviewId: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => cb(((e as CustomEvent).detail?.reviewId as string) || '');
  window.addEventListener(CHANGED_EVENT, handler);
  return () => window.removeEventListener(CHANGED_EVENT, handler);
}
