'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useCurrentMarket } from '@/hooks/useCurrentMarket';

interface MarketStats {
  nyc: { openShows: number; theaters: number };
  westEnd: { openShows: number; theaters: number };
}

export default function MarketNav({ stats }: { stats: MarketStats }) {
  const marketId = useCurrentMarket();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const isWestEnd = marketId === 'west-end';
  const isOffWestEnd = marketId === 'off-west-end';
  const isOffBroadway = marketId === 'off-broadway';
  const currentMarket = isWestEnd || isOffWestEnd ? 'west-end' : 'nyc';

  const closeDropdown = useCallback(() => setIsOpen(false), []);
  useClickOutside(dropdownRef, closeDropdown, isOpen);

  // Close on route change
  useEffect(() => {
    setIsOpen(false);
  }, [marketId]);

  return (
    <div className="flex items-center gap-3 sm:gap-3" ref={dropdownRef}>
      {/* Logo — changes per market */}
      <Link href={isWestEnd || isOffWestEnd ? '/west-end' : '/'} className="flex items-center group">
        {isWestEnd || isOffWestEnd ? (
          <>
            <span className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">West End</span>
            <span className="text-2xl sm:text-3xl font-extrabold tracking-tight bg-gradient-to-r from-pink-400 to-pink-500 bg-clip-text text-transparent">Scorecard</span>
          </>
        ) : (
          <>
            <span className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">Broadway</span>
            <span className="text-2xl sm:text-3xl font-extrabold text-gradient tracking-tight">Scorecard</span>
          </>
        )}
        <span className="text-[8px] sm:text-xs text-gray-400 font-normal align-super ml-0.5">™</span>
      </Link>

      {/* Market Pill */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`
          flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold mt-0.5
          border transition-colors whitespace-nowrap
          ${isOpen
            ? 'bg-white/10 border-white/20 text-white'
            : isOffBroadway
              ? 'bg-purple-500/[0.12] border-purple-500/25 text-purple-300 hover:bg-purple-500/20'
              : isOffWestEnd
                ? 'bg-violet-500/[0.12] border-violet-500/25 text-violet-300 hover:bg-violet-500/20'
                : 'bg-white/[0.06] border-white/[0.12] text-gray-300 hover:bg-white/10 hover:text-white'
          }
        `}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Switch market"
      >
        {isOffBroadway ? 'Off-Bway' : isOffWestEnd ? 'Off-WE' : currentMarket === 'nyc' ? 'NYC' : 'West End'}
        <svg className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute top-14 left-3 right-3 sm:left-auto sm:right-auto sm:w-72 bg-[#1e1e2a] border border-white/10 rounded-xl p-1.5 shadow-2xl z-50">
          <Link
            href="/"
            className={`flex items-center justify-between px-3.5 py-3 rounded-lg transition-colors ${
              currentMarket === 'nyc' ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
            }`}
            onClick={() => setIsOpen(false)}
          >
            <div>
              <div className="text-sm font-semibold text-white">NYC</div>
              <div className="text-[11px] text-gray-500">{stats.nyc.openShows} open shows · {stats.nyc.theaters} theaters</div>
            </div>
            {currentMarket === 'nyc' && (
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </Link>
          <div className="h-px bg-white/[0.06] mx-2 my-0.5" />
          <Link
            href="/west-end"
            className={`flex items-center justify-between px-3.5 py-3 rounded-lg transition-colors ${
              currentMarket === 'west-end' ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
            }`}
            onClick={() => setIsOpen(false)}
          >
            <div>
              <div className="text-sm font-semibold text-white">West End</div>
              <div className="text-[11px] text-gray-500">{stats.westEnd.openShows} open shows · {stats.westEnd.theaters} theaters</div>
            </div>
            {currentMarket === 'west-end' && (
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </Link>
        </div>
      )}
    </div>
  );
}
