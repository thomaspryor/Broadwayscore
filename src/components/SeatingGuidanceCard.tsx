'use client';

import type { SeatingSection } from '@/lib/data-types';
import SeatingGuidance from './SeatingGuidance';

interface SeatingGuidanceCardProps {
  sections?: SeatingSection[];
  bestSeats?: string;
  variant?: 'theater' | 'show';
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

export default function SeatingGuidanceCard({ sections, bestSeats, variant = 'theater' }: SeatingGuidanceCardProps) {
  if (!sections || !sections.length) return null;

  const config = VARIANT_CONFIG[variant];
  const headingId = `seating-guidance-heading-${variant}`;

  return (
    <section className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8" aria-labelledby={headingId}>
      {/* Unified scorecard chrome */}
      <header className="flex items-center justify-between gap-3 mb-4">
        <h2 id={headingId} className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">
          {config.title}
        </h2>
        <span className="text-[11px] font-medium tracking-[0.06em] text-gray-500 lowercase shrink-0">
          {sections.length} {sections.length === 1 ? 'section' : 'sections'}
        </span>
      </header>

      <SeatingGuidance sections={sections} bestSeats={bestSeats} compactRationale={config.compactRationale} />

      <p className="text-[10px] text-gray-600 mt-4 pt-3 border-t border-white/5 leading-relaxed">
        Based on aggregated audience reports and editorial judgment. Sightlines vary by show and seat.
      </p>
    </section>
  );
}
