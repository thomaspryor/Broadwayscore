'use client';

import Link from 'next/link';
import { ScoreBadge } from '@/components/show-cards';
import { useMyScoreCalls } from '@/hooks/useScoreCall';
import type { ShowLookup } from '@/types/user';

/** My Shows: the score predictions this reader has locked. Renders nothing until there is at least one. */
export default function YourPredictions({ showMap }: { showMap: Record<string, ShowLookup> }) {
  const { loaded, loadError, retry, calls } = useMyScoreCalls();
  if (loadError) {
    return (
      <section className="card p-4 mb-6" data-testid="your-predictions-error" role="alert">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-2">Your predictions</h2>
        <p className="text-sm text-gray-200 m-0 mb-3">We couldn&apos;t load your predictions. Your saved predictions are safe.</p>
        <button type="button" className="btn-secondary min-h-[44px]" onClick={retry}>Try again</button>
      </section>
    );
  }
  // Wait for the show lookup; rows fall back to the id only if a show is missing from it.
  if (!loaded || calls.length === 0 || Object.keys(showMap).length === 0) return null;
  return (
    <section className="card p-4 mb-6" data-testid="your-predictions" aria-labelledby="your-predictions-h">
      <h2 id="your-predictions-h" className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand m-0 mb-3">Your predictions</h2>
      <ul className="m-0 p-0 list-none divide-y divide-white/10">
        {calls.map((c) => {
          const show = showMap[c.show_id];
          const title = show?.title ?? c.show_id;
          const row = (
            <>
              <ScoreBadge score={c.called_score} size="xs" category={show?.category} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-white truncate">{title}</span>
                <span className="block text-xs text-fg-muted">
                  You predicted {c.called_score}{c.forecast != null ? `. Our forecast: ${c.forecast}.` : '.'}
                </span>
              </span>
            </>
          );
          return (
            <li key={c.show_id}>
              {show?.slug
                ? <Link href={`/show/${show.slug}`} className="flex items-center gap-3 py-2 min-h-[44px] hover:bg-surface-overlay transition-colors rounded-lg">{row}</Link>
                : <div className="flex items-center gap-3 py-2 min-h-[44px]">{row}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
