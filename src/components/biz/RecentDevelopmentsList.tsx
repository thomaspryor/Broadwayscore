/**
 * RecentDevelopmentsList - Timeline of recent commercial events
 * Sprint 2, Task 2.2
 */

import Link from 'next/link';

export interface DevelopmentItem {
  date: string; // Format: "MMM YYYY" e.g., "Jan 2025"
  type: 'recouped' | 'estimate' | 'closing' | 'at-risk';
  showTitle: string;
  showSlug?: string;
  description: string;
}

interface RecentDevelopmentsListProps {
  items: DevelopmentItem[];
  maxItems?: number;
}

function getTypeStyles(type: DevelopmentItem['type']): { dotClass: string; label: string } {
  switch (type) {
    case 'recouped':
      return { dotClass: 'text-emerald-400', label: 'Recouped' };
    case 'estimate':
      return { dotClass: 'text-amber-400', label: 'Progress update' };
    case 'closing':
      return { dotClass: 'text-red-400', label: 'Closing' };
    case 'at-risk':
      return { dotClass: 'text-red-400', label: 'At risk' };
    default:
      return { dotClass: 'text-gray-400', label: 'Update' };
  }
}

export default function RecentDevelopmentsList({
  items,
  maxItems = 5,
}: RecentDevelopmentsListProps) {
  const displayItems = items.slice(0, maxItems);

  if (displayItems.length === 0) {
    return (
      <div className="card rounded-xl p-4">
        <p className="text-sm text-gray-500">No recent developments</p>
      </div>
    );
  }

  return (
    <div className="card rounded-xl p-4">
      <ul className="space-y-2 text-sm">
        {displayItems.map((item, index) => {
          const styles = getTypeStyles(item.type);
          return (
            <li key={index} className="flex items-start gap-3">
              <span className="text-xs text-gray-500 w-20 shrink-0">
                {item.date}
              </span>
              <span className={styles.dotClass} aria-label={styles.label}>
                ●
              </span>
              <span>
                {item.showSlug ? (
                  <Link
                    href={`/show/${item.showSlug}`}
                    className="font-semibold text-white hover:text-brand transition-colors"
                  >
                    {item.showTitle}
                  </Link>
                ) : (
                  <strong className="text-white">{item.showTitle}</strong>
                )}{' '}
                <span className="text-gray-300">{item.description}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {items.length > maxItems && (
        <Link
          href="/biz/changelog"
          className="text-brand hover:text-brand-hover text-sm mt-3 inline-block"
        >
          View full changelog →
        </Link>
      )}
    </div>
  );
}
