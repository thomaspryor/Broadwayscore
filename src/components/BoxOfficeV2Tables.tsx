'use client';

/**
 * /box-office tables with cost status (BRO-5007 Phase 3, unreleased): the
 * "This week" table gains Status and Vs. its cost; "All time" is today's
 * leaderboard behind a tab. Loaded with dynamic() only when
 * featureFlags.commercial && boxOfficeV2, so a flag-off page never ships it.
 */
import { useMemo, useState } from 'react';
import { ThisWeekTable, AllTimeTable, type ExtraColumn } from '@/components/SortableBoxOfficeTable';
import type { CostStatusCell, PillTone } from '@/lib/box-office-v2-display';

type Rows = Parameters<typeof ThisWeekTable>[0]['data'];

const TONE_TEXT: Record<PillTone, string> = {
  above: 'text-status-open',
  near: 'text-gray-300',
  below: 'text-score-tepid',
  muted: 'text-gray-400',
  pending: 'text-gray-500',
};

interface Props {
  thisWeek: Rows;
  allTime: Parameters<typeof AllTimeTable>[0]['data'];
  /** Keyed by slug; a missing slug means no commercial record (no estimate). */
  cells: Record<string, CostStatusCell>;
  noEstimate: CostStatusCell;
}

export default function BoxOfficeV2Tables({ thisWeek, allTime, cells, noEstimate }: Props) {
  const [tab, setTab] = useState<'week' | 'all'>('week');

  const columns = useMemo<ExtraColumn[]>(() => [
    {
      key: 'status',
      header: 'Status',
      headerClassName: 'text-left',
      cellClassName: 'text-left whitespace-nowrap',
      sortValue: (slug) => cells[slug]?.sortValue ?? null,
      render: (slug) => {
        const c = cells[slug] ?? noEstimate;
        return (
          <span className={`text-sm font-bold ${TONE_TEXT[c.tone]}`}>
            {c.label}
            {c.arrow && <span className="ml-1" aria-label={c.arrow === '↑' ? 'improving' : c.arrow === '↓' ? 'declining' : 'steady'}>{c.arrow}</span>}
          </span>
        );
      },
    },
    {
      key: 'vs-cost',
      header: <span className="text-accent-gold">Vs. its cost</span>,
      cellClassName: 'text-right whitespace-nowrap',
      sortValue: (slug) => cells[slug]?.sortValue ?? null,
      render: (slug) => {
        const c = cells[slug] ?? noEstimate;
        if (!c.multiple) return <span className="text-gray-500">—</span>;
        return (
          <span className="inline-flex flex-col items-end leading-tight">
            <span className="text-white font-bold tabular-nums">{c.multiple}</span>
            <span className="text-xs text-gray-500 tabular-nums">{c.range}</span>
          </span>
        );
      },
    },
  ], [cells, noEstimate]);

  const tabClass = (on: boolean) =>
    `text-xs font-semibold px-3 py-1 rounded-md transition-colors ${on ? 'bg-white/10 text-gray-50' : 'text-gray-400 hover:text-gray-200'}`;

  return (
    <section className="mb-12" aria-labelledby="box-office-tables-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 id="box-office-tables-heading" className="text-xl font-bold text-white">
          {tab === 'week' ? 'This Week' : 'All-Time Box Office Leaders'}
        </h2>
        <div className="inline-flex bg-surface-overlay border border-white/5 rounded-lg p-0.5 gap-0.5" role="tablist" aria-label="Box office view">
          <button type="button" role="tab" aria-selected={tab === 'week'} onClick={() => setTab('week')} className={tabClass(tab === 'week')}>
            This week
          </button>
          <button type="button" role="tab" aria-selected={tab === 'all'} onClick={() => setTab('all')} className={tabClass(tab === 'all')}>
            All time
          </button>
        </div>
      </div>
      {tab === 'week' ? (
        <>
          <p className="text-gray-400 text-sm mb-4">
            Ranked by gross. Click &ldquo;Vs. its cost&rdquo; to rank by how each show is doing against its own costs instead.
          </p>
          <ThisWeekTable data={thisWeek} extraColumns={columns} hideColumns={['attendance']} />
          <p className="text-xs text-gray-500 mt-3">
            Status uses each show&apos;s average over the last 4 weeks against its weekly cost; the small range reflects how solid
            that cost figure is. &ldquo;Below Cost&rdquo; only when the whole range is under 1×. The arrow is the 4-week trend.
          </p>
          <p className="text-xs text-gray-500 mt-1">
            <span aria-hidden="true">*</span> Capacity above 100% reflects extra performances or premium pricing reported by The Broadway League.
          </p>
        </>
      ) : (
        <>
          <p className="text-gray-400 text-sm mb-4">
            Cumulative Broadway gross over entire run. The Lion King holds the all-time record at over $2 billion.
          </p>
          <AllTimeTable data={allTime} />
        </>
      )}
    </section>
  );
}
