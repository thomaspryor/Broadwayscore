'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UserReview, ShowLookup } from '@/types/user';
import { useFeedPhotos } from './useFeedPhotos';
import { usePhotoUploads } from './usePhotoUploads';
import { CameraIcon } from './PhotoThumbRow';
import FeedTimeline from './FeedTimeline';
import PhotoWall from './PhotoWall';
import PhotoLightbox from './PhotoLightbox';
import { buildMonthGroups, buildWallSlides, type FeedEntry, type FeedSlide } from './feed-model';
import type { FeedPhoto } from '@/lib/review-photos';

export interface FeedTabProps {
  reviews: UserReview[];
  showMap: Record<string, ShowLookup>;
  userId: string | null;
  isMockMode: boolean;
}

type FeedMode = 'timeline' | 'wall';
const MODE_KEY = 'bsc_feed_mode';

/**
 * My Shows → Feed (BRO-6170): the iOS app's private photo Feed on the web.
 * Two modes, Timeline (month-grouped nights with their photos) and Photo
 * wall (every photo). Photos can be added to any dated entry from the
 * Timeline (or the rating editor) and deleted from the lightbox; they sync
 * with the app through the same table and bucket.
 */
export default function FeedTab({ reviews, showMap, userId, isMockMode }: FeedTabProps) {
  const [mode, setMode] = useState<FeedMode>('timeline');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved === 'timeline' || saved === 'wall') setMode(saved);
    } catch { /* storage unavailable */ }
  }, []);
  const pickMode = useCallback((next: FeedMode) => {
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* ignore */ }
  }, []);

  const { photosByReview, loading, error, ready, retry } = useFeedPhotos(userId, isMockMode);
  const uploads = usePhotoUploads({ userId, isMockMode, photosByReview, ready });
  const groups = useMemo(() => buildMonthGroups(reviews, photosByReview), [reviews, photosByReview]);
  const wallSlides = useMemo(() => buildWallSlides(reviews, photosByReview), [reviews, photosByReview]);
  const undatedCount = useMemo(() => reviews.filter(r => !r.date_seen).length, [reviews]);
  const nightsWithPhotos = useMemo(() => new Set(wallSlides.map(s => s.review.id)).size, [wallSlides]);

  // Lightbox: the timeline steps through one night's photos, the wall through all.
  const [lightbox, setLightbox] = useState<{ slides: FeedSlide[]; index: number } | null>(null);
  const openEntryPhoto = useCallback((entry: FeedEntry, index: number) => {
    setLightbox({ slides: entry.photos.map(photo => ({ photo, review: entry.review })), index });
  }, []);
  const openWallPhoto = useCallback((index: number) => setLightbox({ slides: wallSlides, index }), [wallSlides]);
  const setLightboxIndex = useCallback((index: number) => setLightbox(lb => (lb ? { ...lb, index } : lb)), []);
  const closeLightbox = useCallback(() => setLightbox(null), []);
  // After a delete the lightbox drops that slide (next photo slides in), or
  // closes when it was the last one.
  const deleteFromLightbox = useCallback(async (photo: FeedPhoto) => {
    await uploads.deletePhoto(photo);
    setLightbox(lb => {
      if (!lb) return lb;
      const slides = lb.slides.filter(s => s.photo.id !== photo.id);
      if (slides.length === 0) return null;
      return { slides, index: Math.min(lb.index, slides.length - 1) };
    });
  }, [uploads]);

  const noPhotos = !loading && !error && wallSlides.length === 0;

  return (
    // ph-no-capture: session replays skip the Feed entirely, so private
    // diary photos (and their signed URLs) never reach the recorder.
    <div className="ph-no-capture">
      <div className="flex items-center justify-between gap-3 mb-4">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-overlay text-xs font-semibold text-gray-400" title="Your Feed is private. Nobody else can see it.">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
          Only you
        </span>
        <FeedModeToggle mode={mode} onChange={pickMode} />
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 mb-4 px-3 py-2 rounded-lg bg-score-tepid-bg text-xs text-score-tepid" role="status">
          <span>Couldn&apos;t load your photos.</span>
          <button type="button" onClick={retry} className="font-semibold underline underline-offset-2 hover:text-white">Try again</button>
        </div>
      )}

      {mode === 'timeline' ? (
        groups.length === 0 ? (
          <EmptyState
            title="Your Feed is empty"
            body="Rate a show with the date you saw it and it lands here, month by month."
          />
        ) : (
          <>
            {noPhotos && <AppPhotoHint className="mb-4" />}
            <FeedTimeline groups={groups} showMap={showMap} onOpenPhoto={openEntryPhoto} uploads={uploads} />
            {undatedCount > 0 && (
              <p className="mt-2 text-xs text-fg-muted text-center">
                {undatedCount} {undatedCount === 1 ? 'entry has' : 'entries have'} no date seen, so {undatedCount === 1 ? 'it isn’t' : 'they aren’t'} on the timeline.
              </p>
            )}
          </>
        )
      ) : loading && wallSlides.length === 0 ? (
        <div className="-mx-4 sm:mx-0 grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-0.5 sm:gap-1.5" aria-hidden="true">
          {Array.from({ length: 10 }, (_, i) => <div key={i} className="aspect-square sm:rounded-lg bg-white/5 animate-pulse" />)}
        </div>
      ) : wallSlides.length === 0 ? (
        <EmptyState
          title="No photos yet"
          body={groups.length > 0
            ? 'Add photos from the night to any diary entry. Open the Timeline and tap “Add a photo” on an entry.'
            : 'Rate a show with the date you saw it, then add photos from the night to that entry.'}
          icon="camera"
          action={groups.length > 0 ? { label: 'Go to Timeline', onClick: () => pickMode('timeline') } : undefined}
        />
      ) : (
        <>
          <p className="mb-3 text-xs text-fg-muted">
            {wallSlides.length} {wallSlides.length === 1 ? 'photo' : 'photos'} from {nightsWithPhotos} {nightsWithPhotos === 1 ? 'night' : 'nights'}
          </p>
          <PhotoWall slides={wallSlides} showMap={showMap} onOpen={openWallPhoto} />
        </>
      )}

      <PhotoLightbox
        slides={lightbox?.slides ?? []}
        index={lightbox?.index ?? null}
        showMap={showMap}
        onIndexChange={setLightboxIndex}
        onClose={closeLightbox}
        onDelete={deleteFromLightbox}
      />
    </div>
  );
}

