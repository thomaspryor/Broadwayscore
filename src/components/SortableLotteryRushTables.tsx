'use client';

import { Fragment, useState, useMemo } from 'react';
import Link from 'next/link';
import { getOptimizedImageUrl } from '@/lib/images';
import { ScoreBadge } from '@/components/show-cards';
import { ensureHttps } from '@/lib/url-utils';
import { buildAffiliateUrl } from '@/lib/affiliate-utils';

type SortDirection = 'asc' | 'desc';

function TicketIcon({ className }: { className?: string }) {
  return (
    <svg className={className || "w-4 h-4"} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg className="w-3 h-3 inline-block ml-0.5 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function ActionLinkIcon() {
  return (
    <svg className="w-3.5 h-3.5 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

function SortIcon({ direction, active }: { direction: SortDirection | null; active: boolean }) {
  if (!active) {
    return (
      <span className="ml-1 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
        ↕
      </span>
    );
  }
  return (
    <span className="ml-1 text-brand">
      {direction === 'asc' ? '↑' : '↓'}
    </span>
  );
}

// ============ LOTTERY TABLE ============

interface LotteryInfo {
  type?: string;
  platform?: string;
  url?: string;
  price: number;
  time?: string;
  instructions?: string;
}

interface SpecialLotteryInfo {
  name: string;
  platform?: string;
  url?: string;
  price: number;
  instructions?: string;
}

interface LotteryData {
  lottery: LotteryInfo | null;
  specialLottery?: SpecialLotteryInfo | null;
  rush?: { price: number } | null;
  digitalRush?: { price: number } | null;
  studentRush?: { price: number } | null;
  standingRoom?: { price: number } | null;
}

interface ShowLotteryData {
  show: {
    slug: string;
    title: string;
    status: string;
    images?: { thumbnail?: string } | null;
    criticScore?: { score?: number | null; reviewCount?: number | null } | null;
  };
  lotteryData: LotteryData;
}

type LotteryColumn = 'show' | 'price' | 'platform' | 'score';

interface LotteryTableProps {
  data: ShowLotteryData[];
}

export function LotteryTable({ data }: LotteryTableProps) {
  const [sortColumn, setSortColumn] = useState<LotteryColumn>('score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  const handleSort = (column: LotteryColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'score' ? 'desc' : 'asc');
    }
  };

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      let aVal: string | number | null = null;
      let bVal: string | number | null = null;

      switch (sortColumn) {
        case 'show':
          aVal = a.show.title.toLowerCase();
          bVal = b.show.title.toLowerCase();
          break;
        case 'price':
          aVal = a.lotteryData.specialLottery?.price ?? a.lotteryData.lottery?.price ?? 999;
          bVal = b.lotteryData.specialLottery?.price ?? b.lotteryData.lottery?.price ?? 999;
          break;
        case 'platform':
          aVal = a.lotteryData.lottery?.platform?.toLowerCase() || '';
          bVal = b.lotteryData.lottery?.platform?.toLowerCase() || '';
          break;
        case 'score':
          aVal = a.show.criticScore?.score ?? null;
          bVal = b.show.criticScore?.score ?? null;
          break;
      }

      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      const numA = aVal as number;
      const numB = bVal as number;
      return sortDirection === 'asc' ? numA - numB : numB - numA;
    });
  }, [data, sortColumn, sortDirection]);

  const headerClass = "py-3 px-4 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group";

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 px-4 text-gray-400 font-medium">#</th>
              <th className={`text-left ${headerClass}`} onClick={() => handleSort('show')}>
                Show
                <SortIcon direction={sortDirection} active={sortColumn === 'show'} />
              </th>
              <th className={`text-right ${headerClass}`} onClick={() => handleSort('price')}>
                Price
                <SortIcon direction={sortDirection} active={sortColumn === 'price'} />
              </th>
              <th className={`text-left hidden sm:table-cell ${headerClass}`} onClick={() => handleSort('platform')}>
                Enter via
                <SortIcon direction={sortDirection} active={sortColumn === 'platform'} />
              </th>
              <th className={`text-center hidden md:table-cell ${headerClass}`} onClick={() => handleSort('score')}>
                Score
                <SortIcon direction={sortDirection} active={sortColumn === 'score'} />
              </th>
              <th className="text-center py-3 px-4 text-gray-400 font-medium hidden lg:table-cell">Other Options</th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => {
              const lottery = item.lotteryData.lottery;
              const special = item.lotteryData.specialLottery;
              const price = special?.price ?? lottery?.price;
              const score = item.show.criticScore?.score;
              const isExpanded = expandedSlug === item.show.slug;
              const hasDetails = !!(lottery || special);

              return (
                <Fragment key={item.show.slug}>
                  <tr
                    className={`border-b border-white/5 hover:bg-white/5 transition-colors ${hasDetails ? 'cursor-pointer' : ''} ${isExpanded ? 'border-b-0' : ''}`}
                    onClick={() => hasDetails && setExpandedSlug(isExpanded ? null : item.show.slug)}
                    aria-expanded={hasDetails ? isExpanded : undefined}
                  >
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <Link href={`/show/${item.show.slug}`} className="text-white hover:text-brand transition-colors font-medium" onClick={(e) => e.stopPropagation()}>
                        {item.show.title}
                      </Link>
                      {hasDetails && <ChevronIcon open={isExpanded} />}
                    </div>
                    {(() => {
                      const platform = lottery?.platform || special?.platform;
                      return platform ? <span className="block text-xs text-gray-500 sm:hidden">{platform}</span> : null;
                    })()}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-300 font-semibold">
                      <TicketIcon className="w-3.5 h-3.5" />
                      {price != null ? `$${price}` : '—'}
                    </span>
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell" onClick={(e) => e.stopPropagation()}>
                    {(() => {
                      const platform = lottery?.platform || special?.platform;
                      const rawUrl = ensureHttps(lottery?.url || special?.url);
                      if (!platform) return <span className="text-gray-500">—</span>;
                      if (rawUrl) {
                        const url = buildAffiliateUrl(rawUrl, platform || '', 'lottery').url;
                        return (
                          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-purple-400 hover:text-purple-300 font-medium transition-colors">
                            {platform}<ExternalLinkIcon />
                          </a>
                        );
                      }
                      return <span className="text-gray-300">{platform}</span>;
                    })()}
                  </td>
                  <td className="py-3 px-4 text-center hidden md:table-cell">
                    <ScoreBadge score={score} size="sm" showCrown />
                  </td>
                  <td className="py-3 px-4 text-center hidden lg:table-cell">
                    <div className="flex flex-wrap gap-1 justify-center">
                      {item.lotteryData.rush && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                          Rush
                        </span>
                      )}
                      {item.lotteryData.standingRoom && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-400">
                          SRO
                        </span>
                      )}
                      {!item.lotteryData.rush && !item.lotteryData.standingRoom && (
                        <span className="text-gray-500">—</span>
                      )}
                    </div>
                  </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-white/[0.02] border-b border-white/5">
                      <td colSpan={6} className="px-4 py-2">
                        <div className="flex flex-col sm:flex-row gap-2">
                          {lottery && (
                            <div className="flex-1 bg-purple-500/10 border border-purple-500/20 rounded-lg p-3">
                              <div className="flex items-start justify-between gap-2 mb-2">
                                <span className="font-semibold text-purple-300 text-sm">{lottery.type ? `${lottery.type.charAt(0).toUpperCase() + lottery.type.slice(1)} Lottery` : 'Digital Lottery'}</span>
                                <span className="font-bold text-white text-lg">${lottery.price}</span>
                              </div>
                              {lottery.time && (
                                <div className="flex items-start gap-1.5 text-gray-400 text-xs mb-1">
                                  <ClockIcon />
                                  <span>{lottery.time}</span>
                                </div>
                              )}
                              {lottery.instructions && (
                                <p className="text-gray-400 text-xs leading-relaxed">{lottery.instructions}</p>
                              )}
                              {lottery.url && (
                                <a
                                  href={buildAffiliateUrl(ensureHttps(lottery.url)!, lottery.platform || '', 'lottery').url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 text-purple-400 hover:text-purple-300 font-medium text-xs mt-2 transition-colors"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  Enter on {lottery.platform || 'website'}
                                  <ActionLinkIcon />
                                </a>
                              )}
                            </div>
                          )}
                          {special && (
                            <div className="flex-1 bg-purple-500/10 border border-purple-500/20 rounded-lg p-3">
                              <div className="flex items-start justify-between gap-2 mb-2">
                                <span className="font-semibold text-purple-300 text-sm">{special.name}</span>
                                <span className="font-bold text-white text-lg">${special.price}</span>
                              </div>
                              {special.instructions && (
                                <p className="text-gray-400 text-xs leading-relaxed">{special.instructions}</p>
                              )}
                              {special.url && (
                                <a
                                  href={buildAffiliateUrl(ensureHttps(special.url)!, special.platform || '', 'lottery').url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 text-purple-400 hover:text-purple-300 font-medium text-xs mt-2 transition-colors"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  Enter on {special.platform || 'website'}
                                  <ActionLinkIcon />
                                </a>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ STANDING ROOM TABLE ============

interface SROData {
  standingRoom: { price: number; time?: string; instructions?: string } | null;
  lottery?: { price: number } | null;
  rush?: { price: number } | null;
}

interface ShowSROData {
  show: {
    slug: string;
    title: string;
    status: string;
    images?: { thumbnail?: string } | null;
    criticScore?: { score?: number | null; reviewCount?: number | null } | null;
    officialUrl?: string;
    venue?: string;
  };
  sroData: SROData;
}

type SROColumn = 'show' | 'price' | 'score';

interface StandingRoomTableProps {
  data: ShowSROData[];
}

export function StandingRoomTable({ data }: StandingRoomTableProps) {
  const [sortColumn, setSortColumn] = useState<SROColumn>('price');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  const handleSort = (column: SROColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'score' ? 'desc' : 'asc');
    }
  };

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      let aVal: string | number | null = null;
      let bVal: string | number | null = null;

      switch (sortColumn) {
        case 'show':
          aVal = a.show.title.toLowerCase();
          bVal = b.show.title.toLowerCase();
          break;
        case 'price':
          aVal = a.sroData.standingRoom?.price ?? 999;
          bVal = b.sroData.standingRoom?.price ?? 999;
          break;
        case 'score':
          aVal = a.show.criticScore?.score ?? null;
          bVal = b.show.criticScore?.score ?? null;
          break;
      }

      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      const numA = aVal as number;
      const numB = bVal as number;
      return sortDirection === 'asc' ? numA - numB : numB - numA;
    });
  }, [data, sortColumn, sortDirection]);

  const headerClass = "py-3 px-4 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group";

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 px-4 text-gray-400 font-medium">#</th>
              <th className={`text-left ${headerClass}`} onClick={() => handleSort('show')}>
                Show
                <SortIcon direction={sortDirection} active={sortColumn === 'show'} />
              </th>
              <th className={`text-right ${headerClass}`} onClick={() => handleSort('price')}>
                Price
                <SortIcon direction={sortDirection} active={sortColumn === 'price'} />
              </th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium hidden sm:table-cell">Official Site</th>
              <th className={`text-center hidden md:table-cell ${headerClass}`} onClick={() => handleSort('score')}>
                Score
                <SortIcon direction={sortDirection} active={sortColumn === 'score'} />
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => {
              const sro = item.sroData.standingRoom;
              const price = sro?.price;
              const score = item.show.criticScore?.score;
              const isExpanded = expandedSlug === item.show.slug;
              const hasDetails = !!sro;

              return (
                <Fragment key={item.show.slug}>
                  <tr
                    className={`border-b border-white/5 hover:bg-white/5 transition-colors ${hasDetails ? 'cursor-pointer' : ''} ${isExpanded ? 'border-b-0' : ''}`}
                    onClick={() => hasDetails && setExpandedSlug(isExpanded ? null : item.show.slug)}
                    aria-expanded={hasDetails ? isExpanded : undefined}
                  >
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <Link href={`/show/${item.show.slug}`} className="text-white hover:text-brand transition-colors font-medium" onClick={(e) => e.stopPropagation()}>
                        {item.show.title}
                      </Link>
                      {hasDetails && <ChevronIcon open={isExpanded} />}
                    </div>
                    {item.show.venue && <span className="block text-xs text-gray-500 sm:hidden">{item.show.venue}</span>}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-500/15 border border-gray-500/30 text-gray-300 font-semibold">
                      <TicketIcon className="w-3.5 h-3.5" />
                      {price != null ? `$${price}` : '—'}
                    </span>
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell" onClick={(e) => e.stopPropagation()}>
                    {item.show.officialUrl ? (
                      <a href={ensureHttps(item.show.officialUrl) || '#'} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-gray-300 hover:text-white font-medium transition-colors text-sm">
                        {item.show.venue ? item.show.venue.replace(/ Theatre| Theater/i, '') : 'Official site'}
                        <ExternalLinkIcon />
                      </a>
                    ) : (
                      <span className="text-gray-500">In person</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-center hidden md:table-cell">
                    <ScoreBadge score={score} size="sm" showCrown />
                  </td>
                  </tr>
                  {isExpanded && sro && (
                    <tr className="bg-white/[0.02] border-b border-white/5">
                      <td colSpan={5} className="px-4 py-2">
                        <div className="flex flex-col sm:flex-row gap-2">
                          <div className="flex-1 bg-gray-500/10 border border-gray-500/20 rounded-lg p-3">
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <span className="font-semibold text-gray-300 text-sm">Standing Room</span>
                              <span className="font-bold text-white text-lg">${sro.price}</span>
                            </div>
                            {sro.time && (
                              <div className="flex items-start gap-1.5 text-gray-400 text-xs mb-1">
                                <ClockIcon />
                                <span>{sro.time}</span>
                              </div>
                            )}
                            {sro.instructions && (
                              <p className="text-gray-400 text-xs leading-relaxed">{sro.instructions}</p>
                            )}
                            {item.show.officialUrl && (
                              <a
                                href={ensureHttps(item.show.officialUrl) || '#'}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 text-gray-400 hover:text-gray-300 font-medium text-xs mt-2 transition-colors"
                                onClick={(e) => e.stopPropagation()}
                              >
                                Official site
                                <ActionLinkIcon />
                              </a>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ RUSH TABLE ============

interface RushInfo {
  type?: string;
  platform?: string;
  url?: string;
  price: number;
  time?: string;
  location?: string;
  instructions?: string;
}

interface RushData {
  rush: RushInfo | null;
  digitalRush?: RushInfo | null;
  studentRush?: RushInfo | null;
  lottery?: { price: number } | null;
  standingRoom?: { price: number } | null;
}

interface ShowRushData {
  show: {
    slug: string;
    title: string;
    status: string;
    images?: { thumbnail?: string } | null;
    criticScore?: { score?: number | null; reviewCount?: number | null } | null;
    officialUrl?: string;
  };
  rushData: RushData;
}

type RushColumn = 'show' | 'price' | 'type' | 'score';

interface RushTableProps {
  data: ShowRushData[];
}

export function RushTable({ data }: RushTableProps) {
  const [sortColumn, setSortColumn] = useState<RushColumn>('score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  const handleSort = (column: RushColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'score' ? 'desc' : 'asc');
    }
  };

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      let aVal: string | number | null = null;
      let bVal: string | number | null = null;

      switch (sortColumn) {
        case 'show':
          aVal = a.show.title.toLowerCase();
          bVal = b.show.title.toLowerCase();
          break;
        case 'price':
          aVal = Math.min(
            a.rushData.rush?.price ?? 999,
            a.rushData.digitalRush?.price ?? 999,
            a.rushData.studentRush?.price ?? 999
          );
          bVal = Math.min(
            b.rushData.rush?.price ?? 999,
            b.rushData.digitalRush?.price ?? 999,
            b.rushData.studentRush?.price ?? 999
          );
          break;
        case 'type':
          aVal = a.rushData.rush ? 'box office' : a.rushData.digitalRush ? 'digital' : 'student';
          bVal = b.rushData.rush ? 'box office' : b.rushData.digitalRush ? 'digital' : 'student';
          break;
        case 'score':
          aVal = a.show.criticScore?.score ?? null;
          bVal = b.show.criticScore?.score ?? null;
          break;
      }

      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      const numA = aVal as number;
      const numB = bVal as number;
      return sortDirection === 'asc' ? numA - numB : numB - numA;
    });
  }, [data, sortColumn, sortDirection]);

  const headerClass = "py-3 px-4 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group";

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 px-4 text-gray-400 font-medium">#</th>
              <th className={`text-left ${headerClass}`} onClick={() => handleSort('show')}>
                Show
                <SortIcon direction={sortDirection} active={sortColumn === 'show'} />
              </th>
              <th className={`text-right ${headerClass}`} onClick={() => handleSort('price')}>
                Price
                <SortIcon direction={sortDirection} active={sortColumn === 'price'} />
              </th>
              <th className={`text-left hidden sm:table-cell ${headerClass}`} onClick={() => handleSort('type')}>
                Enter via
                <SortIcon direction={sortDirection} active={sortColumn === 'type'} />
              </th>
              <th className={`text-center hidden md:table-cell ${headerClass}`} onClick={() => handleSort('score')}>
                Score
                <SortIcon direction={sortDirection} active={sortColumn === 'score'} />
              </th>
              <th className="text-center py-3 px-4 text-gray-400 font-medium hidden lg:table-cell">Other Options</th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => {
              const rush = item.rushData.rush;
              const digital = item.rushData.digitalRush;
              const student = item.rushData.studentRush;
              const cheapestPrice = Math.min(
                rush?.price ?? 999,
                digital?.price ?? 999,
                student?.price ?? 999
              );
              const rushType = rush ? 'Box Office' : digital ? 'Digital' : 'Student';
              const score = item.show.criticScore?.score;
              const isExpanded = expandedSlug === item.show.slug;
              const hasDetails = !!(rush || digital || student);

              return (
                <Fragment key={item.show.slug}>
                  <tr
                    className={`border-b border-white/5 hover:bg-white/5 transition-colors ${hasDetails ? 'cursor-pointer' : ''} ${isExpanded ? 'border-b-0' : ''}`}
                    onClick={() => hasDetails && setExpandedSlug(isExpanded ? null : item.show.slug)}
                    aria-expanded={hasDetails ? isExpanded : undefined}
                  >
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <Link href={`/show/${item.show.slug}`} className="text-white hover:text-brand transition-colors font-medium" onClick={(e) => e.stopPropagation()}>
                        {item.show.title}
                      </Link>
                      {hasDetails && <ChevronIcon open={isExpanded} />}
                    </div>
                    <span className="block text-xs text-gray-500 sm:hidden">{rushType}</span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
                      <TicketIcon className="w-3.5 h-3.5" />
                      ${cheapestPrice}
                    </span>
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap gap-1 items-center">
                      {rush && (() => {
                        const rawUrl = ensureHttps(rush.url) || (rush.platform ? undefined : ensureHttps(item.show.officialUrl));
                        const label = rush.platform || 'Box Office';
                        if (rawUrl) {
                          const url = rush.url ? buildAffiliateUrl(rawUrl, rush.platform || '', 'rush').url : rawUrl;
                          return <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-emerald-400 hover:text-emerald-300 font-medium transition-colors">{label}<ExternalLinkIcon /></a>;
                        }
                        return <span className="text-emerald-400">{label}</span>;
                      })()}
                      {digital && (() => {
                        const rawUrl = ensureHttps(digital.url);
                        const label = digital.platform || 'Digital';
                        const prefix = rush ? ' + ' : '';
                        if (rawUrl) {
                          const url = buildAffiliateUrl(rawUrl, digital.platform || '', 'rush').url;
                          return <>{prefix && <span className="text-gray-500">{prefix}</span>}<a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-blue-400 hover:text-blue-300 font-medium transition-colors">{label}<ExternalLinkIcon /></a></>;
                        }
                        return <span className="text-blue-400">{prefix}{label}</span>;
                      })()}
                      {student && <span className="text-pink-400">{rush || digital ? ' + Student' : 'Student'}</span>}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-center hidden md:table-cell">
                    <ScoreBadge score={score} size="sm" showCrown />
                  </td>
                  <td className="py-3 px-4 text-center hidden lg:table-cell">
                    <div className="flex flex-wrap gap-1 justify-center">
                      {item.rushData.lottery && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                          Lottery
                        </span>
                      )}
                      {item.rushData.standingRoom && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-400">
                          SRO
                        </span>
                      )}
                      {!item.rushData.lottery && !item.rushData.standingRoom && (
                        <span className="text-gray-500">—</span>
                      )}
                    </div>
                  </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-white/[0.02] border-b border-white/5">
                      <td colSpan={6} className="px-4 py-2">
                        <div className="flex flex-col sm:flex-row gap-2">
                          {rush && (
                            <div className="flex-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                              <div className="flex items-start justify-between gap-2 mb-2">
                                <span className="font-semibold text-emerald-300 text-sm">Box Office Rush</span>
                                <span className="font-bold text-white text-lg">${rush.price}</span>
                              </div>
                              {rush.time && (
                                <div className="flex items-start gap-1.5 text-gray-400 text-xs mb-1">
                                  <ClockIcon />
                                  <span>{rush.time}</span>
                                </div>
                              )}
                              {rush.location && (
                                <p className="text-gray-400 text-xs">{rush.location}</p>
                              )}
                              {rush.instructions && (
                                <p className="text-gray-400 text-xs leading-relaxed">{rush.instructions}</p>
                              )}
                              {(() => {
                                const rawUrl = ensureHttps(rush.url) || (rush.platform ? undefined : ensureHttps(item.show.officialUrl));
                                if (rawUrl) {
                                  const url = rush.url ? buildAffiliateUrl(rawUrl, rush.platform || '', 'rush').url : rawUrl;
                                  return (
                                    <a
                                      href={url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 font-medium text-xs mt-2 transition-colors"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      Enter on {rush.platform || 'website'}
                                      <ActionLinkIcon />
                                    </a>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          )}
                          {digital && (
                            <div className="flex-1 bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
                              <div className="flex items-start justify-between gap-2 mb-2">
                                <span className="font-semibold text-blue-300 text-sm">Digital Rush</span>
                                <span className="font-bold text-white text-lg">${digital.price}</span>
                              </div>
                              {digital.time && (
                                <div className="flex items-start gap-1.5 text-gray-400 text-xs mb-1">
                                  <ClockIcon />
                                  <span>{digital.time}</span>
                                </div>
                              )}
                              {digital.location && (
                                <p className="text-gray-400 text-xs">{digital.location}</p>
                              )}
                              {digital.instructions && (
                                <p className="text-gray-400 text-xs leading-relaxed">{digital.instructions}</p>
                              )}
                              {digital.url && (
                                <a
                                  href={buildAffiliateUrl(ensureHttps(digital.url)!, digital.platform || '', 'rush').url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 text-blue-400 hover:text-blue-300 font-medium text-xs mt-2 transition-colors"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  Enter on {digital.platform || 'website'}
                                  <ActionLinkIcon />
                                </a>
                              )}
                            </div>
                          )}
                          {student && (
                            <div className="flex-1 bg-pink-500/10 border border-pink-500/20 rounded-lg p-3">
                              <div className="flex items-start justify-between gap-2 mb-2">
                                <span className="font-semibold text-pink-300 text-sm">Student Rush</span>
                                <span className="font-bold text-white text-lg">${student.price}</span>
                              </div>
                              {student.time && (
                                <div className="flex items-start gap-1.5 text-gray-400 text-xs mb-1">
                                  <ClockIcon />
                                  <span>{student.time}</span>
                                </div>
                              )}
                              {student.location && (
                                <p className="text-gray-400 text-xs">{student.location}</p>
                              )}
                              {student.instructions && (
                                <p className="text-gray-400 text-xs leading-relaxed">{student.instructions}</p>
                              )}
                              {student.url && (
                                <a
                                  href={buildAffiliateUrl(ensureHttps(student.url)!, student.platform || '', 'rush').url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 text-pink-400 hover:text-pink-300 font-medium text-xs mt-2 transition-colors"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  Enter on {student.platform || 'website'}
                                  <ActionLinkIcon />
                                </a>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
