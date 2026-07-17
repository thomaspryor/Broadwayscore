'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useCurrentMarket } from '@/hooks/useCurrentMarket';
import { useIsOperaDomain } from '@/hooks/useIsOperaDomain';
import { isOperaShowPath } from '@/lib/opera-show-ids';

interface MarketStats {
  nyc: { openShows: number; theaters: number };
  westEnd: { openShows: number; theaters: number };
  offBroadway?: { openShows: number };
  offWestEnd?: { openShows: number };
}

export default function MarketNav({ stats }: { stats: MarketStats }) {
  const pathname = usePathname() || '';
  const marketId = useCurrentMarket();
  const isOperaDomain = useIsOperaDomain();
  // An opera show detail page (regardless of domain) should render the Opera
  // pill instead of "Off-Bway" — Met productions are categorized off-broadway
  // for routing only, and surfacing that label embarrasses the site to opera
  // professionals. See Notion 363637c5-416f-8112.
  const isOperaShowPage = isOperaShowPath(pathname);
  // /opera path itself should also trigger Opera branding regardless of domain
  const isOperaPage = pathname === '/opera' || pathname.startsWith('/opera/');
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const isWestEnd = marketId === 'west-end';
  const isOffWestEnd = marketId === 'off-west-end';
  // Treat opera show pages as NOT off-broadway for the pill label, even though
  // the URL-derived marketId is 'off-broadway' (shared routing convention).
  const isOffBroadway = marketId === 'off-broadway' && !isOperaShowPage;
  // Regional (non-NYC US) shows: distinct pill label, no dropdown entry yet (hub deferred).
  const isRegional = marketId === 'regional';
  // Don't apply opera domain branding when user has explicitly navigated to
  // another market (off-broadway, west-end, off-west-end, regional). The opera
  // domain flag only matters on opera-specific pages.
  const isExplicitNonOperaMarket = isWestEnd || isOffWestEnd || isOffBroadway || isRegional;
  const isOpera = (isOperaDomain || isOperaShowPage || isOperaPage) && !isExplicitNonOperaMarket;
  const isBroadway = !isWestEnd && !isOffWestEnd && !isOffBroadway && !isRegional && !isOpera;
  const currentMarket = isWestEnd || isOffWestEnd ? 'west-end' : 'nyc';

  const closeDropdown = useCallback(() => setIsOpen(false), []);
  useClickOutside(dropdownRef, closeDropdown, isOpen);

  // Close on route change
  useEffect(() => {
    setIsOpen(false);
  }, [marketId]);

  return (
    <div className="flex items-center gap-2 sm:gap-3" ref={dropdownRef}>
      {/* Logo — changes per market AND per domain (operascorecard.com → Opera).
          Opera-domain swap happens client-side after hydration; SSR renders the
          Broadway default so search engines + first-paint stay consistent across
          the shared static export. */}
      <Link href={isOpera ? '/opera' : (isWestEnd || isOffWestEnd ? '/west-end' : '/')} className="flex items-center shrink-0 group">
        {isOpera ? (
          <span className="text-base min-[390px]:text-lg sm:text-3xl font-extrabold text-white tracking-tight">Opera<span className="bg-gradient-to-r from-amber-400 to-amber-500 bg-clip-text text-transparent">Scorecard</span></span>
        ) : isWestEnd || isOffWestEnd ? (
          <span className="text-base min-[390px]:text-lg sm:text-3xl font-extrabold text-white tracking-tight">WestEnd<span className="bg-gradient-to-r from-pink-400 to-pink-500 bg-clip-text text-transparent">Scorecard</span></span>
        ) : (
          <span className="text-base min-[390px]:text-lg sm:text-3xl font-extrabold text-white tracking-tight">Broadway<span className="text-gradient">Scorecard</span></span>
        )}
        <span className="hidden sm:inline text-xs text-gray-400 font-normal align-super ml-0.5">™</span>
      </Link>

      {/* Market Pill */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`
          flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs font-semibold mt-0.5 shrink-0
          border transition-colors whitespace-nowrap
          ${isOpen
            ? 'bg-white/10 border-white/20 text-white'
            : isOpera
              ? 'bg-amber-500/[0.12] border-amber-500/25 text-amber-300 hover:bg-amber-500/20'
              : isOffBroadway
                ? 'bg-purple-500/[0.12] border-purple-500/25 text-purple-300 hover:bg-purple-500/20'
                : isOffWestEnd
                  ? 'bg-violet-500/[0.12] border-violet-500/25 text-violet-300 hover:bg-violet-500/20'
                  : isRegional
                    ? 'bg-emerald-500/[0.12] border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/20'
                    : 'bg-white/[0.06] border-white/[0.12] text-gray-300 hover:bg-white/10 hover:text-white'
          }
        `}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Switch market"
      >
        {isOpera ? 'Opera' : isOffBroadway ? 'Off-Bway' : isOffWestEnd ? 'Off-WE' : isRegional ? 'Regional' : currentMarket === 'nyc' ? 'Broadway' : 'West End'}
        <svg className={`hidden min-[400px]:block w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute top-14 left-3 right-3 sm:left-auto sm:right-auto sm:w-72 bg-[#1e1e2a] border border-white/10 rounded-xl p-1.5 shadow-2xl z-50">
          <div className="px-3.5 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">New York</div>
          <Link
            href="/"
            className={`flex items-center justify-between px-3.5 py-3 rounded-lg transition-colors ${
              isBroadway ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
            }`}
            onClick={() => setIsOpen(false)}
          >
            <div>
              <div className="text-sm font-semibold text-white">Broadway</div>
              <div className="text-[11px] text-gray-500">{stats.nyc.openShows} open shows · {stats.nyc.theaters} theaters</div>
            </div>
            {isBroadway && (
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </Link>
          {stats.offBroadway && (
            <Link
              href="/off-broadway"
              className={`flex items-center justify-between px-3.5 py-3 rounded-lg transition-colors ${
                isOffBroadway ? 'bg-purple-500/[0.10]' : 'hover:bg-white/[0.04]'
              }`}
              onClick={() => setIsOpen(false)}
            >
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${isOffBroadway ? 'bg-purple-400 shadow-[0_0_6px_rgba(168,85,247,0.5)]' : 'bg-purple-500/60'}`} />
                <div>
                  <div className={`text-sm font-semibold ${isOffBroadway ? 'text-purple-200' : 'text-white'}`}>Off-Broadway</div>
                  <div className="text-[11px] text-gray-500">{stats.offBroadway.openShows} open shows</div>
                </div>
              </div>
              {isOffBroadway && (
                <svg className="w-4 h-4 text-purple-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </Link>
          )}
          <Link
            href="/opera"
            className={`flex items-center justify-between px-3.5 py-3 rounded-lg transition-colors ${
              isOpera ? 'bg-amber-500/[0.08]' : 'hover:bg-white/[0.04]'
            }`}
            onClick={() => setIsOpen(false)}
          >
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${isOpera ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]' : 'bg-amber-500/60'}`} />
              <div>
                <div className={`flex items-center gap-1.5 text-sm font-semibold ${isOpera ? 'text-amber-200' : 'text-white'}`}>
                  OperaScorecard
                  <span className="text-[9px] font-bold uppercase tracking-wider text-amber-400/70 border border-amber-400/30 rounded px-1 py-px">Beta</span>
                </div>
                <div className="text-[11px] text-gray-500">Met Opera · New York</div>
              </div>
            </div>
            {isOpera && (
              <svg className="w-4 h-4 text-amber-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </Link>
          <div className="h-px bg-white/[0.06] mx-2 my-1" />
          <div className="px-3.5 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">London</div>
          <Link
            href="/west-end"
            className={`flex items-center justify-between px-3.5 py-3 rounded-lg transition-colors ${
              isWestEnd ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
            }`}
            onClick={() => setIsOpen(false)}
          >
            <div>
              <div className="text-sm font-semibold text-white">West End</div>
              <div className="text-[11px] text-gray-500">{stats.westEnd.openShows} open shows · {stats.westEnd.theaters} theaters</div>
            </div>
            {isWestEnd && (
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </Link>
          {stats.offWestEnd && (
            <Link
              href="/off-west-end"
              className={`flex items-center justify-between px-3.5 py-3 rounded-lg transition-colors ${
                isOffWestEnd ? 'bg-violet-500/[0.10]' : 'hover:bg-white/[0.04]'
              }`}
              onClick={() => setIsOpen(false)}
            >
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${isOffWestEnd ? 'bg-violet-400 shadow-[0_0_6px_rgba(139,92,246,0.5)]' : 'bg-violet-500/60'}`} />
                <div>
                  <div className={`text-sm font-semibold ${isOffWestEnd ? 'text-violet-200' : 'text-white'}`}>Off-West End</div>
                  <div className="text-[11px] text-gray-500">{stats.offWestEnd.openShows} open shows</div>
                </div>
              </div>
              {isOffWestEnd && (
                <svg className="w-4 h-4 text-violet-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
