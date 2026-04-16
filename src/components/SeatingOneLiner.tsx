import Link from 'next/link';
import type { SeatingSection } from '@/lib/data-types';

interface SeatingOneLinerProps {
  sections?: SeatingSection[];
  venueSlug: string;
  venueName: string;
}

export default function SeatingOneLiner({ sections, venueSlug, venueName }: SeatingOneLinerProps) {
  if (!sections || !sections.length) return null;

  const sweetSpot = sections.find((s) => s?.verdict === 'sweet-spot');
  if (!sweetSpot) return null;

  const sectionLabel = sweetSpot.rowRange ? `${sweetSpot.name}, rows ${sweetSpot.rowRange}` : sweetSpot.name;

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
