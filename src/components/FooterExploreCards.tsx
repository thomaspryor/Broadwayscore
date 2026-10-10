'use client';

import Link from 'next/link';
import { useCurrentMarket } from '@/hooks/useCurrentMarket';

/**
 * "Explore More Theatre" footer cards — reordered by current market.
 * On WE/OWE pages, London markets appear first.
 * On Broadway/OB pages, NYC markets appear first.
 */
export default function FooterExploreCards() {
  const market = useCurrentMarket();
  const isLondon = market === 'west-end' || market === 'off-west-end';

  const obCard = (
    <Link key="ob" href="/off-broadway" className="flex-1 p-3 sm:p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-brand/30 hover:bg-brand/[0.03] transition-colors text-center group">
      <div className="text-xl mb-1">&#127914;</div>
      <div className="text-sm font-bold text-white group-hover:text-brand transition-colors whitespace-nowrap">
        <span className="sm:hidden">Off-B&rsquo;way</span>
        <span className="hidden sm:inline">Off-Broadway</span>
      </div>
      <div className="text-[10px] text-gray-500">NYC</div>
    </Link>
  );

  const weCard = (
    <Link key="we" href="/west-end" className="flex-1 p-3 sm:p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-pink-400/30 hover:bg-pink-400/[0.03] transition-colors text-center group">
      <div className="text-xl mb-1">&#127468;&#127463;</div>
      <div className="text-sm font-bold text-white group-hover:text-pink-400 transition-colors whitespace-nowrap">West End</div>
      <div className="text-[10px] text-gray-500">London</div>
    </Link>
  );

  const oweCard = (
    <Link key="owe" href="/off-west-end" className="flex-1 p-3 sm:p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-violet-400/30 hover:bg-violet-400/[0.03] transition-colors text-center group">
      <div className="text-xl mb-1">&#127917;</div>
      <div className="text-sm font-bold text-white group-hover:text-violet-400 transition-colors whitespace-nowrap">
        <span className="sm:hidden">Off-W.End</span>
        <span className="hidden sm:inline">Off-West End</span>
      </div>
      <div className="text-[10px] text-gray-500">London</div>
    </Link>
  );

  const operaCard = (
    <Link key="opera" href="/opera" className="flex-1 p-3 sm:p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-amber-400/30 hover:bg-amber-400/[0.03] transition-colors text-center group">
      <div className="text-xl mb-1">&#127914;</div>
      <div className="text-sm font-bold text-white group-hover:text-amber-400 transition-colors whitespace-nowrap">Opera</div>
      <div className="text-[10px] text-gray-500">Met Opera</div>
    </Link>
  );

  return (
    <div className="mb-8 pb-8 border-b border-white/5">
      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Explore More Theatre</h4>
      <div className="flex gap-2 sm:gap-3 flex-wrap">
        {isLondon ? <>{weCard}{oweCard}{obCard}{operaCard}</> : <>{obCard}{weCard}{oweCard}{operaCard}</>}
      </div>
    </div>
  );
}
