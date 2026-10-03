'use client';

/**
 * Upcoming-show cards shared by My Shows (Diary → Upcoming, Watchlist) and the
 * Shared Plans page (/plans/[token], BRO-4481). Moved out of
 * src/app/my-shows/MyShowsClient.tsx so a friend sees the same poster grid,
 * list rows, status badges and grid/list switch the owner sees — one design,
 * not a look-alike (owner, 2026-10-02: "we should never create new designs
 * when we have existing ones"). The grid card and list row follow the iOS
 * app's Upcoming design (owner pick, 2026-10-03), so web and app match.
 */
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { formatShowDate } from '@/lib/date-utils';

export type ViewMode = 'grid' | 'list';

/** Wraps card content in a Link when href is set, plain div otherwise. In
 *  practice getShowHref() always returns a URL now (diary-only shows link to
 *  /diary-show/[id]) — this is defensive for a future caller that passes null.
 *  ariaLabel is required whenever children include their own labelled
 *  buttons (Edit/Delete/Remove) — without it, an unlabelled anchor's
 *  accessible name is computed FROM those descendants' text, so a query for
 *  e.g. "Edit rating" matches this whole-card link too (test-red incident,
 *  2026-07-21). */
export function CardLinkOrDiv({ href, className, children, ariaLabel }: { href: string | null; className?: string; children: ReactNode; ariaLabel?: string }) {
  if (href) {
    return <Link href={href} className={className} aria-label={ariaLabel}>{children}</Link>;
  }
  return <div className={className}>{children}</div>;
}

/** Poster image that degrades to the 🎭 placeholder when the URL is missing
 *  OR fails to load — a stored poster path that 404s otherwise renders as a
 *  broken-image icon in the diary grid (owner report, 2026-07-14). */
export function Poster({ url, iconClass = 'text-3xl', title }: { url: string | null | undefined; iconClass?: string; title?: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    // Grid cards without a printed name pass the title so the placeholder
    // names the show (UX audit, BRO-3861). List rows and the Upcoming card
    // already print the title next to / under it.
    if (title) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-2 text-gray-600">
          <span className={iconClass} aria-hidden="true">🎭</span>
          <span className="text-xs font-semibold text-gray-300 text-center leading-snug line-clamp-3 break-words">{title}</span>
        </div>
      );
    }
    return <div className={`w-full h-full flex items-center justify-center text-gray-600 ${iconClass}`}>🎭</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="w-full h-full object-cover" onError={() => setBroken(true)} />;
}

/** The fields bookabilityLabel reads (a ShowLookup satisfies it). */
export interface BookabilitySource {
  status: string;
  ticketsOnSale?: boolean;
  previewDate?: string | null;
  openingDate?: string | null;
}

/**
 * Bookability label for watchlist entries — without it a watchlist full of
 * announced/closed shows "looks like a lot I could book, but can't actually
 * yet" (owner, 2026-07-20). Returns null for open/previews shows (bookable —
 * no label needed; Closing Soon is handled separately).
 */
export function bookabilityLabel(show?: BookabilitySource | null): { text: string; cls: string } | null {
  if (!show) return null;
  if (show.status === 'closed') {
    return { text: 'Closed', cls: 'bg-gray-600/90 text-white' };
  }
  if (show.status === 'open' || show.status === 'previews') {
    return { text: show.status === 'previews' ? 'In Previews' : 'Open', cls: 'bg-status-open/90 text-black' };
  }
  if (show.status === 'upcoming' || show.status === 'announced') {
    if (show.ticketsOnSale) {
      return { text: 'Tix on sale', cls: 'bg-status-open/90 text-black' };
    }
    const start = show.previewDate || show.openingDate;
    const text = start
      ? `Opens ${formatShowDate(start, { month: 'short', day: 'numeric' })}`
      : 'Not yet open';
    return { text, cls: 'bg-blue-500/80 text-white' };
  }
  return null;
}

