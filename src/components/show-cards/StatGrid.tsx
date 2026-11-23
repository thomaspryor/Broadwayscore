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
  return (
    <div className={`grid ${COLUMNS[columns]} gap-2 sm:gap-3${className ? ` ${className}` : ''}`}>
      {stats.map(stat => (
        // Tiles in a row stretch to the tallest one (a 68px ScoreBadge). Labels stay
        // aligned at the top; the value block is centered in the space below, so a
        // plain number never floats at the top of an empty box.
        <div key={stat.label} className="card p-2.5 sm:p-4 text-center flex flex-col items-center">
          <p className="text-fg-muted text-[10px] sm:text-xs uppercase tracking-wider mb-1 sm:mb-2">{stat.label}</p>
          <div className="flex-1 flex flex-col items-center justify-center">
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
            <p className="text-[10px] text-fg-muted truncate mt-0.5 sm:mt-1">{stat.subtitle}</p>
          )}
          </div>
        </div>
      ))}
    </div>
  );
}
