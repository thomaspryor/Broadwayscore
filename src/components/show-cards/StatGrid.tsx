import type { ReactNode } from 'react';

interface Stat {
  label: string;
  value: string | number;
  /** Replaces `value` (e.g. a ScoreBadge). The tile centers it vertically. */
  node?: ReactNode;
  color?: string;
  dimmed?: boolean;
  subtitle?: string;
  subValue?: string;
  subValueColor?: string;
}

// Literal class strings so Tailwind can see them.
const COLUMNS = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4',
} as const;

export function StatGrid({ stats, className, columns = 4 }: { stats: Stat[]; className?: string; columns?: 2 | 3 | 4 }) {
  // A tile holding a node (a 68px ScoreBadge on desktop) stretches every tile in its row.
  // Only then do labels pin to the top and the value block center in the space below, so a
  // plain number never floats at the top of an empty box. Rows with no node render exactly
  // as they always did (cast, critic, creative and biz pages).
  const stretched = stats.some(stat => stat.node);
  return (
    <div className={`grid ${COLUMNS[columns]} gap-2 sm:gap-3${className ? ` ${className}` : ''}`}>
      {stats.map(stat => (
        <div key={stat.label} className={`card p-2.5 sm:p-4 text-center${stretched ? ' flex flex-col items-center' : ''}`}>
          <p className="text-fg-muted text-[10px] sm:text-xs uppercase tracking-wider mb-1 sm:mb-2">{stat.label}</p>
          <div className={stretched ? 'flex-1 w-full min-w-0 flex flex-col items-center justify-center' : undefined}>
          {stat.node ?? (
            <p
              className={`text-xl sm:text-2xl font-bold ${stat.dimmed ? 'text-fg-muted' : 'text-white'}`}
              style={stat.color ? { color: stat.color } : undefined}
            >
              {stat.value}
            </p>
          )}
          {stat.subValue && (
            <p
              className="text-[10px] sm:text-xs font-medium mt-0.5"
              style={stat.subValueColor ? { color: stat.subValueColor } : undefined}
            >
              {stat.subValue}
            </p>
          )}
          {stat.subtitle && (
            <p className={`text-[10px] text-fg-muted mt-0.5 sm:mt-1${stretched ? ' w-full break-words' : ' truncate'}`}>{stat.subtitle}</p>
          )}
          </div>
        </div>
      ))}
    </div>
  );
}
