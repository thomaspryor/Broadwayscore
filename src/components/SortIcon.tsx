import type { SortDirection } from '@/lib/formatting';

export function SortIcon({ active, direction }: { active: boolean; direction: SortDirection | null }) {
  if (!active) {
    return (
      <span className="ml-1 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
        \u2195
      </span>
    );
  }
  return (
    <span className="ml-1 text-brand">
      {direction === 'asc' ? '\u2191' : '\u2193'}
    </span>
  );
}
