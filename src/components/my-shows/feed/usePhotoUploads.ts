'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PhotoError,
  deleteReviewPhoto,
  emitReviewPhotosChanged,
  prepareReviewPhoto,
  uploadReviewPhoto,
  type FeedPhoto,
} from '@/lib/review-photos';
import { newPhotoId, photoFileProblem, remainingPhotoSlots, splitByPhotoLimit, MAX_PHOTOS_PER_REVIEW } from '@/lib/review-photo-model';

export type PendingPhotoStatus = 'uploading' | 'failed' | 'done';

/** A photo picked in this browser that isn't (yet) in the saved list. */
export interface PendingPhoto {
  id: string; // becomes the row id and file name
  reviewId: string;
  file: File;
  previewUrl: string;
  status: PendingPhotoStatus;
  error: string | null;
}

export interface PhotoUploads {
  /** Pending photos for one entry, in pick order. */
  pendingFor: (reviewId: string) => PendingPhoto[];
  /** Free slots on one entry, counting saved and pending photos. */
  remainingFor: (reviewId: string) => number;
  /** A one-line note for the entry ("Only 6 photos per entry…"), or null. */
  noticeFor: (reviewId: string) => string | null;
  addFiles: (reviewId: string, files: File[]) => void;
  retry: (pendingId: string) => void;
  dismiss: (pendingId: string) => void;
  deletePhoto: (photo: FeedPhoto) => Promise<void>;
}

/** Saved photos plus pending ones not yet in the saved list each hold a slot. */
function slotsLeft(saved: Record<string, FeedPhoto[]>, pending: PendingPhoto[], reviewId: string): number {
  const list = saved[reviewId] ?? [];
  const savedIds = new Set(list.map(p => p.id));
  const waiting = pending.filter(p => p.reviewId === reviewId && !savedIds.has(p.id)).length;
  return remainingPhotoSlots(list.length, waiting);
}

const GENERIC_UPLOAD_ERROR = 'Couldn’t upload this photo. Try again.';

/**
 * localhost + ?mock=1 / ?mock=large, the same switch MyShowsClient uses for
 * its mock data. Read after mount (static export: no window during SSG).
 */
export function useLocalMockMode(): boolean {
  const [mock, setMock] = useState(false);
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get('mock');
    setMock(window.location.hostname === 'localhost' && (m === '1' || m === 'large'));
  }, []);
  return mock;
}

/**
 * Upload queue + delete for diary photos (BRO-6170). Uploads run one at a
 * time (each decode holds a full-size bitmap in memory). A finished upload
 * stays listed as 'done' until the refreshed photo list contains it, so the
 * thumbnail never blinks out between upload and refresh.
 *
 * Mock mode never calls Supabase: the real canvas re-encode runs, then the
 * result is stored as an object URL in the dev mock store. `&mockupload=hold`
 * keeps uploads spinning forever and `&mockupload=fail` fails each photo's
 * first attempt (Retry then succeeds), for screenshots of those states.
 */
