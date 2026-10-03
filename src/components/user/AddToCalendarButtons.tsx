'use client';

import { useState, type MouseEvent } from 'react';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import { upcomingRowDate } from '@/components/user/upcoming-cards';
import { featureFlags } from '@/config/feature-flags';
import { buildGoogleCalendarUrl, encodeEventParams } from '@/lib/calendar';
import { isCalendarEventOffered } from '@/lib/calendar-route-gate';
import type { PerformanceEvent } from '@/lib/calendar';

export type CalendarMethod = 'ics' | 'google';

interface AddToCalendarButtonsProps {
  /** Null when there's no date+time yet — the caller resolves this via
   *  buildPlannedShowEvent and skips rendering rather than passing null in loop. */
  event: PerformanceEvent | null;
  /** Full-width button whose label may wrap to two lines, for narrow slots
   *  (the ~100px grid card, the date column of a list row). Omit on wider
   *  surfaces for the one-line icon + label button. */
  compact?: boolean;
  /** Called when a calendar is chosen in the sheet (analytics). */
  onAdd?: (method: CalendarMethod) => void;
}

/**
 * "Add to calendar" for a planned show: a labeled btn-secondary that opens a
 * bottom sheet with Apple (.ics via /api/calendar.ics) and Google (template
 * URL). Replaced a bare 16px calendar icon that nobody could read as "add to
 * calendar" and that was too small to tap (owner, 2026-10-02, BRO-4481).
 * Every trigger is at least 44px tall.
 *
 * Shown under the same rule /api/calendar.ics serves by
 * (src/lib/calendar-route-gate.ts): all-day events always (Shared Plans,
 * BRO-4481, shares dates only), timed events only with
 * featureFlags.calendarExport (still demo-only — see that flag's doc). The
 * rule lives here, not in each caller, so no page can show a button whose
 * download 404s.
 */
export default function AddToCalendarButtons({ event, compact, onAdd }: AddToCalendarButtonsProps) {
  const [open, setOpen] = useState(false);
  if (!event) return null;
  if (!isCalendarEventOffered(event, featureFlags.calendarExport)) return null;

  const openSheet = (e: MouseEvent) => {
    // Some callers sit inside a card link; this tap must not navigate.
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        className={compact
          ? 'btn btn-secondary w-full min-h-[44px] px-1.5 py-1 text-xs leading-tight'
          : 'btn btn-secondary h-11 px-3 gap-1.5 text-sm'}
        aria-haspopup="dialog"
        aria-label={`Add ${event.title} on ${upcomingRowDate(event.date)} to your calendar`}
        data-testid="add-to-calendar"
      >
        {!compact && <CalendarPlusIcon className="w-4 h-4 shrink-0" />}
        Add to calendar
      </button>
      <CalendarSheet event={event} isOpen={open} onClose={() => setOpen(false)} onAdd={onAdd} />
    </>
  );
}

function CalendarSheet({ event, isOpen, onClose, onAdd }: {
  event: PerformanceEvent;
  isOpen: boolean;
  onClose: () => void;
  onAdd?: (method: CalendarMethod) => void;
}) {
  const icsHref = `/api/calendar.ics?${encodeEventParams(event).toString()}`;
  // Close AFTER the link's own navigation: unmounting the <a> inside its click
  // handler can cancel the download / new tab.
  const chose = (method: CalendarMethod) => () => {
    onAdd?.(method);
    setTimeout(onClose, 0);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="sm" bottomSheet ariaLabel="Add to your calendar">
      <div className="p-card-lg" data-testid="calendar-sheet">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="text-lg font-bold text-white">Add to your calendar</h2>
          <ModalCloseButton onClick={onClose} />
        </div>
        <p className="text-sm text-gray-400 mb-5">
          <span className="text-white font-semibold">{event.title}</span>
          {' · '}{upcomingRowDate(event.date)}
        </p>
        <div className="space-y-2">
          <a href={icsHref} onClick={chose('ics')} className="btn btn-secondary w-full h-12" data-testid="calendar-sheet-apple">
            Apple Calendar
          </a>
          <a href={buildGoogleCalendarUrl(event)} target="_blank" rel="noopener noreferrer" onClick={chose('google')} className="btn btn-secondary w-full h-12" data-testid="calendar-sheet-google">
            Google Calendar
          </a>
        </div>
        <p className="text-xs text-gray-500 mt-3">Outlook or another app? Choose Apple Calendar. It saves a file any calendar can open.</p>
      </div>
    </Modal>
  );
}

function CalendarPlusIcon({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 13v4m-2-2h4" />
    </svg>
  );
}