const MODES: { key: FeedMode; label: string }[] = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'wall', label: 'Photo wall' },
];

/** Same shell as the page's ViewModeToggle (toolbar height, inset ring), with text labels. */
function FeedModeToggle({ mode, onChange }: { mode: FeedMode; onChange: (m: FeedMode) => void }) {
  return (
    <div className="inline-flex items-stretch flex-shrink-0 h-11 sm:h-9 rounded-badge overflow-hidden bg-white/[0.06] ring-1 ring-inset ring-white/10" role="group" aria-label="Feed view">
      {MODES.map(opt => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          aria-pressed={mode === opt.key}
          className={`px-3.5 text-xs sm:text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand transition-colors ${
            mode === opt.key ? 'bg-white/[0.15] text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function AppPhotoHint({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-white/[0.02] border border-white/[0.06] text-xs text-gray-400 ${className}`}>
      <CameraIcon className="w-4 h-4 flex-shrink-0 text-brand" />
      <span>Add photos from the night to any entry below. Photos added in the iPhone app show up here too.</span>
    </div>
  );
}

function EmptyState({ title, body, icon = 'calendar', action }: {
  title: string;
  body: string;
  icon?: 'calendar' | 'camera';
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center text-center py-12 px-6 rounded-xl bg-white/[0.02] border border-white/[0.06]">
      <span className="flex items-center justify-center w-12 h-12 mb-3 rounded-full bg-surface-overlay text-brand">
        {icon === 'camera' ? (
          <CameraIcon className="w-6 h-6" />
        ) : (
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" />
          </svg>
        )}
      </span>
      <h3 className="text-base font-bold text-white">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-gray-400">{body}</p>
      {action && (
        <button type="button" onClick={action.onClick} className="btn-secondary text-sm mt-4">
          {action.label}
        </button>
      )}
    </div>
  );
}
