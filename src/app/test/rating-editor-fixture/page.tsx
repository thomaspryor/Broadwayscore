'use client';

import { useState, useCallback, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import RatingEditor, { type RatingEditorSaveData } from '@/components/user/RatingEditor';
import StarRating from '@/components/user/StarRating';
import Modal from '@/components/show-cards/Modal';

/**
 * Interactive test fixture for RatingEditor (the shared rating editor).
 * Local-state callbacks only — no Supabase, no auth. Playwright-only.
 *
 * Query params:
 *   ?state=new   (default) — fresh rating, no reviewId
 *   ?state=edit  — editing review r1 (rating 4.5, note + date pre-filled)
 *   ?fail=1      — onSave rejects, exercising the failed-save-keeps-text path
 *   ?stars=N     — initial rating for the new state
 *   ?suggestDelayed=YYYY-MM-DD — suggestedDateSeen arrives 800ms AFTER mount,
 *     mirroring the production race where ?rate=1 opens the editor before the
 *     watchlist fetch (source of the planned date) resolves (owner bug, 2026-07-17)
 *
 * Rendered inline (presentation="inline") so tests are deterministic across widths.
 */
function RatingEditorFixtureInner() {
  const sp = useSearchParams();
  const state = sp.get('state') || 'new';
  const fail = sp.get('fail') === '1';
  const starsParam = sp.get('stars');
  // ?presentation=modal renders the Modal path INSIDE the .card wrapper —
  // regression fixture for the contain:layout containment trap (2026-07-05).
  const presentation = sp.get('presentation') === 'modal' ? 'modal' as const : 'inline' as const;
  // ?stack=1 opens a second shared Modal over the editor's modal — regression
  // fixture for topmost-only Escape (stacked sign-in over editor, 2026-07-11).
  const stack = sp.get('stack') === '1';
  // ?authgate=1 mirrors the production anonymous-save flow: Save resolves
  // 'auth-gated' and opens the stacked modal. Critically this toggles the
  // editor's `saving` state, which re-attaches its Escape listener AFTER the
  // stacked modal's — the listener-order scenario that broke stacked Escape
  // in production while mount-order fixtures stayed green (2026-07-11).
  const authGate = sp.get('authgate') === '1';
  const isEdit = state === 'edit';

  const [open, setOpen] = useState(true);
  const [stackOpen, setStackOpen] = useState(stack);
  const [saved, setSaved] = useState<RatingEditorSaveData | null>(null);

  // ?suggestDelayed — the suggestion starts null and lands after the editor
  // has already mounted, like the real watchlist fetch does.
  const suggestDelayed = sp.get('suggestDelayed');
  const [suggestedDateSeen, setSuggestedDateSeen] = useState<string | null>(null);
  useEffect(() => {
    if (!suggestDelayed) return;
    const t = setTimeout(() => setSuggestedDateSeen(suggestDelayed), 800);
    return () => clearTimeout(t);
  }, [suggestDelayed]);

  const handleSave = useCallback(async (data: RatingEditorSaveData): Promise<void | 'auth-gated'> => {
    if (fail) throw new Error('Simulated network failure.');
    if (authGate) {
      setStackOpen(true);
      return 'auth-gated';
    }
    setSaved(data);
  }, [fail, authGate]);

  return (
    <div className="min-h-screen bg-surface text-white" data-testid="rating-editor-fixture">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-xl font-bold mb-2">Hamilton</h1>
        <p className="text-sm text-gray-500 mb-4">Richard Rodgers Theatre</p>

        <div className="card p-5" data-testid="editor-card">
          {open ? (
            <RatingEditor
              presentation={presentation}
              showTitle="Hamilton"
              reviewId={isEdit ? 'r1' : undefined}
              initialRating={isEdit ? 4.5 : starsParam ? parseFloat(starsParam) : 0}
              initialReviewText={isEdit ? 'Incredible show!' : null}
              initialDateSeen={isEdit ? '2024-11-15' : null}
              suggestedDateSeen={suggestedDateSeen}
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
              className="btn-primary text-sm"
            >
              Rate it
            </button>
          )}
        </div>

        {stackOpen && (
          <Modal isOpen onClose={() => setStackOpen(false)} zIndex={80} maxWidth="sm" ariaLabel="Stacked test modal">
            <div className="p-6" data-testid="stacked-modal">Second modal (topmost)</div>
          </Modal>
        )}

        {saved && (
          <div className="mt-4 text-xs text-gray-400" data-testid="last-saved">
            saved:{saved.rating}:{saved.reviewText ?? ''}:{saved.dateSeen ?? ''}:{saved.reviewId ?? ''}
          </div>
        )}

        {/* Star size showcase — half-stars at every size, catches SVG clipPath
            rendering regressions (baseline-screenshotted in ugc-visual-baselines). */}
        <div className="mt-8" data-testid="star-showcase">
          <h2 className="text-sm font-bold text-gray-400 mb-3">Half-Star Rendering (all sizes)</h2>
          {(['xs', 'sm', 'md', 'lg'] as const).map(size => (
            <div key={size} className="flex items-center gap-3 mb-2">
              <span className="text-xs text-gray-500 w-8">{size}</span>
              <StarRating rating={3.5} onRatingChange={() => {}} size={size} readOnly hideLabel />
            </div>
          ))}
        </div>
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
