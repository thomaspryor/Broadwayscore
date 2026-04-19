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
    <section className="card p-4 sm:p-5 mb-8" aria-labelledby={headingId}>
      <div className="mb-3">
        <h2 id={headingId} className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
          {config.title}
        </h2>
      </div>

      <SeatingGuidance sections={sections} bestSeats={bestSeats} compactRationale={config.compactRationale} />

      <p className="text-[10px] text-gray-600 mt-4 pt-3 border-t border-white/5 leading-relaxed">
        Based on aggregated audience reports and editorial judgment. Sightlines vary by show and seat.
      </p>
    </section>
  );
}
