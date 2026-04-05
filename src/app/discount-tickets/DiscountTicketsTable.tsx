'use client';

import { Fragment, useState, useMemo } from 'react';
import Link from 'next/link';
import { ScoreBadge } from '@/components/show-cards';
import { ensureHttps } from '@/lib/url-utils';
import { buildAffiliateUrl } from '@/lib/affiliate-utils';

type SortDirection = 'asc' | 'desc';
type SortColumn = 'show' | 'lottery' | 'rush' | 'sro' | 'score';

export interface DiscountShowRow {
  slug: string;
  title: string;
  score: number | null;
  lottery: {
    price: number;
    label: string;
    platform: string | null;
    url: string | null;
    time: string | null;
    instructions: string | null;
  } | null;
  rush: {
    price: number;
    label: string;
    platform: string | null;
    url: string | null;
    time: string | null;
    location: string | null;
    instructions: string | null;
  } | null;
  sro: {
    price: number;
    time: string | null;
    instructions: string | null;
  } | null;
}

function SortIcon({ direction, active }: { direction: SortDirection; active: boolean }) {
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

function ExternalLinkIcon() {
  return (
    <svg className="w-3 h-3 inline-block ml-0.5 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

function PriceCell({ price, url, platform, color, bgColor }: { price: number; url?: string; platform?: string; color: string; bgColor: string }) {
  const badge = (
    <span className={`inline-flex items-center gap-0.5 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-md sm:rounded-lg border text-xs sm:text-sm font-semibold ${bgColor} ${color}`}>
      ${price}
      {url && <ExternalLinkIcon />}
    </span>
  );

  if (url) {
    const href = buildAffiliateUrl(ensureHttps(url)!, platform || '', 'discount-tickets').url;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="hover:brightness-125 transition-all">
        {badge}
      </a>
    );
  }
  return badge;
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

function DetailPanel({ row }: { row: DiscountShowRow }) {
  const hasSections = row.lottery || row.rush || row.sro;
  if (!hasSections) return null;

  return (
    <tr className="bg-white/[0.02] border-b border-white/5">
      <td colSpan={6} className="px-4 py-2">
        <div className="flex flex-col sm:flex-row gap-2">
          {row.lottery && (
            <div className="flex-1 bg-purple-500/10 border border-purple-500/20 rounded-lg p-3">
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className="font-semibold text-purple-300 text-sm">{row.lottery.label}</span>
                <span className="font-bold text-white text-lg">${row.lottery.price}</span>
              </div>
              {row.lottery.time && (
                <div className="flex items-start gap-1.5 text-gray-400 text-xs mb-1">
                  <ClockIcon />
                  <span>{row.lottery.time}</span>
                </div>
              )}
              {row.lottery.instructions && (
                <p className="text-gray-400 text-xs leading-relaxed">{row.lottery.instructions}</p>
              )}
              {row.lottery.url && (
                <a
                  href={buildAffiliateUrl(ensureHttps(row.lottery.url)!, row.lottery.platform || '', 'lottery').url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-purple-400 hover:text-purple-300 font-medium text-xs mt-2 transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  Enter on {row.lottery.platform || 'website'}
                  <ActionLinkIcon />
                </a>
              )}
            </div>
          )}

          {row.rush && (
            <div className="flex-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className="font-semibold text-emerald-300 text-sm">{row.rush.label}</span>
                <span className="font-bold text-white text-lg">${row.rush.price}</span>
              </div>
              {row.rush.time && (
                <div className="flex items-start gap-1.5 text-gray-400 text-xs mb-1">
                  <ClockIcon />
                  <span>{row.rush.time}</span>
                </div>
              )}
              {row.rush.location && (
                <p className="text-gray-400 text-xs">{row.rush.location}</p>
              )}
              {row.rush.instructions && (
                <p className="text-gray-400 text-xs leading-relaxed">{row.rush.instructions}</p>
              )}
              {row.rush.url && (
                <a
                  href={buildAffiliateUrl(ensureHttps(row.rush.url)!, row.rush.platform || '', 'rush').url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 font-medium text-xs mt-2 transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  Get on {row.rush.platform || 'website'}
                  <ActionLinkIcon />
                </a>
              )}
            </div>
          )}

          {row.sro && (
            <div className="flex-1 bg-gray-500/10 border border-gray-500/20 rounded-lg p-3">
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className="font-semibold text-gray-300 text-sm">Standing Room</span>
                <span className="font-bold text-white text-lg">${row.sro.price}</span>
              </div>
              {row.sro.time && (
                <div className="flex items-start gap-1.5 text-gray-400 text-xs mb-1">
                  <ClockIcon />
                  <span>{row.sro.time}</span>
                </div>
              )}
              {row.sro.instructions && (
                <p className="text-gray-400 text-xs leading-relaxed">{row.sro.instructions}</p>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

interface DiscountTicketsTableProps {
  rows: DiscountShowRow[];
}

export function DiscountTicketsTable({ rows }: DiscountTicketsTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'score' ? 'desc' : 'asc');
    }
  };

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      let aVal: number | string | null = null;
      let bVal: number | string | null = null;

      switch (sortColumn) {
        case 'show':
          aVal = a.title.toLowerCase();
          bVal = b.title.toLowerCase();
          break;
        case 'lottery':
          aVal = a.lottery?.price ?? null;
          bVal = b.lottery?.price ?? null;
          break;
        case 'rush':
          aVal = a.rush?.price ?? null;
          bVal = b.rush?.price ?? null;
          break;
        case 'sro':
          aVal = a.sro?.price ?? null;
          bVal = b.sro?.price ?? null;
          break;
        case 'score':
          aVal = a.score;
          bVal = b.score;
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
  }, [rows, sortColumn, sortDirection]);

  const headerClass = "py-3 px-1.5 sm:px-3 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group text-sm";

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 px-2 sm:px-3 text-gray-400 font-medium text-sm w-6 sm:w-8 hidden sm:table-cell">#</th>
              <th className={`text-left ${headerClass}`} onClick={() => handleSort('show')}>
                Show
                <SortIcon direction={sortDirection} active={sortColumn === 'show'} />
              </th>
              <th className={`text-center ${headerClass}`} onClick={() => handleSort('lottery')}>
                Lottery
                <SortIcon direction={sortDirection} active={sortColumn === 'lottery'} />
              </th>
              <th className={`text-center ${headerClass}`} onClick={() => handleSort('rush')}>
                Rush
                <SortIcon direction={sortDirection} active={sortColumn === 'rush'} />
              </th>
              <th className={`text-center ${headerClass}`} onClick={() => handleSort('sro')}>
                SRO
                <SortIcon direction={sortDirection} active={sortColumn === 'sro'} />
              </th>
              <th className={`text-center hidden md:table-cell ${headerClass}`} onClick={() => handleSort('score')}>
                Score
                <SortIcon direction={sortDirection} active={sortColumn === 'score'} />
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, index) => {
              const isExpanded = expandedSlug === row.slug;
              const hasDetails = row.lottery || row.rush || row.sro;

              return (
                <Fragment key={row.slug}>
                  <tr
                    className={`border-b border-white/5 hover:bg-white/5 transition-colors ${hasDetails ? 'cursor-pointer' : ''} ${isExpanded ? 'border-b-0' : ''}`}
                    onClick={() => hasDetails && setExpandedSlug(isExpanded ? null : row.slug)}
                    aria-expanded={hasDetails ? isExpanded : undefined}
                  >
                    <td className="py-3 px-2 sm:px-3 w-6 sm:w-8 hidden sm:table-cell">
                      <span className="text-gray-500 text-xs font-bold">
                        {index + 1}
                      </span>
                    </td>
                    <td className="py-3 px-2 sm:px-3">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Link
                          href={`/show/${row.slug}`}
                          className="text-white hover:text-brand transition-colors font-medium text-sm sm:text-base truncate"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {row.title}
                        </Link>
                        {hasDetails && (
                          <span className="shrink-0">
                            <ChevronIcon open={isExpanded} />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-1.5 sm:px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {row.lottery ? (
                        <PriceCell
                          price={row.lottery.price}
                          url={row.lottery.url || undefined}
                          platform={row.lottery.platform || undefined}
                          color="text-purple-300"
                          bgColor="bg-purple-500/15 border-purple-500/30"
                        />
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="py-3 px-1.5 sm:px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {row.rush ? (
                        <PriceCell
                          price={row.rush.price}
                          url={row.rush.url || undefined}
                          platform={row.rush.platform || undefined}
                          color="text-emerald-300"
                          bgColor="bg-emerald-500/15 border-emerald-500/30"
                        />
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="py-3 px-1.5 sm:px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {row.sro ? (
                        <PriceCell
                          price={row.sro.price}
                          url={undefined}
                          color="text-gray-300"
                          bgColor="bg-gray-500/15 border-gray-500/30"
                        />
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="py-3 px-2 sm:px-3 text-center hidden md:table-cell">
                      <ScoreBadge score={row.score} size="sm" showCrown />
                    </td>
                  </tr>
                  {isExpanded && <DetailPanel row={row} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
