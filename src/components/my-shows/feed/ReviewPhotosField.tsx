'use client';

import { useAuth } from '@/contexts/AuthContext';
import { MAX_PHOTOS_PER_REVIEW } from '@/lib/review-photo-model';
import { useFeedPhotos } from './useFeedPhotos';
import { useLocalMockMode, usePhotoUploads } from './usePhotoUploads';
import PhotoThumbRow from './PhotoThumbRow';

/**
 * "Photos" field in RatingEditor for an existing diary entry (BRO-6170),
 * the web twin of the app's PhotoPickerRow. Photos save on their own as
 * soon as they upload; Save/Cancel on the rating don't touch them.
 * Loaded with next/dynamic so the show page only pays for it when editing.
 */
export default function ReviewPhotosField({ reviewId, showTitle }: { reviewId: string; showTitle: string }) {
  const { user } = useAuth();
  const isMockMode = useLocalMockMode();
  const userId = isMockMode ? 'mock-user' : user?.id ?? null;
  const { photosByReview, error, ready, retry } = useFeedPhotos(userId, isMockMode, { reviewId });
  const uploads = usePhotoUploads({ userId, isMockMode, photosByReview, ready });
  if (!userId) return null;

  const photos = photosByReview[reviewId] ?? [];
  const pending = uploads.pendingFor(reviewId);
  const savedIds = new Set(photos.map(p => p.id));
  const total = photos.length + pending.filter(p => !savedIds.has(p.id)).length;

  return (
    <div className="ph-no-capture mb-3" data-testid="review-photos-field">
      <p className="block text-xs font-medium text-gray-400 mb-1">
        Photos <span className="text-fg-muted">({total}/{MAX_PHOTOS_PER_REVIEW})</span>
      </p>
      {error ? (
        <p className="text-xs text-score-tepid">
          Couldn&apos;t load your photos.{' '}
          <button type="button" onClick={retry} className="font-semibold underline underline-offset-2 hover:text-white">Try again</button>
        </p>
      ) : (
        <PhotoThumbRow
          photos={photos}
          pending={pending}
          canAdd={uploads.remainingFor(reviewId) > 0}
          onAddFiles={files => uploads.addFiles(reviewId, files)}
          onRetry={uploads.retry}
          onDismiss={uploads.dismiss}
          onDelete={uploads.deletePhoto}
          notice={uploads.noticeFor(reviewId)}
          title={showTitle}
        />
      )}
      <p className="mt-1 text-xs text-fg-muted">Photos save as soon as they upload. Only you can see them.</p>
    </div>
  );
}
