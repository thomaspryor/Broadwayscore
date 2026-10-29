'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { ScoreBadge } from '@/components/show-cards';
import { cityAgenda, stopDateRange, type CityAgendaStop } from '@/lib/tour-cities';
import { shortCity } from '@/lib/tour-schedule';
import { getOptimizedImageUrl } from '@/lib/images';
import type { BrowseShow } from '@/components/BrowseListClient';

// "Touring near you" on the national-tours hub (BRO-6544). The pick lives in
// this browser only (no ?city= URLs to compete with /tours/<city>), and every
// city choice is a real link to its city page so crawlers follow it. A saved
// city shows as a one-line summary in the chips' slot, the same height, so the
// page never jumps on load; the full list opens only when the visitor asks.

export interface TourCityOption {
  slug: string;
  /** "Chicago, IL" */
  city: string;
  /** One of the busiest cities: shown as a chip. */
  chip: boolean;
  /** Stops by tours on this page that have not ended yet. */
  stops: CityAgendaStop[];
}

const STORAGE_KEY = 'bsc:tour-city';
const COMING_LIMIT = 8;

const PinIcon = ({ className }: { className?: string }) => (
  <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" /><circle cx="12" cy="10" r="2.5" />
  </svg>
);

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readSaved(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function writeSaved(slug: string | null) {
  try {
    if (slug) window.localStorage.setItem(STORAGE_KEY, slug);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* private mode: the pick just isn't remembered */ }
}

function StopRow({ stop, show }: { stop: CityAgendaStop; show: BrowseShow }) {
  const img = show.images?.poster || show.images?.thumbnail;
  return (
    <li className="flex items-center gap-3 sm:gap-4 py-3 border-b border-white/5 last:border-b-0">
      <div className="w-[5.75rem] sm:w-32 flex-shrink-0 whitespace-nowrap text-[13px] sm:text-base font-semibold text-white tabular-nums">
        {stopDateRange(stop.start, stop.end)}
      </div>
      <div className="w-10 h-[3.75rem] flex-shrink-0 rounded-md overflow-hidden bg-surface-overlay">
        {/* Static export: no next/image optimizer; getOptimizedImageUrl serves the sized copy. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {img && <img src={getOptimizedImageUrl(img, 'card')} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />}
      </div>
      <div className="flex-1 min-w-0">
        <Link href={`/show/${show.slug}`} className="block font-semibold text-white text-sm sm:text-base leading-tight hover:text-brand transition-colors line-clamp-2">
          {show.title}
        </Link>
        <div className="text-xs sm:text-sm text-fg-muted truncate mt-0.5">{stop.venue}</div>
      </div>
      <ScoreBadge
        size="xs"
        score={show.criticScore?.score}
        reviewCount={show.criticScore?.reviewCount ?? 0}
        tier1And2Count={(show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0)}
        status={show.status}
        category={show.category}
      />
    </li>
  );
}

export default function TourCityPicker({ cities, shows }: { cities: TourCityOption[]; shows: BrowseShow[] }) {
  const inputId = useId();
  const listId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [today, setToday] = useState<string | null>(null);

  const bySlug = useMemo(() => new Map(cities.map(c => [c.slug, c])), [cities]);
  const showById = useMemo(() => new Map(shows.map(s => [s.id, s])), [shows]);

  // Read the saved city after hydration so the server HTML stays the default page.
  useEffect(() => {
    setToday(localToday());
    const saved = readSaved();
    if (saved && bySlug.has(saved)) setSelected(saved);
  }, [bySlug]);

  const city = selected ? bySlug.get(selected) : undefined;
  const agenda = useMemo(() => {
    if (!city || !today) return null;
    return cityAgenda(city.stops.filter(s => showById.has(s.showId)), today, COMING_LIMIT);
  }, [city, today, showById]);

  const matches = useMemo(() => {
    // Punctuation-blind, so "st louis" finds "St. Louis, MO".
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const q = norm(query);
    if (!q) return [];
    return cities
      .filter(c => { const n = norm(c.city); return n.startsWith(q) || n.includes(` ${q}`); })
      .slice(0, 8);
  }, [query, cities]);

  const choose = (slug: string) => {
    setSelected(slug);
    setOpen(true);
    setQuery('');
    setListOpen(false);
    writeSaved(slug);
  };
  const clear = () => {
    setSelected(null);
    setOpen(false);
    writeSaved(null);
  };

  const listVisible = listOpen && matches.length > 0;
  const chips = cities.filter(c => c.chip);
  const place = city ? shortCity(city.city) : '';

  return (
    <section className="card p-4 sm:p-5 mb-6" aria-labelledby={`${inputId}-h`}>
      <div className="flex items-center gap-3">
        <span className="w-9 h-9 rounded-lg bg-brand-muted text-brand flex items-center justify-center flex-shrink-0">
          <PinIcon className="w-[18px] h-[18px]" />
        </span>
        <div className="min-w-0">
          <h2 id={`${inputId}-h`} className="text-base font-bold text-white leading-tight">Touring near you</h2>
          <p className="text-xs sm:text-sm text-fg-muted">What&apos;s playing in your city, and what&apos;s coming</p>
        </div>
      </div>

      <div className="relative mt-3">
        <label htmlFor={inputId} className="sr-only">Search your city</label>
        <input
          id={inputId}
          type="search"
          autoComplete="off"
          placeholder="Search your city"
          value={query}
          onChange={e => { setQuery(e.target.value); setActive(0); setListOpen(true); }}
          onFocus={() => setListOpen(true)}
          onBlur={() => setListOpen(false)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' && matches.length) { e.preventDefault(); setListOpen(true); setActive(i => (i + 1) % matches.length); }
            else if (e.key === 'ArrowUp' && matches.length) { e.preventDefault(); setActive(i => (i - 1 + matches.length) % matches.length); }
            else if (e.key === 'Enter' && listVisible) { e.preventDefault(); choose(matches[active].slug); }
            else if (e.key === 'Escape') { setListOpen(false); setQuery(''); }
          }}
          role="combobox"
          aria-expanded={listVisible}
          aria-controls={listVisible ? listId : undefined}
          aria-activedescendant={listVisible ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          className="w-full h-11 rounded-xl bg-surface border border-white/10 px-4 text-base text-white placeholder:text-fg-muted focus:outline-none focus:border-brand/60"
        />
        {listVisible && (
          <ul id={listId} role="listbox" aria-label="Cities" className="absolute z-20 left-0 right-0 mt-1 rounded-xl bg-surface-elevated border border-white/10 shadow-card overflow-hidden">
            {matches.map((c, i) => (
              <li
                key={c.slug}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                // mousedown, not click: keeps focus in the input so its blur doesn't close the list first.
                onMouseDown={e => { e.preventDefault(); choose(c.slug); }}
                onMouseEnter={() => setActive(i)}
                className={`flex items-center min-h-[44px] px-4 text-sm cursor-pointer ${i === active ? 'bg-surface-overlay text-white' : 'text-gray-200'}`}
              >
                {c.city}
              </li>
            ))}
          </ul>
        )}
        {listOpen && query.trim() && matches.length === 0 && (
          <p role="status" className="absolute z-20 left-0 right-0 mt-1 rounded-xl bg-surface-elevated border border-white/10 px-4 py-3 text-sm text-gray-400">
            No tour stops booked there yet
          </p>
        )}
      </div>

      {/* Chips and the saved-city line share one fixed-height slot (no layout shift). */}
      <div className="mt-3 h-11 flex items-center">
        {city && agenda && !open ? (
          <div className="flex items-center gap-2 min-w-0 text-sm">
            <PinIcon className="w-4 h-4 text-brand flex-shrink-0" />
            <span className="font-semibold text-white truncate">{city.city}</span>
            <span className="text-fg-muted whitespace-nowrap text-xs sm:text-sm">
              · {agenda.now.length} now · {agenda.comingCount} coming
            </span>
            <button type="button" onClick={() => setOpen(true)} className="ml-1 h-11 px-4 rounded-pill bg-surface-overlay text-white text-sm font-medium hover:bg-surface-elevated flex-shrink-0">
              Show
            </button>
          </div>
        ) : (
          <ul className="flex gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1">
            {chips.map(c => (
              <li key={c.slug} className="flex-shrink-0">
                <a
                  href={`/tours/${c.slug}`}
                  onClick={e => { e.preventDefault(); choose(c.slug); }}
                  aria-current={c.slug === selected ? 'true' : undefined}
                  className={`h-11 inline-flex items-center px-4 rounded-pill text-sm font-medium transition-colors ${
                    c.slug === selected ? 'bg-brand text-surface' : 'bg-surface-overlay text-gray-200 hover:bg-surface-elevated'
                  }`}
                >
                  {shortCity(c.city)}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {city && agenda && open && (
        <div className="mt-4 pt-4 border-t border-white/10">
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="text-lg font-bold text-white">{city.city}</h3>
            <div className="flex-1" />
            <Link href={`/tours/${city.slug}`} className="text-sm font-semibold text-brand hover:text-brand-hover">
              Full {place} page ›
            </Link>
            <button type="button" onClick={clear} aria-label={`Clear ${city.city}`} className="w-11 h-11 -mr-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-overlay flex items-center justify-center">
              <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>

          {agenda.now.length > 0 && (
            <>
              <h4 className="mt-3 text-xs font-bold uppercase tracking-[0.1em] text-status-open flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-status-open" aria-hidden="true" />Playing now
              </h4>
              <ul>{agenda.now.map(s => <StopRow key={`${s.showId}|${s.start}`} stop={s} show={showById.get(s.showId)!} />)}</ul>
            </>
          )}

          {agenda.coming.length > 0 && (
            <>
              <h4 className="mt-4 text-xs font-bold uppercase tracking-[0.1em] text-gray-400">Coming to {place}</h4>
              {agenda.coming.map(m => (
                <div key={m.month}>
                  <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-muted">{m.month}</div>
                  <ul>{m.stops.map(s => <StopRow key={`${s.showId}|${s.start}`} stop={s} show={showById.get(s.showId)!} />)}</ul>
                </div>
              ))}
            </>
          )}

          {agenda.now.length === 0 && agenda.comingCount === 0 && (
            <p className="mt-3 text-sm text-gray-400">No tours are booked into {place} right now.</p>
          )}

          {agenda.comingCount > COMING_LIMIT && (
            <Link href={`/tours/${city.slug}`} className="mt-3 flex items-center justify-center h-11 rounded-xl border border-white/10 text-sm font-semibold text-gray-200 hover:text-white hover:border-white/20">
              {agenda.comingCount - COMING_LIMIT} more on the {place} page ›
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
