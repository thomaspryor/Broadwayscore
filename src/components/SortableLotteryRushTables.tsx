'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { getOptimizedImageUrl } from '@/lib/images';
import { ScoreBadge } from '@/components/show-cards';

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
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** Ensure URLs have https:// prefix */
function ensureHttps(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://' + url;
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
          aVal = a.lotteryData.specialLottery?.price || a.lotteryData.lottery?.price || 999;
          bVal = b.lotteryData.specialLottery?.price || b.lotteryData.lottery?.price || 999;
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
              const price = special?.price || lottery?.price;
              const score = item.show.criticScore?.score;

              return (
                <tr key={item.show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <Link href={`/show/${item.show.slug}`} className="text-white hover:text-brand transition-colors font-medium">
                      {item.show.title}
                    </Link>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-300 font-semibold">
                      <TicketIcon className="w-3.5 h-3.5" />
                      ${price}
                    </span>
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell">
                    {(() => {
                      const platform = lottery?.platform || special?.platform;
                      const url = ensureHttps(lottery?.url || special?.url);
                      if (!platform) return <span className="text-gray-500">—</span>;
                      if (url) {
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
          aVal = a.sroData.standingRoom?.price || 999;
          bVal = b.sroData.standingRoom?.price || 999;
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
              <th className="text-left py-3 px-4 text-gray-400 font-medium hidden sm:table-cell">Box Office</th>
              <th className={`text-center hidden md:table-cell ${headerClass}`} onClick={() => handleSort('score')}>
                Score
                <SortIcon direction={sortDirection} active={sortColumn === 'score'} />
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => {
              const price = item.sroData.standingRoom?.price;
              const score = item.show.criticScore?.score;

              return (
                <tr key={item.show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <Link href={`/show/${item.show.slug}`} className="text-white hover:text-brand transition-colors font-medium">
                      {item.show.title}
                    </Link>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-500/15 border border-gray-500/30 text-gray-300 font-semibold">
                      <TicketIcon className="w-3.5 h-3.5" />
                      {price != null ? `$${price}` : '—'}
                    </span>
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell">
                    {item.show.officialUrl ? (
                      <a href={item.show.officialUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-gray-300 hover:text-white font-medium transition-colors text-sm">
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
  studentRush?: { price: number; time?: string } | null;
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
            a.rushData.rush?.price || 999,
            a.rushData.digitalRush?.price || 999,
            a.rushData.studentRush?.price || 999
          );
          bVal = Math.min(
            b.rushData.rush?.price || 999,
            b.rushData.digitalRush?.price || 999,
            b.rushData.studentRush?.price || 999
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
                rush?.price || 999,
                digital?.price || 999,
                student?.price || 999
              );
              const rushType = rush ? 'Box Office' : digital ? 'Digital' : 'Student';
              const score = item.show.criticScore?.score;

              return (
                <tr key={item.show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <Link href={`/show/${item.show.slug}`} className="text-white hover:text-brand transition-colors font-medium">
                      {item.show.title}
                    </Link>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
                      <TicketIcon className="w-3.5 h-3.5" />
                      ${cheapestPrice}
                    </span>
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell">
                    <div className="flex flex-wrap gap-1 items-center">
                      {rush && (() => {
                        const url = ensureHttps(rush.url) || (rush.platform ? undefined : item.show.officialUrl);
                        const label = rush.platform || 'Box Office';
                        if (url) {
                          return <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-emerald-400 hover:text-emerald-300 font-medium transition-colors">{label}<ExternalLinkIcon /></a>;
                        }
                        return <span className="text-emerald-400">{label}</span>;
                      })()}
                      {digital && (() => {
                        const url = ensureHttps(digital.url);
                        const label = digital.platform || 'Digital';
                        const prefix = rush ? ' + ' : '';
                        if (url) {
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
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