/** Top-left poster badge, as on the Watchlist cards. */
export function PosterBadge({ badge }: { badge: { text: string; cls: string } | null }) {
  if (!badge) return null;
  return (
    <span className={`absolute top-1.5 left-1.5 z-[2] px-1.5 py-0.5 text-[9px] font-bold uppercase rounded ${badge.cls}`}>
      {badge.text}
    </span>
  );
}

/**
 * Upcoming poster card, the iOS app's design (Watched → Diary → Upcoming,
 * owner pick 2026-10-03): the date in a dark pill over the bottom of the
 * poster and the show name under it, two lines max. `onRemove` adds the
 * owner's hover trash button; `badge` adds the Watchlist status pill;
 * `footer` renders under the name (e.g. Add to Calendar). Friends get it
 * without onRemove.
 */
export function UpcomingGridCard({ href, posterUrl, date, title, onRemove, badge, footer }: {
  href: string | null;
  posterUrl?: string | null;
  date: string | null;
  title: string;
  onRemove?: () => void;
  badge?: { text: string; cls: string } | null;
  footer?: ReactNode;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);

  return (
    <div className="group/grid flex flex-col">
      <CardLinkOrDiv href={href} className="block" ariaLabel={date ? `View ${title}, ${date}` : `View ${title}`}>
        <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-surface-overlay">
          <Poster url={posterUrl} iconClass="text-3xl" />
          {badge !== undefined && <PosterBadge badge={badge} />}
          {date && (
            <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 z-[1] px-1.5 py-0.5 rounded bg-black/45 text-xs font-bold text-white whitespace-nowrap">
              {date}
            </span>
          )}
          {/* Remove button — hidden on mobile, visible on hover on desktop */}
          {onRemove && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); confirmRemove ? onRemove() : setConfirmRemove(true); }}
              className={`absolute top-2 right-2 z-[2] hidden sm:flex items-center justify-center rounded-full ${confirmRemove ? 'h-7 px-2.5 bg-red-500/90 text-white text-xs font-bold opacity-100' : 'w-7 h-7 bg-black/70 text-score-skip/80 hover:text-score-skip opacity-0 group-hover/grid:opacity-100'} transition-opacity`}
              aria-label="Remove from upcoming"
            >
              {confirmRemove ? 'Remove?' : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              )}
            </button>
          )}
        </div>
        <p className="mt-1.5 px-0.5 text-xs font-medium leading-[15px] min-h-[30px] text-gray-300 text-center line-clamp-2">{title}</p>
      </CardLinkOrDiv>
      {footer}
    </div>
  );
}

