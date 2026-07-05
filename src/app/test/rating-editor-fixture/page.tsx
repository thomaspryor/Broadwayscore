'use client';

import { useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import RatingEditor, { type RatingEditorSaveData } from '@/components/user/RatingEditor';

/**
 * Interactive test fixture for RatingEditor (the shared rating editor).
 * Local-state callbacks only — no Supabase, no auth. Playwright-only.
 *
 * Query params:
 *   ?state=new   (default) — fresh rating, no reviewId
 *   ?state=edit  — editing review r1 (rating 4.5, note + date pre-filled)
 *   ?fail=1      — onSave rejects, exercising the failed-save-keeps-text path
 *   ?closing=YYYY-MM-DD — closingDate (date-cap test)
 *   ?stars=N     — initial rating for the new state
 *
 * Rendered inline (presentation="inline") so tests are deterministic across widths.
 */
function RatingEditorFixtureInner() {
  const sp = useSearchParams();
  const state = sp.get('state') || 'new';
  const fail = sp.get('fail') === '1';
  const closing = sp.get('closing');
  const starsParam = sp.get('stars');
  const isEdit = state === 'edit';

  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState<RatingEditorSaveData | null>(null);

  const handleSave = useCallback(async (data: RatingEditorSaveData) => {
    if (fail) throw new Error('Simulated network failure.');
    setSaved(data);
  }, [fail]);

  return (
    <div className="min-h-screen bg-surface text-white" data-testid="rating-editor-fixture">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-xl font-bold mb-2">Hamilton</h1>
        <p className="text-sm text-gray-500 mb-4">Richard Rodgers Theatre</p>

        <div className="card p-5" data-testid="editor-card">
          {open ? (
            <RatingEditor
              presentation="inline"
              showTitle="Hamilton"
              closingDate={closing}
              reviewId={isEdit ? 'r1' : undefined}
              initialRating={isEdit ? 4.5 : starsParam ? parseFloat(starsParam) : 0}
              initialReviewText={isEdit ? 'Incredible show!' : null}
              initialDateSeen={isEdit ? '2024-11-15' : null}
              mode={isEdit ? 'edit' : 'new'}
              onSave={handleSave}
              onSaved={() => setOpen(false)}
              onCancel={() => setOpen(false)}
              onDelete={isEdit ? () => { setSaved(null); setOpen(false); } : undefined}
            />
          ) : (
            <button
              type="button"
              data-testid="reopen"
              onClick={() => setOpen(true)}
              className="px-4 py-2 text-sm font-semibold text-black bg-[#FFD700] rounded-lg"
            >
              Rate it
            </button>
          )}
        </div>

        {saved && (
          <div className="mt-4 text-xs text-gray-400" data-testid="last-saved">
            saved:{saved.rating}:{saved.reviewText ?? ''}:{saved.dateSeen ?? ''}:{saved.reviewId ?? ''}
          </div>
        )}
      </div>
    </div>
  );
}

export default function RatingEditorFixturePage() {
  return (
    <Suspense fallback={null}>
      <RatingEditorFixtureInner />
    </Suspense>
  );
}
