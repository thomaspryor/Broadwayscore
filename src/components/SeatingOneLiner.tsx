import Link from 'next/link';
import type { SeatingSection } from '@/lib/data-types';

interface SeatingOneLinerProps {
  sections?: SeatingSection[];
  venueSlug: string;
  venueName: string;
}

export default function SeatingOneLiner({ sections, venueSlug, venueName }: SeatingOneLinerProps) {
  if (!sections || !sections.length) return null;

  const sweetSpots = sections.filter((s) => s?.verdict === 'sweet-spot');
  if (!sweetSpots.length) return null;

  const sectionLabel = sweetSpots.length === 1
    ? (sweetSpots[0].rowRange ? `${sweetSpots[0].name}, rows ${sweetSpots[0].rowRange}` : sweetSpots[0].name)
    : sweetSpots.map((s) => s.name).join(' + ');

  return (
    <div className="mt-1 text-xs">
      <Link
        href={`/theater/${venueSlug}#seating-guidance-heading`}
        className="text-score-great hover:text-score-great/80 transition-colors inline-flex items-center gap-1"
      >
        <span aria-hidden="true">✓</span>
        <span>
          Best seats at {venueName}: <span className="font-medium">{sectionLabel}</span>
        </span>
        <span aria-hidden="true" className="text-gray-500">→</span>
      </Link>
    </div>
  );
}