/** "Sun, Oct 18" for a YYYY-MM-DD planned date (viewer-local, as My Shows shows it). */
export function upcomingRowDate(plannedDate: string): string {
  return new Date(plannedDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Whole days until a YYYY-MM-DD planned date (My Shows' countdown rule). */
export function daysUntilDate(plannedDate: string): number {
  return Math.ceil((new Date(plannedDate + 'T00:00:00').getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
}

/** "18" and "OCT" for the list row's date block. */
function dateBlock(plannedDate: string): { day: string; month: string } {
  const d = new Date(plannedDate + 'T00:00:00');
  return { day: String(d.getDate()), month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase() };
}

/**
 * Upcoming list row, the iOS app's design (Diary list view, owner pick
 * 2026-10-03): the day over the month on the left, a poster thumb, title and
 * venue, and the day countdown on the right. With no date, the date block is
 * left out and `note` (e.g. a status pill) sits under the venue. `actions`
 * renders above the row link (the owner's remove button); `extra` sits under
 * the countdown.
 */
export function UpcomingListRow({ href, posterUrl, title, venue, plannedDate, note, actions, extra }: {
  href: string | null;
  posterUrl?: string | null;
  title: string;
  venue?: string | null;
  plannedDate?: string | null;
  note?: ReactNode;
  actions?: ReactNode;
  extra?: ReactNode;
}) {
  const daysUntil = plannedDate ? daysUntilDate(plannedDate) : null;
  const block = plannedDate ? dateBlock(plannedDate) : null;
  return (
    <div className="relative flex items-center gap-2 sm:gap-3 px-3 sm:px-5 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
      {href && <Link href={href} className="absolute inset-0 z-0" aria-label={`View ${title}`} />}
      {block && (
        <div className="relative z-[1] flex-shrink-0 w-8 text-center pointer-events-none">
          <p aria-hidden="true" className="text-base font-bold leading-tight text-white">{block.day}</p>
          <p aria-hidden="true" className="text-xs font-bold uppercase text-gray-500">{block.month}</p>
          <span className="sr-only">{upcomingRowDate(plannedDate!)}</span>
        </div>
      )}
      <div className="relative z-[1] flex-shrink-0 w-10 h-14 rounded-lg overflow-hidden bg-surface-overlay pointer-events-none">
        <Poster url={posterUrl} iconClass="text-lg" />
      </div>
      <div className="relative z-[1] flex-1 min-w-0 pointer-events-none">
        <h4 className="font-bold text-white text-base truncate">{title}</h4>
        {venue && <p className="text-xs text-gray-500 truncate">{venue}</p>}
        {!plannedDate && note && <div className="mt-1">{note}</div>}
      </div>
      {(daysUntil !== null && daysUntil > 0) || extra ? (
        <div className="relative z-[1] flex-shrink-0 text-right">
          {daysUntil !== null && daysUntil > 0 && (
            <p className="text-xs font-semibold text-amber-300 pointer-events-none">
              {daysUntil === 1 ? 'Tomorrow' : `${daysUntil}d`}
            </p>
          )}
          {extra}
        </div>
      ) : null}
      {actions}
    </div>
  );
}

/**
 * The grid / list switch from My Shows. `size` matches its desktop (h-8) and
 * mobile (h-11) rows; 'responsive' is the mobile size below `sm` and the
 * desktop size from `sm` up, for a page with a single header row (Shared Plans).
 */
export function ViewModeToggle({ value, onChange, size = 'desktop' }: { value: ViewMode; onChange: (mode: ViewMode) => void; size?: 'desktop' | 'mobile' | 'responsive' }) {
  // Phone sizes draw the outline as a ring (outside the box): a 1px border
  // would leave 42px inside an h-11 box for buttons the mobile rule in
  // globals.css holds at min-height 44px, clipping them (visual-qa overflow
  // probe, 2026-10-02).
  const box = {
    mobile: 'h-11 ring-1 ring-white/10',
    desktop: 'h-8 border border-white/10',
    responsive: 'h-11 ring-1 ring-white/10 sm:h-8 sm:ring-0 sm:border sm:border-white/10',
  }[size];
  const btn = { mobile: 'w-11', desktop: 'w-8', responsive: 'w-11 sm:w-8' }[size];
  return (
    <div className={`inline-flex items-stretch flex-shrink-0 rounded overflow-hidden bg-white/[0.04] ${box}`}>
      <button
        type="button"
        onClick={() => onChange('grid')}
        className={`inline-flex items-center justify-center ${btn} h-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand transition-colors ${value === 'grid' ? 'bg-white/[0.15] text-white' : 'text-gray-500 hover:text-gray-300'}`}
        aria-label="Grid view"
        aria-pressed={value === 'grid'}
      >
        <svg className="w-4 h-4 block shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        className={`inline-flex items-center justify-center ${btn} h-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand transition-colors ${value === 'list' ? 'bg-white/[0.15] text-white' : 'text-gray-500 hover:text-gray-300'}`}
        aria-label="List view"
        aria-pressed={value === 'list'}
      >
        <svg className="w-4 h-4 block shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
    </div>
  );
}
