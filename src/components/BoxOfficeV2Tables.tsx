'use client';

/**
 * /box-office tables (BRO-5007 v3, unreleased): "This week" gains gross per
 * seat (4 weeks) and the change from the same week last year; "All time" is
 * today's leaderboard behind a tab. Every number is published Broadway League
 * data; the cost columns moved to /biz. Loaded with dynamic() only when
 * featureFlags.commercial && boxOfficeV2, so a flag-off page never ships it.
 */
import { useMemo, useState } from 'react';
import { ThisWeekTable, AllTimeTable, type ExtraColumn } from '@/components/SortableBoxOfficeTable';
import type { MarketPage } from '@/lib/box-office-display';

type Rows = Parameters<typeof ThisWeekTable>[0]['data'];

const TABS: ReadonlyArray<readonly ['week' | 'all', string]> = [['week', 'This week'], ['all', 'All time']];

interface Props {
  thisWeek: Rows;
  allTime: Parameters<typeof AllTimeTable>[0]['data'];
  /** Keyed by slug; a missing slug shows dashes. */
  extra: MarketPage['table'];
}

export default function BoxOfficeV2Tables({ thisWeek, allTime, extra }: Props) {
  const [tab, setTab] = useState<'week' | 'all'>('week');

  const columns = useMemo<ExtraColumn[]>(() => [
    {
      key: 'per-seat',
      header: <span>Per seat <span className="font-normal">(4 wk)</span></span>,
      cellClassName: 'text-right whitespace-nowrap tabular-nums',
      sortValue: (slug) => (extra[slug]?.isNew ? null : extra[slug]?.perSeat ?? null),
      render: (slug) => {
        if (extra[slug]?.isNew) return <span className="text-xs font-bold uppercase text-gray-400">new</span>;
        const v = extra[slug]?.perSeat;
        return v == null ? <span className="text-fg-muted">–</span> : <span className="text-white">${Math.round(v)}</span>;
      },
    },
    {
      key: 'yoy',
      header: 'vs last yr',
      cellClassName: 'text-right whitespace-nowrap tabular-nums',
      sortValue: (slug) => extra[slug]?.yoyPct ?? null,
      render: (slug) => {
        const e = extra[slug];
        if (e?.isNew) return <span className="text-xs font-bold uppercase text-gray-400">new</span>;
        if (e?.yoyPct == null) return <span className="text-fg-muted">–</span>;
        if (Math.round(e.yoyPct) === 0) return <span className="text-gray-400">flat</span>;
        const up = e.yoyPct >= 0;
        return (
          <span className={up ? 'text-status-open' : 'text-score-tepid'}>
            <span aria-hidden="true">{up ? '▲' : '▼'}</span>
            <span className="sr-only">{up ? 'up ' : 'down '}</span>
            {Math.round(Math.abs(e.yoyPct))}%
          </span>
        );
      },
    },
  ], [extra]);

  const tabClass = (on: boolean) =>
    `text-xs font-semibold px-3 py-1 rounded-md transition-colors ${on ? 'bg-white/10 text-gray-50' : 'text-gray-400 hover:text-gray-200'}`;

  return (
    <section className="mb-12" aria-labelledby="box-office-tables-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 id="box-office-tables-heading" className="text-xl font-bold text-white">
          {tab === 'week' ? 'This Week' : 'All-Time Box Office Leaders'}
        </h2>
        <div className="inline-flex bg-surface-overlay border border-white/5 rounded-lg p-0.5 gap-0.5" role="tablist" aria-label="Box office view">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`box-office-tab-${key}`}
              aria-controls="box-office-tabpanel"
              aria-selected={tab === key}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                const next = key === 'week' ? 'all' : 'week';
                setTab(next);
                document.getElementById(`box-office-tab-${next}`)?.focus();
              }}
              className={tabClass(tab === key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id="box-office-tabpanel" aria-labelledby={`box-office-tab-${tab}`}>
      {tab === 'week' ? (
        <>
          <p className="text-gray-400 text-sm mb-4">
            Ranked by gross. Per seat is the gross divided by every seat the show had to sell, averaged over its last 4 weeks.
          </p>
          <ThisWeekTable data={thisWeek} extraColumns={columns} hideColumns={['attendance']} />
          <p className="text-xs text-fg-muted mt-1">
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
      </div>
    </section>
  );
}
