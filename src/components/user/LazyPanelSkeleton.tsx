'use client';

/**
 * Placeholders shown while a lazily loaded panel's chunk downloads (BRO-7494),
 * so a first tap on a slow network gets instant feedback and the layout doesn't
 * collapse then jump when the real panel arrives.
 *
 * Deliberately tiny and dependency-free: it ships in the show page's first-load
 * JS, so it must not pull in Modal or the editor itself. RatingEditor heights
 * (419px inline card at 1280px, 507px sheet content at 390px) were measured in
 * Playwright on a fresh, signed-out panel; tests/e2e/lazy-panel-guard.spec.ts
 * fails if the desktop skeleton drifts more than 24px from the real editor.
 * PlanSheet's 380px is estimated from its layout (the sheet needs a signed-in
 * watchlist entry, which the e2e browser can't create).
 */

function Bar({ className }: { className: string }) {
  return <div className={`rounded bg-white/10 ${className}`} />;
}

/** Same rows as RatingEditor's content: title, stars, date, notes, extras, buttons. */
function EditorRows() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      <Bar className="h-4 w-2/3 mb-4" />
      <Bar className="h-9 w-56 mb-5" />
      <Bar className="h-3 w-24 mb-2" />
      <Bar className="h-9 w-full sm:w-48 mb-4" />
      <Bar className="h-20 w-full mb-4" />
      <Bar className="h-8 w-full mb-4" />
      <div className="flex gap-2">
        <Bar className="h-11 flex-1" />
        <Bar className="h-11 flex-1" />
      </div>
    </div>
  );
}

/** Bottom-sheet shell matching Modal's bottomSheet look (phones), centred card from sm up. */
function SheetShell({ children, maxWidth, testId, label, zIndex }: {
  children: React.ReactNode; maxWidth: string; testId: string; label: string; zIndex: number;
}) {
  return (
    <div className="fixed inset-0 flex items-end sm:items-center justify-center" style={{ zIndex }} role="status" aria-label={label} data-testid={testId}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-hidden="true" />
      <div className={`relative w-full ${maxWidth} bg-surface-raised border border-white/10 rounded-t-2xl sm:rounded-2xl pb-[env(safe-area-inset-bottom)] sm:pb-0 shadow-2xl max-h-[85vh] overflow-hidden`}>
        {children}
      </div>
    </div>
  );
}

/**
 * RatingEditor fallback. RatingEditor is an inline card from 640px up and a
 * bottom sheet below, so render both and let CSS pick (no matchMedia flash).
 */
export function RatingEditorSkeleton() {
  return (
    <>
      <div
        className="hidden sm:block mt-3 p-3 sm:p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] min-h-[419px]"
        role="status"
        aria-label="Loading rating editor"
        data-testid="rating-editor-skeleton"
      >
        <EditorRows />
      </div>
      <div className="sm:hidden">
        <SheetShell maxWidth="sm:max-w-md" testId="rating-editor-skeleton-sheet" label="Loading rating editor" zIndex={60}>
          <div className="p-4 min-h-[507px]"><EditorRows /></div>
        </SheetShell>
      </div>
    </>
  );
}

/** PlanSheet fallback: date row, three showtime buttons, calendar + remove. */
export function PlanSheetSkeleton() {
  return (
    <SheetShell maxWidth="sm:max-w-sm" testId="plan-sheet-skeleton" label="Loading your plans" zIndex={100}>
      <div className="p-4 sm:p-5 min-h-[380px] animate-pulse" aria-hidden="true">
        <Bar className="h-5 w-1/2 mb-5" />
        <Bar className="h-11 w-full mb-4" />
        <div className="grid grid-cols-3 gap-2 mb-4">
          <Bar className="h-14" />
          <Bar className="h-14" />
          <Bar className="h-14" />
        </div>
        <Bar className="h-11 w-full mb-3" />
        <Bar className="h-11 w-full" />
      </div>
    </SheetShell>
  );
}
