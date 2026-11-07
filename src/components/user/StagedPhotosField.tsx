'use client';

import { useEffect, useRef, useState } from 'react';
import { MAX_PHOTOS_PER_REVIEW, photoFileProblem, splitByPhotoLimit } from '@/lib/review-photo-model';
import type { FeedPhoto } from '@/lib/review-photos';
import PhotoThumbRow from '@/components/my-shows/feed/PhotoThumbRow';
import { newPhotoId } from '@/lib/review-photo-model';

/**
 * "Photos" field for a BRAND-NEW rating (BRO-6963, app parity). The review
 * row doesn't exist yet (user_review_photos.review_id is a FK), so picked
 * files are only held here as previews; RatingEditor hands them to the
 * caller with the save data and the caller uploads them once the review has
 * an id. Existing entries keep using ReviewPhotosField.
 */
export default function StagedPhotosField({ files, onChange, showTitle }: {
  files: File[];
  onChange: (files: File[]) => void;
  showTitle: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const previews = useRef(new Map<File, string>());
  const ids = useRef(new WeakMap<File, string>());
  const idFor = (file: File) => {
    let id = ids.current.get(file);
    if (!id) { id = newPhotoId(); ids.current.set(file, id); }
    return id;
  };

  const urlFor = (file: File) => {
    let url = previews.current.get(file);
    if (!url) { url = URL.createObjectURL(file); previews.current.set(file, url); }
    return url;
  };

  useEffect(() => () => { previews.current.forEach(u => URL.revokeObjectURL(u)); previews.current.clear(); }, []);

  const photos: FeedPhoto[] = files.map(file => ({
    id: idFor(file),
    reviewId: '',
    storagePath: '',
    url: urlFor(file),
    width: null,
    height: null,
    takenAt: null,
    createdAt: '',
  }));

  const addFiles = (picked: File[]) => {
    const problem = picked.map(photoFileProblem).find(Boolean) ?? null;
    const usable = picked.filter(f => !photoFileProblem(f));
    const { accepted, overLimit } = splitByPhotoLimit(usable, MAX_PHOTOS_PER_REVIEW - files.length);
    setNotice(overLimit > 0 ? `Only ${MAX_PHOTOS_PER_REVIEW} photos per entry. ${overLimit} not added.` : problem);
    if (accepted.length) onChange([...files, ...accepted]);
  };

  const removePhoto = async (photo: FeedPhoto) => {
    const file = files.find(f => idFor(f) === photo.id);
    if (!file) return;
    const url = previews.current.get(file);
    if (url) { URL.revokeObjectURL(url); previews.current.delete(file); }
    setNotice(null);
    onChange(files.filter(f => f !== file));
  };

  return (
    <div className="ph-no-capture mb-3" data-testid="staged-photos-field">
      <p className="block text-xs font-medium text-gray-400 mb-1">
        Photos <span className="text-fg-muted">({files.length}/{MAX_PHOTOS_PER_REVIEW})</span>
      </p>
      <PhotoThumbRow
        photos={photos}
        pending={[]}
        canAdd={files.length < MAX_PHOTOS_PER_REVIEW}
        onAddFiles={addFiles}
        onRetry={() => {}}
        onDismiss={() => {}}
        onDelete={removePhoto}
        notice={notice}
        title={showTitle}
      />
      <p className="mt-1 text-xs text-fg-muted">Photos upload when you save. Only you can see them.</p>
    </div>
  );
}
