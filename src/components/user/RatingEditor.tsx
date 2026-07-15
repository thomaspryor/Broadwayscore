'use client';

import { useState, useCallback, useEffect } from 'react';
import Modal from '@/components/show-cards/Modal';
import StarRating from './StarRating';
import { sanitizeRating } from '@/lib/rating';
import DatePickerButton from './DatePickerButton';

export interface RatingEditorSaveData {
  rating: number;
  reviewText: string | null;
  dateSeen: string | null;
  /** Present → edit/replace this review; absent → append a new viewing. */
  reviewId?: string;
}

interface RatingEditorProps {
  showTitle: string;
  /** Existing review id when editing/replacing; omit to append a new viewing. */
  reviewId?: string;
  /** Stars to open with (the star the user tapped, or an existing review's rating). */
  initialRating: number;
  initialReviewText?: string | null;
  initialDateSeen?: string | null;
  /** Pre-fill Date Seen for brand-new ratings (e.g. watchlist planned date). */
  suggestedDateSeen?: string | null;
  /** 'new' first viewing, 'edit' amend latest, 'replace' overwrite the single rating, 'append' log another. */
  mode?: 'new' | 'edit' | 'replace' | 'append';
  /**
   * Persist the rating. MUST throw on failure — the editor stays open with the
   * typed text intact and shows an inline error + Retry. Resolve on success.
   * Resolve with 'auth-gated' when the save was deferred to a sign-in flow:
   * the editor stays open (draft visible behind the sign-in modal), no error.
   */
  onSave: (data: RatingEditorSaveData) => Promise<void | 'auth-gated'>;
  /** Called after a successful save so the parent can close the editor. */
  onSaved: () => void;
  onCancel: () => void;
  /** Optional delete affordance, shown only when editing an existing review. */
  onDelete?: () => void;
  /** Force a presentation; default 'auto' = bottom-sheet on mobile, inline card on desktop. */
  presentation?: 'auto' | 'inline' | 'modal';
}

const MAX_CHARS = 2000;

/** Today in the viewer's local timezone as YYYY-MM-DD (not UTC — avoids off-by-one). */
function localToday(): string {
  const d = new Date();
  const offsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - offsetMs).toISOString().split('T')[0];
}


const HEADER_COPY: Record<NonNullable<RatingEditorProps['mode']>, string> = {
  new: 'Your rating for',
  edit: 'Editing your rating for',
  replace: 'Re-rating',
  append: 'Log another viewing of',
};