export function usePhotoUploads({ userId, isMockMode, photosByReview, ready = true }: {
  userId: string | null;
  isMockMode: boolean;
  photosByReview: Record<string, FeedPhoto[]>;
  /** False until the saved photos have loaded: no free slots are offered before then. */
  ready?: boolean;
}): PhotoUploads {
  const [pending, setPendingState] = useState<PendingPhoto[]>([]);
  const pendingRef = useRef<PendingPhoto[]>([]);
  const setPending = useCallback((next: (prev: PendingPhoto[]) => PendingPhoto[]) => {
    pendingRef.current = next(pendingRef.current);
    setPendingState(pendingRef.current);
  }, []);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mockAttempts = useRef(new Map<string, number>());
  const savedRef = useRef(photosByReview);
  savedRef.current = photosByReview;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const patch = useCallback((id: string, fields: Partial<PendingPhoto>) => {
    setPending(prev => prev.map(p => (p.id === id ? { ...p, ...fields } : p)));
  }, [setPending]);

  const mockUpload = useCallback(async (item: PendingPhoto) => {
    const mode = new URLSearchParams(window.location.search).get('mockupload');
    const prepared = await prepareReviewPhoto(item.file);
    if (mode === 'hold') await new Promise<never>(() => {});
    await new Promise(r => setTimeout(r, 900));
    const attempt = (mockAttempts.current.get(item.id) ?? 0) + 1;
    mockAttempts.current.set(item.id, attempt);
    if (mode === 'fail' && attempt === 1) throw new PhotoError('Couldn’t upload. Check your connection and try again.');
    const mod = await import('./__dev-mock-photos');
    mod.addMockPhoto({
      id: item.id,
      reviewId: item.reviewId,
      storagePath: '',
      url: URL.createObjectURL(prepared.blob),
      width: prepared.width,
      height: prepared.height,
      takenAt: null,
      createdAt: new Date().toISOString(),
    });
  }, []);

  const run = useCallback(async (id: string) => {
    const item = pendingRef.current.find(p => p.id === id);
    if (!item || item.status !== 'uploading') return;
    try {
      if (isMockMode) await mockUpload(item);
      else {
        if (!userId) throw new PhotoError('Sign in to add photos.');
        await uploadReviewPhoto({ userId, reviewId: item.reviewId, photoId: item.id, file: item.file });
      }
      patch(id, { status: 'done', error: null });
      emitReviewPhotosChanged(item.reviewId);
    } catch (e) {
      patch(id, { status: 'failed', error: e instanceof PhotoError ? e.message : GENERIC_UPLOAD_ERROR });
    }
  }, [isMockMode, userId, mockUpload, patch]);

  const enqueue = useCallback((id: string) => {
    queue.current = queue.current.then(() => run(id)).catch(() => {});
  }, [run]);

  const remainingFor = useCallback(
    (reviewId: string) => (ready ? slotsLeft(photosByReview, pending, reviewId) : 0),
    [photosByReview, pending, ready],
  );

  const addFiles = useCallback((reviewId: string, files: File[]) => {
    if (files.length === 0 || !readyRef.current) return;
    const problems = files.map(f => photoFileProblem(f));
    const usable = files.filter((_, i) => !problems[i]);
    // Refs, not state: two quick picks in a row must see each other.
    const { accepted, overLimit } = splitByPhotoLimit(usable, slotsLeft(savedRef.current, pendingRef.current, reviewId));
    const firstProblem = problems.find(Boolean);
    const notice = overLimit > 0
      ? `Up to ${MAX_PHOTOS_PER_REVIEW} photos per entry. ${accepted.length > 0 ? `Added the first ${accepted.length}.` : 'Delete one to add another.'}`
      : firstProblem ?? null;
    setNotices(prev => {
      const next = { ...prev };
      if (notice) next[reviewId] = notice; else delete next[reviewId];
      return next;
    });
    if (accepted.length === 0) return;
    const items: PendingPhoto[] = accepted.map(file => ({
      id: newPhotoId(),
      reviewId,
      file,
      previewUrl: URL.createObjectURL(file),
      status: 'uploading',
      error: null,
    }));
    setPending(prev => [...prev, ...items]);
    for (const item of items) enqueue(item.id);
  }, [setPending, enqueue]);

  const retry = useCallback((id: string) => {
    patch(id, { status: 'uploading', error: null });
    enqueue(id);
  }, [patch, enqueue]);

  const dismiss = useCallback((id: string) => {
    setPending(prev => {
      const gone = prev.find(p => p.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter(p => p.id !== id);
    });
  }, [setPending]);

  const deletePhoto = useCallback(async (photo: FeedPhoto) => {
    if (isMockMode) {
      await new Promise(r => setTimeout(r, 400));
      const mod = await import('./__dev-mock-photos');
      mod.removeMockPhoto(photo.id);
    } else {
      await deleteReviewPhoto(photo);
    }
    setNotices(prev => {
      if (!prev[photo.reviewId]) return prev;
      const next = { ...prev };
      delete next[photo.reviewId];
      return next;
    });
    emitReviewPhotosChanged(photo.reviewId);
  }, [isMockMode]);

  // A 'done' upload leaves the pending list once the saved list has it.
  useEffect(() => {
    const savedIds = new Set(Object.values(photosByReview).flat().map(p => p.id));
    if (!pendingRef.current.some(p => p.status === 'done' && savedIds.has(p.id))) return;
    setPending(prev => prev.filter(p => {
      const landed = p.status === 'done' && savedIds.has(p.id);
      if (landed) URL.revokeObjectURL(p.previewUrl);
      return !landed;
    }));
  }, [photosByReview, setPending]);

  useEffect(() => () => {
    for (const p of pendingRef.current) URL.revokeObjectURL(p.previewUrl);
  }, []);

  const pendingFor = useCallback(
    (reviewId: string) => pending.filter(p => p.reviewId === reviewId),
    [pending],
  );
  const noticeFor = useCallback((reviewId: string) => notices[reviewId] ?? null, [notices]);

  return { pendingFor, remainingFor, noticeFor, addFiles, retry, dismiss, deletePhoto };
}
