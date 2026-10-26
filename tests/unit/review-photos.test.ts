/**
 * Diary photo upload/delete rules for the web (BRO-6170). Every subject is
 * the real function from src/lib (CLAUDE.md §15): path building, the
 * per-entry limit, the downscale size, signed-URL normalisation, and the
 * Feed's grouping. The path tests pin the exact shape the iOS app's
 * buildPhotoStoragePath produces and the app repo's migrations enforce
 * (storage RLS: auth.uid()::text = (storage.foldername(name))[1];
 * CHECK split_part(storage_path, '/', 1) = user_id::text).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIARY_PHOTOS_BUCKET,
  MAX_PHOTOS_PER_REVIEW,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_DIMENSION,
  PHOTO_MAX_INPUT_BYTES,
  buildPhotoStoragePath,
  fitWithinMaxEdge,
  isAcceptedPhotoFile,
  isHeicLike,
  isStorageDuplicate,
  isUuidV4,
  newPhotoId,
  photoFileProblem,
  photoPathOwner,
  remainingPhotoSlots,
  signedUrlToAbsolute,
  splitByPhotoLimit,
  storageObjectUrl,
} from '../../src/lib/review-photo-model';
import { groupPhotosByReview, type ReviewPhotoRow } from '../../src/lib/review-photos';
import { buildMonthGroups, buildWallSlides } from '../../src/components/my-shows/feed/feed-model';
import type { UserReview } from '../../src/types/user';

const UID = '3f1c2b7e-8a4d-4e2f-9b6a-1c0d2e3f4a5b';
const RID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PID = 'c0ffee00-1234-4abc-8def-0123456789ab';

// ── Constants match the app (lib/photo-types.ts, lib/photo-image-pipeline.ts) ──

test('constants mirror the iOS app', () => {
  assert.equal(DIARY_PHOTOS_BUCKET, 'diary-photos');
  assert.equal(MAX_PHOTOS_PER_REVIEW, 6);
  assert.equal(PHOTO_MAX_DIMENSION, 2048);
  assert.equal(PHOTO_JPEG_QUALITY, 0.82);
});

// ── Storage path ──

test('buildPhotoStoragePath: {userId}/{reviewId}/{photoId}.jpg, same as the app', () => {
  assert.equal(buildPhotoStoragePath(UID, RID, PID), `${UID}/${RID}/${PID}.jpg`);
});

test('buildPhotoStoragePath: first segment is the owner (storage RLS foldername[1] and the CHECK constraint)', () => {
  const path = buildPhotoStoragePath(UID, RID, PID);
  assert.equal(photoPathOwner(path), UID);
  // storage.foldername(name) = every segment but the file name.
  assert.deepEqual(path.split('/').slice(0, -1), [UID, RID]);
  // split_part(storage_path, '/', 1)
  assert.equal(path.split('/')[0], UID);
});

test('buildPhotoStoragePath: refuses empty ids and ids with a slash', () => {
  assert.throws(() => buildPhotoStoragePath('', RID, PID));
  assert.throws(() => buildPhotoStoragePath(UID, '', PID));
  assert.throws(() => buildPhotoStoragePath(UID, RID, ''));
  assert.throws(() => buildPhotoStoragePath(`${UID}/x`, RID, PID));
  assert.throws(() => buildPhotoStoragePath(UID, `../${RID}`, PID));
});

test('storageObjectUrl: object endpoint under /storage/v1, segments encoded', () => {
  assert.equal(
    storageObjectUrl('https://x.supabase.co', `${UID}/${RID}/${PID}.jpg`),
    `https://x.supabase.co/storage/v1/object/diary-photos/${UID}/${RID}/${PID}.jpg`,
  );
  assert.equal(storageObjectUrl('https://x.supabase.co', 'a b/c#d.jpg'), 'https://x.supabase.co/storage/v1/object/diary-photos/a%20b/c%23d.jpg');
});

test('newPhotoId: a v4 uuid, unique per call', () => {
  const a = newPhotoId();
  const b = newPhotoId();
  assert.ok(isUuidV4(a), a);
  assert.ok(isUuidV4(b), b);
  assert.notEqual(a, b);
  assert.equal(isUuidV4('not-a-uuid'), false);
});

// ── Limit ──

test('remainingPhotoSlots: saved and pending both hold a slot, never negative', () => {
  assert.equal(remainingPhotoSlots(0), 6);
  assert.equal(remainingPhotoSlots(4), 2);
  assert.equal(remainingPhotoSlots(4, 2), 0);
  assert.equal(remainingPhotoSlots(5, 3), 0);
  assert.equal(remainingPhotoSlots(6), 0);
});

test('splitByPhotoLimit: keeps the first N picks and counts the overflow', () => {
  assert.deepEqual(splitByPhotoLimit(['a', 'b', 'c'], 2), { accepted: ['a', 'b'], overLimit: 1 });
  assert.deepEqual(splitByPhotoLimit(['a', 'b'], 6), { accepted: ['a', 'b'], overLimit: 0 });
  assert.deepEqual(splitByPhotoLimit(['a'], 0), { accepted: [], overLimit: 1 });
  assert.deepEqual(splitByPhotoLimit(['a'], -3), { accepted: [], overLimit: 1 });
  // Picking 8 on an entry with 1 saved photo: 5 go up, 3 refused.
  const r = splitByPhotoLimit([1, 2, 3, 4, 5, 6, 7, 8], remainingPhotoSlots(1));
  assert.equal(r.accepted.length, 5);
  assert.equal(r.overLimit, 3);
});

// ── Downscale size ──

test('fitWithinMaxEdge: long edge capped at 2048, aspect kept', () => {
  assert.deepEqual(fitWithinMaxEdge(4032, 3024), { width: 2048, height: 1536 }); // iPhone landscape
  assert.deepEqual(fitWithinMaxEdge(3024, 4032), { width: 1536, height: 2048 }); // portrait
  assert.deepEqual(fitWithinMaxEdge(8000, 1000), { width: 2048, height: 256 }); // panorama
  assert.deepEqual(fitWithinMaxEdge(5000, 5000), { width: 2048, height: 2048 });
});

test('fitWithinMaxEdge: never upscales; exact 2048 untouched', () => {
  assert.deepEqual(fitWithinMaxEdge(1200, 800), { width: 1200, height: 800 });
  assert.deepEqual(fitWithinMaxEdge(2048, 1000), { width: 2048, height: 1000 });
});

test('fitWithinMaxEdge: extreme ratios keep at least 1px; bad sizes throw', () => {
  assert.deepEqual(fitWithinMaxEdge(100000, 10), { width: 2048, height: 1 });
  assert.throws(() => fitWithinMaxEdge(0, 100));
  assert.throws(() => fitWithinMaxEdge(100, Number.NaN));
});

// ── File types ──

test('isAcceptedPhotoFile: jpeg/png/webp/heic/heif in; others out; empty type falls back to extension', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'IMAGE/JPEG']) {
    assert.ok(isAcceptedPhotoFile({ name: 'x', type }), type);
  }
  for (const type of ['image/gif', 'image/svg+xml', 'video/quicktime', 'application/pdf']) {
    assert.equal(isAcceptedPhotoFile({ name: 'x.jpg', type }), false, type);
  }
  assert.ok(isAcceptedPhotoFile({ name: 'IMG_0001.HEIC', type: '' }));
  assert.equal(isAcceptedPhotoFile({ name: 'notes.txt', type: '' }), false);
});

test('isHeicLike: by type or extension', () => {
  assert.ok(isHeicLike({ name: 'a', type: 'image/heic' }));
  assert.ok(isHeicLike({ name: 'a.heif', type: '' }));
  assert.equal(isHeicLike({ name: 'a.jpg', type: 'image/jpeg' }), false);
});

test('photoFileProblem: readable reason, or null when fine', () => {
  assert.equal(photoFileProblem({ name: 'a.jpg', type: 'image/jpeg', size: 3_000_000 }), null);
  assert.match(photoFileProblem({ name: 'a.gif', type: 'image/gif' }) ?? '', /JPEG, PNG, WebP or HEIC/);
  assert.match(photoFileProblem({ name: 'a.jpg', type: 'image/jpeg', size: PHOTO_MAX_INPUT_BYTES + 1 }) ?? '', /too large/);
});

test('isStorageDuplicate: 409 status or Duplicate body', () => {
  assert.ok(isStorageDuplicate(409, {}));
  assert.ok(isStorageDuplicate(400, { statusCode: '409', error: 'Duplicate' }));
  assert.ok(isStorageDuplicate(400, { error: 'Duplicate' }));
  assert.equal(isStorageDuplicate(400, { statusCode: '403', error: 'Unauthorized' }), false);
  assert.equal(isStorageDuplicate(500, null), false);
});

// ── Signed URLs ──

test('signedUrlToAbsolute: relative sign path → <url>/storage/v1/…; absolute passes through', () => {
  const base = 'https://abc.supabase.co';
  assert.equal(
    signedUrlToAbsolute('/object/sign/diary-photos/u/r/p.jpg?token=t', base),
    'https://abc.supabase.co/storage/v1/object/sign/diary-photos/u/r/p.jpg?token=t',
  );
  assert.equal(
    signedUrlToAbsolute('object/sign/diary-photos/u/r/p.jpg?token=t', base),
    'https://abc.supabase.co/storage/v1/object/sign/diary-photos/u/r/p.jpg?token=t',
  );
  const abs = 'https://abc.supabase.co/storage/v1/object/sign/diary-photos/u/r/p.jpg?token=t';
  assert.equal(signedUrlToAbsolute(abs, base), abs);
});

// ── Grouping ──

function row(id: string, reviewId: string, createdAt: string): ReviewPhotoRow {
  return {
    id,
    review_id: reviewId,
    user_id: UID,
    storage_path: `${UID}/${reviewId}/${id}.jpg`,
    width: 2048,
    height: 1536,
    taken_at: null,
    created_at: createdAt,
  };
}

test('groupPhotosByReview: groups by entry, oldest first, carries storagePath, drops unsigned', () => {
  const rows = [row('p3', 'r1', '2026-03-03'), row('p1', 'r1', '2026-03-01'), row('p2', 'r2', '2026-03-02'), row('p4', 'r2', '2026-03-04')];
  const signed: Record<string, string> = {};
  for (const r of rows.slice(0, 3)) signed[r.storage_path] = `https://cdn/${r.id}`;
  const out = groupPhotosByReview(rows, signed);
  assert.deepEqual(out.r1.map(p => p.id), ['p1', 'p3']);
  assert.deepEqual(out.r2.map(p => p.id), ['p2']); // p4 had no signed URL
  assert.equal(out.r1[0].storagePath, `${UID}/r1/p1.jpg`);
  assert.equal(out.r1[0].url, 'https://cdn/p1');
});

function review(id: string, dateSeen: string | null, createdAt = '2026-01-01T00:00:00Z'): UserReview {
  return { id, show_id: `show-${id}`, rating: 4, review_text: null, date_seen: dateSeen, created_at: createdAt } as UserReview;
}

test('buildMonthGroups: dated entries by month, newest first; undated left out; photos attached', () => {
  const reviews = [review('a', '2026-03-02'), review('b', '2026-03-20'), review('c', '2026-01-05'), review('d', null)];
  const photos = groupPhotosByReview([row('p1', 'b', '2026-03-21')], { [`${UID}/b/p1.jpg`]: 'u' });
  const groups = buildMonthGroups(reviews, photos);
  assert.deepEqual(groups.map(g => g.key), ['2026-03', '2026-01']);
  assert.deepEqual(groups[0].entries.map(e => e.review.id), ['b', 'a']);
  assert.deepEqual(groups[0].entries[0].photos.map(p => p.id), ['p1']);
  assert.deepEqual(groups[0].entries[1].photos, []);
  assert.equal(groups[0].label, 'March 2026');
});

test('buildWallSlides: every photo, newest night first, undated entries last', () => {
  const reviews = [review('a', '2026-01-01'), review('b', '2026-05-01'), review('u', null), review('n', '2026-06-01')];
  const rows = [row('pa', 'a', '1'), row('pb1', 'b', '1'), row('pb2', 'b', '2'), row('pu', 'u', '1')];
  const signed = Object.fromEntries(rows.map(r => [r.storage_path, r.id]));
  const slides = buildWallSlides(reviews, groupPhotosByReview(rows, signed));
  assert.deepEqual(slides.map(s => s.photo.id), ['pb1', 'pb2', 'pa', 'pu']);
  assert.ok(slides.every(s => s.review.id === s.photo.reviewId));
});
