import { CATEGORY_LABEL, formatMonth } from '@/lib/format';
import type { Category } from '@/lib/data-types';

// Category plus release month. No "new"/"pre-order" status: a static build
// would freeze it on the build date.
export function ProductChips({ category, releaseDate }: { category: Category; releaseDate: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className="chip border-sky-200 bg-sky-50 text-sky-800">{CATEGORY_LABEL[category]}</span>
      <span className="chip border-line bg-surface-overlay text-ink-muted">{formatMonth(releaseDate)}</span>
    </div>
  );
}
