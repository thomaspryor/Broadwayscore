'use client';

import type { SeatingSection, SeatNote } from '@/lib/data-types';
import SeatingGuidance from './SeatingGuidance';
import SeatNotes from './SeatNotes';
import { publishableSeatNotes, latestVerified, noteSourceLinks } from '../../scripts/lib/seat-notes-publish';

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

export default function SeatingGuidanceCard({ sections, bestSeats, seatNotes, variant = 'theater' }: SeatingGuidanceCardProps) {
  const config = VARIANT_CONFIG[variant];
  const headingId = `seating-guidance-heading-${variant}`;

  const notes = publishableSeatNotes(seatNotes) as SeatNote[];
  if (notes.length) {
    const sources = new Set(notes.flatMap((n) => noteSourceLinks(n).map((l: { label: string }) => l.label)));
    const checked = monthYear(latestVerified(notes));
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
        <p className="text-xs text-fg-muted mb-3">Tips for the building, whatever show is playing.</p>

        <SeatNotes notes={notes} />

        <p className="text-[10px] text-fg-muted mt-3 pt-3 border-t border-white/5 leading-relaxed">
          From public seat guides and theatergoer reviews{checked ? `, checked ${checked}` : ''}. Each tip links to where it came from.
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
