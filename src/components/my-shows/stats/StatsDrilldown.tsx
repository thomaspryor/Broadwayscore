'use client';
/**
 * The ONE drill-down behind every tap on the Stats view: a shared Modal
 * (bottom sheet on phones) listing the diary entries or catalog shows behind
 * a number. Web port of the iOS StatsDrilldownSheet (BRO-6170 prototype).
 */

import Link from 'next/link';
import { useMemo } from 'react';
import { Modal, ModalCloseButton, ScoreBadge } from '@/components/show-cards';
import { Poster } from '@/components/user/upcoming-cards';
import MiniStars from '@/components/user/Stars';
import type { UserReview } from '@/types/user';
import type { StatsShow } from '@/lib/stats-ui/bundle';
import { formatDateSeen, groupByVenue, houseShortName } from '@/lib/stats-ui/format';

export interface DrilldownFact {
  label: string;
  value: string;
}

export interface DrilldownPayload {
  title: string;
  caption?: string;
  reviews?: UserReview[];
  shows?: StatsShow[];
  facts?: DrilldownFact[];
  emptyText?: string;
  /** Per-show score shown instead of the composite (a critic's own score). */
  scoreOverrides?: Record<string, number>;
  showsLabel?: string;
  groupByVenue?: boolean;
}

type Row =
  | { kind: 'review'; key: string; review: UserReview }
  | { kind: 'show'; key: string; show: StatsShow }
  | { kind: 'divider'; key: string; label: string };

function hrefFor(show: StatsShow | undefined): string | null {
  if (!show) return null;
  return show.diaryOnly ? `/diary-show/${show.slug}` : `/show/${show.slug}`;
}

export default function StatsDrilldown({
  payload,
  shows,
  onClose,
}: {
  payload: DrilldownPayload | null;
  shows: Record<string, StatsShow>;
  onClose: () => void;
}) {
  const rows = useMemo<Row[]>(() => {
    if (!payload) return [];
    const out: Row[] = [];
    const reviews = payload.reviews ?? [];
    if (payload.groupByVenue && reviews.length) {
      for (const g of groupByVenue(reviews, (id) => shows[id]?.venue)) {
        out.push({ kind: 'divider', key: `d:${g.venue}`, label: `${houseShortName(g.venue)} · ${g.reviews.length}` });
        g.reviews.forEach((r) => out.push({ kind: 'review', key: `r:${r.id}`, review: r }));
      }
    } else {
      reviews.forEach((r) => out.push({ kind: 'review', key: `r:${r.id}`, review: r }));
    }
    const list = payload.shows ?? [];
    if (list.length && reviews.length && payload.showsLabel) out.push({ kind: 'divider', key: 'd:shows', label: payload.showsLabel });
    list.forEach((s) => out.push({ kind: 'show', key: `s:${s.id}`, show: s }));
    return out;
  }, [payload, shows]);

  return (
    <Modal isOpen={!!payload} onClose={onClose} maxWidth="lg" bottomSheet ariaLabel={payload?.title}>
      {payload && (
        <div data-testid="stats-drilldown">
          <div className="sticky top-0 z-10 bg-surface-raised border-b border-white/5 px-5 pt-5 pb-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-white leading-tight">{payload.title}</h2>
                {payload.caption && <p className="text-xs text-gray-400 mt-1">{payload.caption}</p>}
              </div>
              <ModalCloseButton onClick={onClose} className="p-1 -m-1" />
            </div>
            {payload.facts && payload.facts.length > 0 && (
              <div className="grid grid-cols-3 gap-2 mt-4">
                {payload.facts.map((f) => (
                  <div key={f.label} className="rounded-lg bg-surface-overlay/70 px-3 py-2 min-w-0">
                    <p className="text-xs text-fg-muted truncate">{f.label}</p>
                    <p className="text-sm font-semibold text-white truncate tabular-nums mt-0.5">{f.value}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="px-3 sm:px-4 py-3">
            {rows.length === 0 && <p className="px-2 py-6 text-sm text-gray-400 text-center">{payload.emptyText ?? 'Nothing here yet.'}</p>}
            {rows.map((row) => {
              if (row.kind === 'divider') {
                return (
                  <p key={row.key} className="px-2 pt-4 pb-1.5 text-xs font-bold uppercase tracking-wider text-fg-muted first:pt-1">
                    {row.label}
                  </p>
                );
              }
              const showId = row.kind === 'review' ? row.review.show_id : row.show.id;
              const show = shows[showId];
              const title = show?.title ?? showId;
              const subtitle =
                row.kind === 'review'
                  ? [show?.venue, formatDateSeen(row.review.date_seen)].filter(Boolean).join(' · ')
                  : [show?.venue, show?.status === 'previews' ? 'In previews' : show?.status === 'open' ? 'Now playing' : 'Closed']
                      .filter(Boolean)
                      .join(' · ');
              const score = payload.scoreOverrides?.[showId] ?? show?.compositeScore ?? null;
              const href = hrefFor(show);
              const inner = (
                <>
                  <div className="flex-shrink-0 w-12 aspect-square rounded-lg overflow-hidden bg-surface-overlay">
                    <Poster url={show?.posterUrl} iconClass="text-lg" sizes="48px" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white truncate group-hover:text-brand transition-colors">{title}</p>
                    {subtitle && <p className="text-xs text-gray-400 truncate mt-0.5">{subtitle}</p>}
                    {row.kind === 'review' && row.review.rating > 0 && (
                      <div className="flex items-center gap-0.5 mt-1">
                        <MiniStars rating={row.review.rating} filledOnly />
                      </div>
                    )}
                  </div>
                  <ScoreBadge size="xs" score={score} category={show?.category} />
                </>
              );
              const cls = 'group flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-white/[0.04] transition-colors';
              return href ? (
                <Link key={row.key} href={href} className={cls} data-testid="stats-drilldown-row">
                  {inner}
                </Link>
              ) : (
                <div key={row.key} className={cls} data-testid="stats-drilldown-row">
                  {inner}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}
