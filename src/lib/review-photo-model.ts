/**
 * Pure rules for diary photos (BRO-6170), shared by the web upload/delete
 * helpers in ./review-photos and their unit tests. No I/O and no browser
 * globals beyond `crypto`, so tests import the real functions.
 *
 * Every constant here mirrors the iOS app (BroadwayScorecard-app) so a photo
 * added on either side looks the same on the other:
 *   - lib/photo-types.ts         MAX_PHOTOS_PER_REVIEW = 6, PHOTO_MAX_DIMENSION = 2048
 *   - lib/photo-image-pipeline.ts JPEG re-encode at compress 0.82, long edge <= 2048
 *   - lib/photo-path.ts          `${userId}/${reviewId}/${photoId}.jpg`
 * and the app repo's migrations, which enforce the path shape:
 *   - 20260727120000_user_review_photos.sql: storage.objects RLS requires
 *     auth.uid()::text = (storage.foldername(name))[1]
 *   - 20260727130000_user_review_photos_path_constraint.sql: CHECK
 *     split_part(storage_path, '/', 1) = user_id::text
 */

export const DIARY_PHOTOS_BUCKET = 'diary-photos';
export const MAX_PHOTOS_PER_REVIEW = 6;
export const PHOTO_MAX_DIMENSION = 2048;
export const PHOTO_JPEG_QUALITY = 0.82;
/** Originals above this are refused before decoding: a phone photo is 2-15 MB. */
export const PHOTO_MAX_INPUT_BYTES = 50 * 1024 * 1024;

/**
 * `accept` for the file input. `image/*` (not an explicit list) matters on
 * iOS Safari: naming image/heic there makes Safari hand over the raw HEIC
 * instead of converting it to JPEG. Types are checked after picking.
 */
export const PHOTO_INPUT_ACCEPT = 'image/*';

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif)$/i;
const HEIC_TYPES = new Set(['image/heic', 'image/heif']);
const HEIC_EXTENSIONS = /\.(heic|heif)$/i;

/** The parts of a File the type checks read (a plain object in tests). */
export interface PhotoFileLike {
  name: string;
  type: string;
  size?: number;
}

/**
 * JPEG, PNG, WebP or HEIC/HEIF. Some browsers report HEIC with an empty MIME
 * type (Chrome on Windows), so an empty type falls back to the extension.
 */
export function isAcceptedPhotoFile(file: PhotoFileLike): boolean {
  const type = (file.type || '').toLowerCase();
  if (type) return ACCEPTED_TYPES.has(type);
  return ACCEPTED_EXTENSIONS.test(file.name || '');
}

export function isHeicLike(file: PhotoFileLike): boolean {
  const type = (file.type || '').toLowerCase();
  return HEIC_TYPES.has(type) || HEIC_EXTENSIONS.test(file.name || '');
}

/** Same shape as the app's buildPhotoStoragePath: `{userId}/{reviewId}/{photoId}.jpg`. */
export function buildPhotoStoragePath(userId: string, reviewId: string, photoId: string): string {
  if (!userId || !reviewId || !photoId) {
    throw new Error('buildPhotoStoragePath requires userId, reviewId, and photoId');
  }
  if ([userId, reviewId, photoId].some(part => part.includes('/'))) {
    throw new Error('buildPhotoStoragePath: ids must not contain "/"');
  }
  return `${userId}/${reviewId}/${photoId}.jpg`;
}

/** First path segment: what both the RLS policy and the CHECK constraint compare to the owner. */
export function photoPathOwner(path: string): string | null {
  return path.split('/')[0] || null;
}

/** Free slots on one entry. Pending (uploading or failed) uploads hold a slot. */
export function remainingPhotoSlots(savedCount: number, pendingCount = 0): number {
  return Math.max(0, MAX_PHOTOS_PER_REVIEW - savedCount - pendingCount);
}

/** Takes the first `remaining` picks; the rest are reported as over the limit. */
export function splitByPhotoLimit<T>(picked: T[], remaining: number): { accepted: T[]; overLimit: number } {
  const n = Math.max(0, Math.min(picked.length, Math.floor(remaining)));
  return { accepted: picked.slice(0, n), overLimit: picked.length - n };
}

/**
 * Output size for the re-encode: the long edge is capped at `maxEdge`,
 * aspect ratio kept, never upscaled (the app's downscaleToJpeg rule).
 */
export function fitWithinMaxEdge(width: number, height: number, maxEdge: number = PHOTO_MAX_DIMENSION): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new Error('fitWithinMaxEdge: width and height must be positive');
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Storage's sign endpoint returns `/object/sign/<bucket>/<path>?token=…`,
 * relative to `<supabaseUrl>/storage/v1`. Absolute URLs pass through.
 */
export function signedUrlToAbsolute(signedURL: string, supabaseUrl: string): string {
  if (/^https?:\/\//.test(signedURL)) return signedURL;
  return `${supabaseUrl}/storage/v1${signedURL.startsWith('/') ? '' : '/'}${signedURL}`;
}

/** `<supabaseUrl>/storage/v1/object/<bucket>/<path>`, each path segment encoded. */
export function storageObjectUrl(supabaseUrl: string, path: string, bucket: string = DIARY_PHOTOS_BUCKET): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${supabaseUrl}/storage/v1/object/${bucket}/${encoded}`;
}

/** Storage answers a second upload to the same path with 409 or `{ error: 'Duplicate' }`. */
export function isStorageDuplicate(status: number, body: { error?: unknown; statusCode?: unknown } | null | undefined): boolean {
  if (status === 409) return true;
  return String(body?.statusCode ?? '') === '409' || String(body?.error ?? '') === 'Duplicate';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Client-generated photo id (the row id AND the file name, as in the app).
 * crypto.randomUUID only exists in secure contexts; fall back to
 * getRandomValues so a plain-http preview still works.
 */
export function newPhotoId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('No secure random source for a photo id');
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A user-facing message for a picked file the pipeline refuses up front, or null when it's fine. */
export function photoFileProblem(file: PhotoFileLike): string | null {
  if (!isAcceptedPhotoFile(file)) return 'That file isn’t a photo we can use. Pick a JPEG, PNG, WebP or HEIC image.';
  if (file.size != null && file.size > PHOTO_MAX_INPUT_BYTES) return 'That photo is too large (over 50 MB).';
  return null;
}
