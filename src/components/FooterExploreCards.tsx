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
    <Link key="ob" href="/off-broadway" className="flex-1 p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-brand/30 hover:bg-brand/[0.03] transition-colors text-center group">
      <div className="text-xl mb-1">&#127914;</div>
      <div className="text-sm font-bold text-white group-hover:text-brand transition-colors">Off-Broadway</div>
      <div className="text-[10px] text-gray-500">NYC</div>
    </Link>
  );

  const weCard = (
    <Link key="we" href="/west-end" className="flex-1 p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-pink-400/30 hover:bg-pink-400/[0.03] transition-colors text-center group">
      <div className="text-xl mb-1">&#127468;&#127463;</div>
      <div className="text-sm font-bold text-white group-hover:text-pink-400 transition-colors">West End</div>
      <div className="text-[10px] text-gray-500">London</div>
    </Link>
  );

  const oweCard = (
    <Link key="owe" href="/off-west-end" className="flex-1 p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:border-violet-400/30 hover:bg-violet-400/[0.03] transition-colors text-center group">
      <div className="text-xl mb-1">&#127917;</div>
      <div className="text-sm font-bold text-white group-hover:text-violet-400 transition-colors">Off-West End</div>
      <div className="text-[10px] text-gray-500">London</div>
    </Link>
  );

  return (
    <div className="mb-8 pb-8 border-b border-white/5">
      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Explore More Theatre</h4>
      <div className="flex gap-3">
        {isLondon ? <>{weCard}{oweCard}{obCard}</> : <>{obCard}{weCard}{oweCard}</>}
      </div>
    </div>
  );
}
