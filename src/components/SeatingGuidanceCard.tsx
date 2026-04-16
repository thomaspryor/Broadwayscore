import type { SeatingSection } from '@/lib/data-types';
import SeatingGuidance from './SeatingGuidance';

interface SeatingGuidanceCardProps {
  sections?: SeatingSection[];
  bestSeats?: string;
}

export default function SeatingGuidanceCard({ sections, bestSeats }: SeatingGuidanceCardProps) {
  if (!sections || !sections.length) return null;

  return (
    <section className="card p-4 sm:p-5 mb-8" aria-labelledby="seating-guidance-heading">
      <div className="mb-3">
        <h2 id="seating-guidance-heading" className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
          Where to Sit
        </h2>
      </div>

      <SeatingGuidance sections={sections} bestSeats={bestSeats} />

      <p className="text-[10px] text-gray-600 mt-4 pt-3 border-t border-white/5 leading-relaxed">
        Based on aggregated audience reports and editorial judgment. Sightlines vary by show and seat.
      </p>
    </section>
  );
}
