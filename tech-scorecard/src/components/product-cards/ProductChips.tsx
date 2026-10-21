import { CATEGORY_LABEL } from '@/lib/format';
import type { Category } from '@/lib/data-types';

// Static export: "today" is the build date.
const TODAY = new Date().toISOString().slice(0, 10);

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export function ProductChips({ category, releaseDate }: { category: Category; releaseDate: string }) {
  const age = daysBetween(releaseDate, TODAY);
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className="chip border-sky-200 bg-sky-50 text-sky-700">{CATEGORY_LABEL[category]}</span>
      {age < 0 ? (
        <span className="chip border-violet-200 bg-status-new-bg text-status-new">Pre-order</span>
      ) : age <= 45 ? (
        <span className="chip border-emerald-200 bg-status-open-bg text-status-open">New release</span>
      ) : (
        <span className="chip border-line bg-surface-overlay text-ink-muted">On sale</span>
      )}
    </div>
  );
}
