'use client';

import { useState, useMemo, useEffect } from 'react';
import type { ShowSchedule, WeekSchedule } from '@/lib/data-types';
import TicketLink from '@/components/TicketLink';
import type { TicketLinkData } from '@/lib/ticket-utils';

interface ShowtimesCardProps {
  schedule: ShowSchedule;
  currentMonday: string;
  showStatus: string;
  ticketLinks?: TicketLinkData[];
  showName?: string;
  showId?: string;
  showSlug?: string;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Convert YYYYMMDD to Date */
function parseMonday(yyyymmdd: string): Date {
  return new Date(
    parseInt(yyyymmdd.slice(0, 4)),
    parseInt(yyyymmdd.slice(4, 6)) - 1,
    parseInt(yyyymmdd.slice(6, 8))
  );
}

/** Format date range: "Mar 9–15" or "Mar 30 – Apr 5" */
function formatWeekRange(monday: Date): string {
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const monMonth = monday.toLocaleDateString('en-US', { month: 'short' });
  const sunMonth = sunday.toLocaleDateString('en-US', { month: 'short' });
  if (monMonth === sunMonth) {
    return `${monMonth} ${monday.getDate()}–${sunday.getDate()}`;
  }
  return `${monMonth} ${monday.getDate()} – ${sunMonth} ${sunday.getDate()}`;
}

/** Convert "14:00" → "2:00 PM" */
function formatTime(time24: string): string {
  const [h, m] = time24.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m.toString().padStart(2, '0')} ${suffix}`;
}

/** Get the week label: "This Week", "Next Week", or date range */
function getWeekLabel(mondayStr: string, currentMonday: string): string {
  if (mondayStr === currentMonday) return 'This Week';
  const current = parseMonday(currentMonday);
  const target = parseMonday(mondayStr);
  const diffDays = Math.round((target.getTime() - current.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 7) return 'Next Week';
  return `Week of ${formatWeekRange(target)}`;
}

/** Get today's day index (0=Mon, 6=Sun) or -1 if not in this week */
function getTodayIndex(mondayStr: string, now: Date): number {
  const monday = parseMonday(mondayStr);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - monday.getTime()) / (1000 * 60 * 60 * 24));
  if (diff >= 0 && diff <= 6) return diff;
  return -1;
}

export default function ShowtimesCard({ schedule, currentMonday, showStatus, ticketLinks, showName, showId, showSlug }: ShowtimesCardProps) {
  // Don't render for closed shows or if no weeks data
  const weekKeys = useMemo(() => Object.keys(schedule.weeks).sort(), [schedule.weeks]);

  const [weekIndex, setWeekIndex] = useState(0);

  // Use client-side date for staleness + today highlight (not SSG build time)
  const [clientNow, setClientNow] = useState<Date | null>(null);
  useEffect(() => { setClientNow(new Date()); }, []);

  // Clamp weekIndex if data changes and current index is out of bounds
  const clampedIndex = Math.min(weekIndex, Math.max(0, weekKeys.length - 1));
  if (clampedIndex !== weekIndex) setWeekIndex(clampedIndex);

  if (showStatus === 'closed' || weekKeys.length === 0 || !currentMonday) return null;

  const selectedMonday = weekKeys[clampedIndex];
  const week: WeekSchedule = schedule.weeks[selectedMonday];
  const weekLabel = getWeekLabel(selectedMonday, currentMonday);
  const weekRange = formatWeekRange(parseMonday(selectedMonday));
  const todayIdx = clientNow ? getTodayIndex(selectedMonday, clientNow) : -1;
  const isAllDark = week.every(day => !day.m && !day.e);

  const staleCheck = clientNow ? (() => {
    const monday = parseMonday(currentMonday);
    const today = new Date(clientNow);
    today.setHours(0, 0, 0, 0);
    return (today.getTime() - monday.getTime()) / (1000 * 60 * 60 * 24) > 10;
  })() : false;

  const canPrev = clampedIndex > 0;
  const canNext = clampedIndex < weekKeys.length - 1;

  // Pick the best ticket link (first in sorted array = highest priority)
  const primaryLink = ticketLinks?.[0];
  const hasTicketLink = !!primaryLink;

  return (
    <section className="card p-5 sm:p-6 mb-6 scroll-mt-20">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <svg className="w-5 h-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <h2 className="text-lg font-bold text-white">Showtimes</h2>
      </div>

      {/* Week Navigation */}
      <div className="flex items-center justify-center gap-3 mb-4">
        <button
          onClick={() => setWeekIndex(i => i - 1)}
          disabled={!canPrev}
          className="p-2.5 -m-1.5 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-default transition-colors"
          aria-label="Previous week"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <div className="text-center min-w-[180px]">
          <span className="text-white font-medium">{weekLabel}</span>
          {weekLabel !== `Week of ${weekRange}` && (
            <span className="text-gray-400 text-sm ml-1.5">({weekRange})</span>
          )}
        </div>
        <button
          onClick={() => setWeekIndex(i => i + 1)}
          disabled={!canNext}
          className="p-2.5 -m-1.5 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-default transition-colors"
          aria-label="Next week"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
        </button>
      </div>

      {/* Staleness warning */}
      {staleCheck && (
        <p className="text-yellow-500/80 text-xs mb-3 text-center">Schedule may be outdated</p>
      )}

      {/* All-dark week message */}
      {isAllDark && (
        <p className="text-gray-400 text-sm text-center py-4">No performances this week</p>
      )}

      {/* Day list — right-aligned times, tight max-width for readability */}
      {!isAllDark && <div className="space-y-0 max-w-xs mx-auto">
        {week.map((day, i) => {
          const isDark = !day.m && !day.e;
          const isToday = i === todayIdx;
          return (
            <div
              key={i}
              aria-current={isToday ? 'date' : undefined}
              className={`flex items-center py-2.5 border-b border-white/5 last:border-0 ${
                isToday ? 'bg-white/[0.03] -mx-2 px-2 rounded' : ''
              }`}
            >
              <span className={`w-10 shrink-0 text-sm font-medium ${
                isToday ? 'text-brand' : isDark ? 'text-gray-500' : 'text-gray-300'
              }`}>
                {DAY_NAMES[i]}
              </span>
              {isToday && (
                <span className="text-[10px] text-brand/70 uppercase tracking-wider mr-2">today</span>
              )}
              <span className={`ml-auto text-sm ${isDark ? 'text-gray-600' : ''}`}>
                {isDark ? (
                  <span className="text-gray-600">&mdash;</span>
                ) : (
                  <>
                    {day.m && (hasTicketLink ? (
                      <TicketLink
                        showName={showName ?? ''}
                        showId={showId ?? ''}
                        showSlug={showSlug}
                        platform={primaryLink!.platform}
                        url={primaryLink!.url}
                        pageType="showtimes"
                        className="text-brand/90 hover:text-brand underline underline-offset-2 decoration-brand/30 hover:decoration-brand/60 transition-colors"
                      >
                        {formatTime(day.m)}
                      </TicketLink>
                    ) : <span className="text-white">{formatTime(day.m)}</span>)}
                    {day.m && day.e && <span className="text-gray-500 mx-1.5">&middot;</span>}
                    {day.e && (hasTicketLink ? (
                      <TicketLink
                        showName={showName ?? ''}
                        showId={showId ?? ''}
                        showSlug={showSlug}
                        platform={primaryLink!.platform}
                        url={primaryLink!.url}
                        pageType="showtimes"
                        className="text-brand/90 hover:text-brand underline underline-offset-2 decoration-brand/30 hover:decoration-brand/60 transition-colors"
                      >
                        {formatTime(day.e)}
                      </TicketLink>
                    ) : <span className="text-white">{formatTime(day.e)}</span>)}
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>}

      {/* Footer */}
      <div className="mt-3 text-center">
        {hasTicketLink && (
          <TicketLink
            showName={showName ?? ''}
            showId={showId ?? ''}
            showSlug={showSlug}
            platform={primaryLink!.platform}
            url={primaryLink!.url}
            pageType="showtimes"
            className="inline-flex items-center gap-1.5 text-brand hover:text-brand/80 text-sm font-medium transition-colors mb-2"
          >
            Get Tickets on {primaryLink!.platform}
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </TicketLink>
        )}
        <p className="text-gray-600 text-[11px]">
          via{' '}
          <a href="https://bwayrush.com/" target="_blank" rel="noopener noreferrer" className="hover:text-gray-400 underline underline-offset-2">
            bwayrush.com
          </a>
        </p>
      </div>
    </section>
  );
}
