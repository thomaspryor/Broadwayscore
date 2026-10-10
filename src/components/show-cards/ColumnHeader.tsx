'use client';

import type { ReactNode } from 'react';

export interface ColumnHeaderProps {
  /** Column label text */
  label: string;
  /** Optional shorter label shown only on mobile (replaces label on small screens) */
  mobileLabel?: string;
  /** Whether this column is the current sort column */
  active: boolean;
  /** Sort direction when active. Shows ▼/▲. If omitted, shows ▾ when active. */
  direction?: 'asc' | 'desc';
  /** Click handler */
  onClick: () => void;
  /** Width/layout classes (e.g., "w-10 sm:w-16 text-center flex-shrink-0") */
  className?: string;
  /** aria-sort value override. Computed automatically if direction is provided. */
  ariaSort?: 'ascending' | 'descending' | 'none';
  /** Optional title tooltip */
  title?: string;
  /** Render as flex-1 (for the "name" column that fills remaining space) */
  flex?: boolean;
  /** Text alignment — defaults to 'center' */
  align?: 'left' | 'center' | 'right';
  /** Extra content inside the button (e.g., for tooltips) */
  children?: ReactNode;
}

function SortArrow({ active, direction }: { active: boolean; direction?: 'asc' | 'desc' }) {
  if (!active) return null;
  if (!direction) return <>{' \u25BE'}</>;
  return <span className="ml-0.5 text-brand">{direction === 'desc' ? '\u25BC' : '\u25B2'}</span>;
}

export function ColumnHeader({
  label,
  mobileLabel,
  active,
  direction,
  onClick,
  className,
  ariaSort,
  title,
  flex,
  align = 'center',
  children,
}: ColumnHeaderProps) {
  const computedAriaSort = ariaSort ?? (active
    ? (direction === 'asc' ? 'ascending' : 'descending')
    : 'none');

  const alignClass = align === 'left' ? 'text-left' : align === 'right' ? 'text-right' : 'text-center';

  return (
    <div className={flex ? 'flex-1 min-w-0' : className}>
      <button
        className={`${flex ? 'w-full ' : ''}${alignClass} group/sort`}
        onClick={onClick}
        aria-sort={computedAriaSort}
        title={title}
      >
        <span className={`text-[10px] font-medium uppercase tracking-wider transition-colors leading-tight ${
          active ? 'text-brand' : 'text-gray-500 group-hover/sort:text-gray-300'
        }`}>
          {mobileLabel ? (
            <>
              <span className="sm:hidden">{mobileLabel}</span>
              <span className="hidden sm:inline">{label}</span>
            </>
          ) : (
            children ?? label
          )}
          <SortArrow active={active} direction={direction} />
        </span>
      </button>
    </div>
  );
}
