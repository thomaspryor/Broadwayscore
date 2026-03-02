'use client';

import { useState, useCallback } from 'react';

interface ReviewPanelProps {
  rating: number;
  existingReviewText?: string | null;
  existingDateSeen?: string | null;
  showTitle: string;
  /** Earliest valid date (preview date or opening date) */
  earliestDate?: string | null;
  /** Latest valid date (closing date or today) */
  latestDate?: string | null;
  onSave: (data: { rating: number; reviewText: string | null; dateSeen: string | null }) => void;
  onCancel: () => void;
  saving?: boolean;
}

const MAX_CHARS = 2000;

export default function ReviewPanel({
  rating,
  existingReviewText,
  existingDateSeen,
  showTitle,
  earliestDate,
  latestDate,
  onSave,
  onCancel,
  saving = false,
}: ReviewPanelProps) {
  const [reviewText, setReviewText] = useState(existingReviewText || '');
  const [dateSeen, setDateSeen] = useState(existingDateSeen || '');

  const charsRemaining = MAX_CHARS - reviewText.length;
  const isOverLimit = charsRemaining < 0;

  const handleSave = useCallback(() => {
    if (isOverLimit || saving) return;
    onSave({
      rating,
      reviewText: reviewText.trim() || null,
      dateSeen: dateSeen || null,
    });
  }, [rating, reviewText, dateSeen, isOverLimit, saving, onSave]);

  // Compute date constraints
  const today = new Date().toISOString().split('T')[0];
  const minDate = earliestDate || undefined;
  const maxDate = latestDate || today;

  return (
    <div className="mt-3 p-4 rounded-xl bg-white/[0.03] border border-white/[0.06]">
      {/* Rating display */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm text-gray-400">Your rating for</span>
        <span className="text-sm font-semibold text-white truncate">{showTitle}</span>
        <span className="text-sm font-bold text-amber-400">{rating.toFixed(1)}</span>
      </div>

      {/* Date seen (optional) */}
      <div className="mb-3">
        <label className="block text-xs font-medium text-gray-400 mb-1">
          Date Seen <span className="text-gray-600">(optional)</span>
        </label>
        <input
          type="date"
          value={dateSeen}
          onChange={e => setDateSeen(e.target.value)}
          min={minDate}
          max={maxDate}
          className="w-full sm:w-48 px-3 py-2 text-sm bg-white/[0.05] border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30"
        />
      </div>

      {/* Notes textarea */}
      <div className="mb-3">
        <label className="block text-xs font-medium text-gray-400 mb-1">
          Private Notes <span className="text-gray-600">(optional)</span>
        </label>
        <textarea
          value={reviewText}
          onChange={e => setReviewText(e.target.value)}
          placeholder="What did you think?"
          rows={3}
          maxLength={MAX_CHARS + 100} // Allow slight overflow to show counter
          className="w-full px-3 py-2 text-sm bg-white/[0.05] border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30 resize-none"
        />
        <div className={`text-right text-xs mt-0.5 ${
          isOverLimit ? 'text-red-400' : charsRemaining < 200 ? 'text-amber-400' : 'text-gray-600'
        }`}>
          {charsRemaining.toLocaleString()} characters remaining
        </div>
      </div>

      {/* Privacy note */}
      <div className="flex items-center gap-1.5 mb-4 text-xs text-gray-500">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <span>Only visible to you</span>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isOverLimit || saving}
          className="px-5 py-2 text-sm font-semibold text-black bg-[#FFD700] rounded-lg hover:bg-[#e6c200] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
