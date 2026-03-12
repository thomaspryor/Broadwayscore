'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { ScoreBadge } from '@/components/show-cards';

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
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function ensureHttps(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://' + url;
}

function PriceCell({ price, url, color, bgColor }: { price: number; url?: string; color: string; bgColor: string }) {
  const badge = (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-sm font-semibold ${bgColor} ${color}`}>
      ${price}
      {url && <ExternalLinkIcon />}
    </span>
  );

  if (url) {
    const href = ensureHttps(url);
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="hover:brightness-125 transition-all">
        {badge}
      </a>
    );
  }
  return badge;
}

function DetailPanel({ row }: { row: DiscountShowRow }) {
  const sections: { label: string; color: string; items: string[] }[] = [];

  if (row.lottery) {
    const items: string[] = [];
    items.push(row.lottery.label + (row.lottery.platform ? ` via ${row.lottery.platform}` : ''));
    if (row.lottery.time) items.push(row.lottery.time);
    if (row.lottery.instructions) items.push(row.lottery.instructions);
    sections.push({ label: 'Lottery', color: 'text-purple-300', items });
  }

  if (row.rush) {
    const items: string[] = [];
    items.push(row.rush.label + (row.rush.platform ? ` via ${row.rush.platform}` : ''));
    if (row.rush.time) items.push(row.rush.time);
    if (row.rush.location) items.push(row.rush.location);
    if (row.rush.instructions) items.push(row.rush.instructions);
    sections.push({ label: 'Rush', color: 'text-emerald-300', items });
  }

  if (row.sro) {
    const items: string[] = [];
    if (row.sro.time) items.push(row.sro.time);
    if (row.sro.instructions) items.push(row.sro.instructions);
    if (items.length === 0) items.push('Available when show is sold out');
    sections.push({ label: 'Standing Room', color: 'text-gray-300', items });
  }

  if (sections.length === 0) return null;

  return (
    <tr className="bg-white/[0.02]">
      <td colSpan={6} className="px-4 py-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          {sections.map(section => (
            <div key={section.label}>
              <div className={`font-semibold ${section.color} mb-1`}>{section.label}</div>
              {section.items.map((item, i) => (
                <p key={i} className="text-gray-400 text-xs leading-relaxed">{item}</p>
              ))}
            </div>
          ))}
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

  const headerClass = "py-3 px-3 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group text-sm";

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 px-3 text-gray-400 font-medium text-sm w-8">#</th>
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
              <th className={`text-center hidden sm:table-cell ${headerClass}`} onClick={() => handleSort('sro')}>
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
                <>
                  <tr
                    key={row.slug}
                    className={`border-b border-white/5 hover:bg-white/5 transition-colors ${hasDetails ? 'cursor-pointer' : ''}`}
                    onClick={() => hasDetails && setExpandedSlug(isExpanded ? null : row.slug)}
                  >
                    <td className="py-3 px-3">
                      <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                        index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                      }`}>
                        {index + 1}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/show/${row.slug}`}
                          className="text-white hover:text-brand transition-colors font-medium"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {row.title}
                        </Link>
                        {hasDetails && (
                          <ChevronIcon open={isExpanded} />
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-center" onClick={(e) => row.lottery?.url && e.stopPropagation()}>
                      {row.lottery ? (
                        <PriceCell
                          price={row.lottery.price}
                          url={row.lottery.url || undefined}
                          color="text-purple-300"
                          bgColor="bg-purple-500/15 border-purple-500/30"
                        />
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-center" onClick={(e) => row.rush?.url && e.stopPropagation()}>
                      {row.rush ? (
                        <PriceCell
                          price={row.rush.price}
                          url={row.rush.url || undefined}
                          color="text-emerald-300"
                          bgColor="bg-emerald-500/15 border-emerald-500/30"
                        />
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-center hidden sm:table-cell">
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
                    <td className="py-3 px-3 text-center hidden md:table-cell">
                      <ScoreBadge score={row.score} size="sm" showCrown />
                    </td>
                  </tr>
                  {isExpanded && <DetailPanel key={`${row.slug}-detail`} row={row} />}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
