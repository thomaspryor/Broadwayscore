'use client';

import type { SeatingSection, SeatNote } from '@/lib/data-types';
import SeatingGuidance from './SeatingGuidance';
import SeatNotes from './SeatNotes';
import { publishableSeatNotes, latestVerified, noteSourceLinks, seatNotePicks, pickText } from '../../scripts/lib/seat-notes-publish';

interface SeatingGuidanceCardProps {
  sections?: SeatingSection[];
  bestSeats?: string;
  /** Sourced seat tips (BRO-8057). When they clear the bar they replace the section view. */
  seatNotes?: SeatNote[];
  variant?: 'theater' | 'show';
}

function monthYear(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const VARIANT_CONFIG = {
  theater: {
    title: 'Where to Sit',
    compactRationale: false,
  },
  show: {
    title: 'Seating Scorecard',
    compactRationale: true,
  },
} as const;

const PICK_TONE = {
  avoid: { mark: '▲', icon: 'text-score-tepid bg-score-tepid-bg', label: 'text-score-tepid' },
  value: { mark: '$', icon: 'text-score-great bg-score-great-bg', label: 'text-score-great' },
} as const;

export default function SeatingGuidanceCard({ sections, bestSeats, seatNotes, variant = 'theater' }: SeatingGuidanceCardProps) {
  const config = VARIANT_CONFIG[variant];
  const headingId = `seating-guidance-heading-${variant}`;

  const notes = publishableSeatNotes(seatNotes) as SeatNote[];
  if (notes.length) {
    const sources = new Set(notes.flatMap((n) => noteSourceLinks(n).map((l: { label: string }) => l.label)));
    const checked = monthYear(latestVerified(notes));
    const picks = seatNotePicks(notes) as { avoid: SeatNote | null; value: SeatNote | null };
    return (
      <section className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8" aria-labelledby={headingId}>
        <header className="flex items-center justify-between gap-3 mb-1">
          <h2 id={headingId} className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">
            Where to Sit
          </h2>
          <span className="text-[11px] font-medium tracking-[0.06em] text-fg-muted lowercase shrink-0">
            {notes.length} tips · {sources.size} {sources.size === 1 ? 'source' : 'sources'}
          </span>
        </header>
        {/* Owner-picked design B (2026-11-22): two headline tips, the rest behind one tap. */}
        <div className="grid gap-2.5 mt-3">
          {([['avoid', 'Biggest thing to avoid'], ['value', 'Best value']] as const).map(([key, label]) => {
            const n = picks[key];
            if (!n) return null;
            const t = pickText(n);
            const tone = key === 'avoid' ? PICK_TONE.avoid : PICK_TONE.value;
            return (
              <div key={key} className="grid grid-cols-[22px_1fr] gap-x-2.5 gap-y-0.5">
                <span aria-hidden="true" className={`row-span-2 w-[22px] h-[22px] rounded-full grid place-items-center text-xs font-extrabold ${tone.icon}`}>
                  {tone.mark}
                </span>
                <span className={`text-[11px] font-bold uppercase tracking-[0.08em] ${tone.label}`}>{label}</span>
                <span className="text-sm text-white leading-snug">
                  {t.where}. <span className="text-gray-300">{t.what}</span>
                </span>
              </div>
            );
          })}
        </div>

        <details className="group mt-3">
          <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer flex items-center justify-center gap-1.5 rounded-lg bg-white/5 hover:bg-white/10 py-2.5 text-[13px] font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40">
            <span className="group-open:hidden">See all {notes.length} tips</span>
            <span className="hidden group-open:inline">Show less</span>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" className="text-fg-muted transition-transform group-open:rotate-180 motion-reduce:transition-none">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>
          <div className="pt-3">
            <SeatNotes notes={notes} />
          </div>
        </details>

        <p className="text-[10px] text-fg-muted mt-3 pt-3 border-t border-white/5 leading-relaxed">
          From public seat guides and theatergoer reviews{checked ? `, checked ${checked}` : ''}.
        </p>
      </section>
    );
  }

  if (!sections || !sections.length) return null;

  return (
    <section className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8" aria-labelledby={headingId}>
      {/* Unified scorecard chrome */}
      <header className="flex items-center justify-between gap-3 mb-4">
        <h2 id={headingId} className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">
          {config.title}
        </h2>
        <span className="text-[11px] font-medium tracking-[0.06em] text-fg-muted lowercase shrink-0">
          {sections.length} {sections.length === 1 ? 'section' : 'sections'}
        </span>
      </header>

      <SeatingGuidance sections={sections} bestSeats={bestSeats} compactRationale={config.compactRationale} />

      <p className="text-[10px] text-fg-muted mt-4 pt-3 border-t border-white/5 leading-relaxed">
        Based on aggregated audience reports and editorial judgment. Sightlines vary by show and seat.
      </p>
    </section>
  );
}