export default function RatingEditor({
  showTitle,
  reviewId,
  initialRating,
  initialReviewText,
  initialDateSeen,
  suggestedDateSeen,
  mode = reviewId ? 'edit' : 'new',
  onSave,
  onSaved,
  onCancel,
  onDelete,
  presentation = 'auto',
}: RatingEditorProps) {
  const today = localToday();
  // Cap only at today. Do NOT cap at the show's closing date: users log return
  // engagements/Encores runs against the same entry, and diary imports can map
  // a viewing to an earlier production — the closing-date cap anchored the
  // native picker years in the past and read as "completely locked"
  // (La Cage aux Folles report, 2026-07-13).
  const maxDate = today;

  const [rating, setRating] = useState<number>(() => sanitizeRating(initialRating));
  const [reviewText, setReviewText] = useState<string>(initialReviewText || '');
  const [dateSeen, setDateSeen] = useState<string>(() => {
    // Editing keeps the review's stored date (may be empty). New viewings default
    // to today (local), unless a watchlist planned-date was supplied — never past
    // the cap (e.g. a show that closed years ago).
    if (reviewId) return initialDateSeen || '';
    const fallback = initialDateSeen || suggestedDateSeen || today;
    return fallback > maxDate ? maxDate : fallback;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live hover value from the stars — previewed in the big number so half-star
  // targeting is legible before the click (owner report, 2026-07-13).
  const [hoverValue, setHoverValue] = useState<number | null>(null);

  const [isDesktop, setIsDesktop] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches,
  );
  // Track viewport changes (rotate / window resize) so the presentation doesn't
  // go stale mid-edit — the two branches differ structurally (scroll lock etc.).
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const charsRemaining = MAX_CHARS - reviewText.length;
  const isOverLimit = charsRemaining < 0;

  const handleSave = useCallback(async () => {
    if (saving || isOverLimit || rating < 0.5 || rating > 5) return;
    setSaving(true);
    setError(null);
    try {
      const result = await onSave({
        rating: sanitizeRating(rating),
        reviewText: reviewText.trim() || null,
        dateSeen: dateSeen || null,
        reviewId,
      });
      if (result === 'auth-gated') {
        // Save deferred to sign-in: keep the editor (and the typed draft)
        // visible behind the sign-in modal so cancelling auth loses nothing.
        setSaving(false);
        return;
      }
      onSaved();
    } catch (e) {
      // Failed save keeps the editor open with the typed text intact.
      setError(e instanceof Error && e.message ? e.message : 'Could not save. Please try again.');
      setSaving(false);
    }
  }, [saving, isOverLimit, rating, reviewText, dateSeen, reviewId, onSave, onSaved]);

  const content = (
    <div data-testid="rating-editor" className="overflow-hidden">
      {/* Title */}
      <div className="flex items-baseline gap-2 mb-3 min-w-0">
        <span className="text-sm text-gray-400 shrink-0">{HEADER_COPY[mode]}</span>
        <span className="text-sm font-semibold text-white truncate min-w-0">{showTitle}</span>
      </div>

      {/* Adjustable stars — the core fix (editor no longer opens locked at 5.0).
          While hovering, the big number previews the would-be value (slightly
          dimmer) so left-half = X.5 / right-half = X.0 is legible pre-click. */}
      <div className="flex items-center gap-3 mb-4">
        <StarRating rating={rating > 0 ? rating : null} onRatingChange={setRating} onHoverChange={setHoverValue} size="lg" hideLabel />
        {(hoverValue ?? rating) >= 0.5 ? (
          <span
            className={`text-lg font-bold tabular-nums ${hoverValue !== null ? 'text-amber-300/80' : 'text-amber-400'}`}
            data-testid="rating-value"
          >
            {(hoverValue ?? rating).toFixed(1)}
          </span>
        ) : (
          <span className="text-xs text-gray-500" data-testid="pick-stars-hint">Tap a star to rate</span>
        )}
      </div>

      {/* Date Seen */}
      <div className="mb-3">
        <label className="block text-xs font-medium text-gray-400 mb-1">
          Date Seen <span className="text-gray-600">(optional)</span>
        </label>
        <DatePickerButton
          value={dateSeen}
          onChange={setDateSeen}
          min="1950-01-01"
          max={maxDate}
          ariaLabel="Date seen"
          wrapClassName="relative w-full sm:w-48"
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm bg-white/[0.05] border border-white/10 rounded-lg focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30 transition-colors ${dateSeen ? 'text-white pr-9' : 'text-gray-500'}`}
          onClear={() => setDateSeen('')}
        >
          <svg className="w-4 h-4 shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span data-testid="date-seen-display">
            {dateSeen
              ? new Date(dateSeen + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              : 'Add a date'}
          </span>
        </DatePickerButton>
      </div>

      {/* Private notes */}
      <div className="mb-3">
        <label className="block text-xs font-medium text-gray-400 mb-1">
          Private Notes <span className="text-gray-600">(optional)</span>
        </label>
        <textarea
          value={reviewText}
          onChange={e => setReviewText(e.target.value)}
          placeholder="What did you think?"
          rows={3}
          maxLength={MAX_CHARS + 100}
          className="w-full px-3 py-2 text-sm bg-white/[0.05] border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30 resize-none"
        />
        <div className="flex items-center justify-between mt-0.5">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span>Only visible to you</span>
          </div>
          <span className={`text-xs ${isOverLimit ? 'text-red-400' : charsRemaining < 200 ? 'text-amber-400' : 'text-gray-600'}`}>
            {charsRemaining.toLocaleString()} left
          </span>
        </div>
      </div>

      {/* Inline error — save failed, nothing was lost */}
      {error && (
        <div role="alert" className="mb-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-score-skip/10 border border-score-skip/20 text-xs text-score-skip">
          <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.33 16a2 2 0 001.74 3z" />
          </svg>
          <span>{error} Your note wasn&apos;t lost — tap Retry.</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={isOverLimit || saving || rating < 0.5}
          className="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : error ? 'Retry' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
        {onDelete && reviewId && (
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            className="ml-auto text-xs text-score-skip/80 hover:text-score-skip transition-colors px-2 py-1"
          >
            Delete this rating
          </button>
        )}
      </div>
    </div>
  );

  const asInline = presentation === 'inline' || (presentation === 'auto' && isDesktop);

  if (asInline) {
    return (
      <div className="mt-3 p-3 sm:p-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
        {content}
      </div>
    );
  }

  return (
    <Modal
      isOpen
      onClose={onCancel}
      bottomSheet
      maxWidth="md"
      // Below SignInModal's z=80: the auth-gated flow opens sign-in ON TOP of
      // this editor, and the editor's backdrop must not cover the sign-in
      // dialog or intercept its clicks.
      zIndex={60}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      ariaLabel={`Rate ${showTitle}`}
    >
      <div className="p-4 sm:p-5">{content}</div>
    </Modal>
  );
}
