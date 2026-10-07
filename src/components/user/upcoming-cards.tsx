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
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { formatShowDate } from '@/lib/date-utils';
import { catchEarlyImgError } from '@/lib/img-early-error';

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
  return <img src={url} alt="" className="w-full h-full object-cover" ref={catchEarlyImgError(() => setBroken(true))} onError={() => setBroken(true)} />;
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
 * Poster grid card, the iOS app's design (Watched → Diary, To Watch, owner
 * picks 2026-10-03): the date in a dark pill over the bottom of the poster,
 * then `meta` (e.g. the diary's gold stars), then the show name, two lines
 * max with both lines reserved so rows line up. One card for every My Shows
 * and Shared Plans grid (BRO-4558): Upcoming, To be rated, past shows.
 * No corner buttons: tapping the poster opens the show, whose page edits or
 * deletes the rating and removes it from the watchlist (owner, 2026-10-03:
 * delete by clicking into it). `badge` is the top-left status pill;
 * `children` extra poster overlays; `footer` controls under the name.
 */
export function PosterGridCard({ href, posterUrl, date, title, ariaLabel, badge, meta, footer, children }: {
  href: string | null;
  posterUrl?: string | null;
  date: string | null;
  title: string;
  ariaLabel?: string;
  badge?: { text: string; cls: string } | null;
  meta?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="group/grid flex flex-col min-w-0">
      <CardLinkOrDiv href={href} className="block" ariaLabel={ariaLabel ?? (date ? `View ${title}, ${date}` : `View ${title}`)}>
        <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-surface-overlay">
          <Poster url={posterUrl} iconClass="text-3xl" />
          {badge !== undefined && <PosterBadge badge={badge} />}
          {children}
          {date && (
            // Width-bounded: a countdown pill ("Sep 20 · Tomorrow") is wider
            // than a 104px card at 360px and would clip at both ends.
            <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 z-[1] max-w-[calc(100%-8px)] truncate px-1.5 py-0.5 rounded bg-black/45 text-xs font-bold text-white whitespace-nowrap">
              {date}
            </span>
          )}
        </div>
        {meta}
        <p className="mt-1.5 px-0.5 text-xs font-medium leading-[15px] min-h-[30px] text-gray-300 text-center line-clamp-2 break-words">{title}</p>
      </CardLinkOrDiv>
      {footer}
    </div>
  );
}

/** The Upcoming card: a PosterGridCard (the name Shared Plans imports). */
export const UpcomingGridCard = PosterGridCard;

/**
 * The poster pill's date, as the app prints it: "Oct 9", "Oct 9, 2024" with
 * `year`, and with `countdown` the days to go inside a week: "Oct 9 · 3d",
 * "Oct 9 · Tomorrow", "Oct 9 · Today!" (to-watch.tsx).
 */
export function formatPillDate(date: string, opts: { year?: boolean; countdown?: boolean } = {}): string {
  const label = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(opts.year ? { year: 'numeric' as const } : {}) });
  if (!opts.countdown) return label;
  const days = daysUntilDate(date);
  if (days < 0 || days > 7) return label;
  return `${label} · ${days === 0 ? 'Today!' : days === 1 ? 'Tomorrow' : `${days}d`}`;
}

/**
 * Full-width section band, the app's section header (watched.tsx
 * sectionHeaderRow): raised background, hairline top and bottom, bold
 * uppercase title left, count right. Bleeds to the page edge through the
 * page's px-4 sm:px-6 gutter, so it must sit in such a container.
 */
export function SectionBand({ title, count, noun = 'entry', id, as: Heading = 'h3', hint }: {
  title: string;
  count?: number;
  noun?: 'entry' | 'show';
  id?: string;
  as?: 'h2' | 'h3';
  hint?: ReactNode;
}) {
  const plural = noun === 'entry' ? 'entries' : 'shows';
  return (
    <div className="flex items-center justify-between gap-3 py-2 mb-3 band-bleed">
      <Heading id={id} className="text-[13px] font-bold text-white uppercase tracking-wider min-w-0">
        {title}
        {hint}
      </Heading>
      {count !== undefined && <span className="flex-shrink-0 text-xs text-gray-500">{count} {count === 1 ? noun : plural}</span>}
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
export function ViewModeToggle({ value, onChange }: { value: ViewMode; onChange: (mode: ViewMode) => void }) {
  // Same height, radius, fill and inset outline as .toolbar-control, so it
  // lines up with the Share button and sort select beside it (owner,
  // 2026-10-03). The inset ring leaves the 44px phone buttons unclipped.
  const btn = 'w-11 sm:w-9';
  return (
    <div className="inline-flex items-stretch flex-shrink-0 h-11 sm:h-9 rounded-badge overflow-hidden bg-white/[0.06] ring-1 ring-inset ring-white/10">
      <button
        type="button"
        onClick={() => onChange('grid')}
        className={`inline-flex items-center justify-center ${btn} h-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand transition-colors ${value === 'grid' ? 'bg-white/[0.15] text-white' : 'text-gray-400 hover:text-white'}`}
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
        className={`inline-flex items-center justify-center ${btn} h-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand transition-colors ${value === 'list' ? 'bg-white/[0.15] text-white' : 'text-gray-400 hover:text-white'}`}
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
