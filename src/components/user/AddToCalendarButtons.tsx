'use client';

import { buildGoogleCalendarUrl, encodeEventParams } from '@/lib/calendar';
import type { PerformanceEvent } from '@/lib/calendar';
import { featureFlags } from '@/config/feature-flags';

interface AddToCalendarButtonsProps {
  /** Null when there's no date+time yet — the caller resolves this via
   *  buildPlannedShowEvent and skips rendering rather than passing null in loop. */
  event: PerformanceEvent | null;
  /** Force the icon-only single link (Apple/.ics only) at every width, for
   *  the ~100px My Shows grid card (narrow regardless of viewport). Omit on
   *  wider surfaces: they get the icon below `sm` and the full Apple+Google
   *  text row at `sm` and up for free — the always-text row squeezed the
   *  show title down to "Gy…" on the My Shows LIST item at 390px (visual QA,
   *  2026-08-17). */
  compact?: boolean;
}

/**
 * Apple (.ics via /api/calendar.ics) + Google (template URL) links for a
 * planned show with a showtime set. Gated on featureFlags.calendarExport —
 * see that flag's doc for why this rides its own kill switch rather than
 * userAccounts. The server route has its own independent gate
 * (CALENDAR_EXPORT_ENABLED); both must be on for Apple to actually work, so
 * this component alone controls visibility, not correctness of the .ics link.
 */
export default function AddToCalendarButtons({ event, compact }: AddToCalendarButtonsProps) {
  if (!featureFlags.calendarExport || !event) return null;

  const icsHref = `/api/calendar.ics?${encodeEventParams(event).toString()}`;
  const icon = (
    <a
      href={icsHref}
      onClick={e => e.stopPropagation()}
      className={`showtime-compact mt-1 w-4 h-4 flex items-center justify-center rounded text-gray-500 hover:text-gray-300 transition-colors ${compact ? '' : 'sm:hidden'}`}
      aria-label="Add to Calendar"
      title="Add to Calendar"
    >
      <CalendarPlusIcon />
    </a>
  );
  if (compact) return icon;

  const googleUrl = buildGoogleCalendarUrl(event);
  const linkClass = 'text-xs text-gray-400 hover:text-gray-200 underline underline-offset-2 decoration-white/20';

  return (
    <>
      <div className="hidden sm:flex items-center gap-2" onClick={e => e.stopPropagation()}>
        <CalendarPlusIcon className="w-3 h-3 text-gray-500 shrink-0" />
        <a href={icsHref} className={linkClass} aria-label="Add to Apple Calendar">Apple</a>
        <a href={googleUrl} target="_blank" rel="noopener noreferrer" className={linkClass} aria-label="Add to Google Calendar">Google</a>
      </div>
      {icon}
    </>
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
