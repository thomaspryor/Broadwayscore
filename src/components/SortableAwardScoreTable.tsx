'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { AwardScoreBadge, AWARD_TIER_LABEL } from '@/components/show-cards/AwardScoreBadge';
import type { ScoreResult, CeremonyContribution } from '@/lib/awards-scoring';

type SortDirection = 'asc' | 'desc';
type SortColumn = 'show' | 'score';

interface ShowAwardData {
  show: {
    slug: string;
    title: string;
  };
  awardScore: ScoreResult;
}

// Maps full ceremony names to compact labels for pills
const CEREMONY_SHORT: Record<string, string> = {
  'Tony Awards': 'Tony',
  'Pulitzer Prize': 'Pulitzer',
  'Olivier Awards': 'Olivier',
  'Drama Desk': 'Drama Desk',
  'Outer Critics Circle': 'OCC',
  'Drama League': 'Drama League',
  "NY Drama Critics' Circle": 'NYDCC',
};

function categoryShort(category: string): string {
  const c = category.toLowerCase();
  if (/best musical$|outstanding musical/.test(c)) return 'Best Musical';
  if (/best play$|outstanding play/.test(c)) return 'Best Play';
  if (/revival of a musical/.test(c)) return 'Best Revival (Musical)';
  if (/revival of a play/.test(c)) return 'Best Revival (Play)';
  if (/best.*score|outstanding.*score/.test(c)) return 'Best Score';
  if (/best book|outstanding book/.test(c)) return 'Best Book';
  if (/direction|director/.test(c)) return 'Direction';
  if (/choreograph/.test(c)) return 'Choreography';
  if (/distinguished performance|best actor|best actress|lead.*performance|lead.*performer/.test(c)) return 'Lead Performance';
  if (/featured/.test(c)) return 'Featured Performance';
  if (/^drama$/.test(c)) return 'Drama';
  return category.length > 22 ? category.slice(0, 22) + '…' : category;
}

interface Highlight { label: string; isWin: boolean }

function computeHighlights(breakdown: CeremonyContribution[]): Highlight[] {
  const wins: { label: string; tierRank: number; points: number }[] = [];
  let totalNoms = 0;
  let tonyNoms = 0;

  const tierRank: Record<string, number> = { S: 0, 'A+': 1, A: 2, B: 3, C: 4 };

  for (const cer of breakdown) {
    const short = CEREMONY_SHORT[cer.ceremony] ?? cer.ceremony;
    const seen = new Map<string, number>(); // category → count
    for (const item of cer.items) {
      if (item.result === 'win') {
        seen.set(item.category, (seen.get(item.category) ?? 0) + 1);
      } else {
        totalNoms++;
        if (cer.ceremony === 'Tony Awards') tonyNoms++;
      }
    }
    for (const [cat, count] of Array.from(seen)) {
      const item = cer.items.find(i => i.category === cat && i.result === 'win')!;
      const suffix = count > 1 ? ` ×${count}` : '';
      wins.push({
        label: `${short} · ${categoryShort(cat)}${suffix}`,
        tierRank: tierRank[item.tier] ?? 5,
        points: item.points,
      });
    }
  }

  wins.sort((a, b) => a.tierRank !== b.tierRank ? a.tierRank - b.tierRank : b.points - a.points);
  const highlights: Highlight[] = wins.slice(0, 3).map(w => ({ label: w.label, isWin: true }));

  if (highlights.length < 2 && totalNoms > 0) {
    const nomLabel = tonyNoms > 0
      ? `${tonyNoms} Tony Nom${tonyNoms !== 1 ? 's' : ''}`
      : `${totalNoms} Nomination${totalNoms !== 1 ? 's' : ''}`;
    highlights.push({ label: nomLabel, isWin: false });
  }

  return highlights;
}

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) {
    return <span className="ml-1 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">↕</span>;
  }
  return <span className="ml-1 text-brand">{direction === 'asc' ? '↑' : '↓'}</span>;
}

interface SortableAwardScoreTableProps {
  data: ShowAwardData[];
}

export function SortableAwardScoreTable({ data }: SortableAwardScoreTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('score');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const handleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(col);
      setSortDirection(col === 'show' ? 'asc' : 'desc');
    }
  };

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => {
      if (sortColumn === 'show') {
        const cmp = a.show.title.toLowerCase().localeCompare(b.show.title.toLowerCase());
        return sortDirection === 'asc' ? cmp : -cmp;
      }
      const diff = (a.awardScore.displayScore ?? 0) - (b.awardScore.displayScore ?? 0);
      return sortDirection === 'asc' ? diff : -diff;
    });
  }, [data, sortColumn, sortDirection]);

  const headerClass = 'py-3 px-4 text-gray-400 font-medium cursor-pointer hover:text-white transition-colors select-none group';

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-surface-overlay">
              <th className="text-left py-3 px-4 text-gray-400 font-medium">#</th>
              <th className={`text-left ${headerClass}`} onClick={() => handleSort('show')}>
                Show
                <SortIcon active={sortColumn === 'show'} direction={sortDirection} />
              </th>
              <th className={`text-center ${headerClass}`} onClick={() => handleSort('score')}>
                Score
                <SortIcon active={sortColumn === 'score'} direction={sortDirection} />
              </th>
              <th className="text-left py-3 px-4 text-gray-400 font-medium hidden sm:table-cell">Tier</th>
              <th className="text-center py-3 px-4 text-gray-400 font-medium hidden md:table-cell">Tony Wins / Noms</th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item, index) => {
              const { awardScore, show } = item;
              const highlights = computeHighlights(awardScore.breakdown);
              const tonyRecord = awardScore.tonyWins > 0 || awardScore.tonyNoms > 0
                ? `${awardScore.tonyWins}W · ${awardScore.tonyNoms}N`
                : '—';

              return (
                <tr key={show.slug} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="py-3 px-4 align-top">
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      index < 3 ? 'bg-accent-gold text-gray-900' : 'text-gray-500'
                    }`}>
                      {index + 1}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <Link href={`/show/${show.slug}`} className="text-white hover:text-brand transition-colors font-medium">
                        {show.title}
                      </Link>
                      {awardScore.inProgress && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-700/40">
                          In Progress
                        </span>
                      )}
                    </div>
                    {highlights.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {highlights.map((h, i) => (
                          <span
                            key={i}
                            className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                              h.isWin
                                ? 'bg-amber-500/15 text-amber-300 border border-amber-600/30'
                                : 'bg-white/5 text-gray-400 border border-white/10'
                            }`}
                          >
                            {h.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4 text-center align-top">
                    <AwardScoreBadge
                      score={awardScore.displayScore}
                      badge={awardScore.badge}
                      inProgress={awardScore.inProgress}
                      size="md"
                    />
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell align-top">
                    <span className="text-gray-400 text-sm">{AWARD_TIER_LABEL[awardScore.badge]}</span>
                  </td>
                  <td className="py-3 px-4 text-center hidden md:table-cell align-top">
                    <span className="text-gray-400 text-sm">{tonyRecord}</span>
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
