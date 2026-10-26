import type { MouseEvent } from 'react';

/**
 * Click anywhere on a table row to open its show (owner, 2026-10-26). The
 * name cell keeps its real <Link> for keyboards, screen readers and crawlers;
 * this only widens the mouse target. Clicks on a link, button or other control
 * inside the row, and drags that select text, are left alone.
 */
export function openRowLink(e: MouseEvent<HTMLElement>, href: string, push: (href: string) => void): void {
  const target = e.target as HTMLElement | null;
  if (target?.closest('a, button, input, select, summary, [role="button"]')) return;
  if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
  if (e.metaKey || e.ctrlKey) {
    window.open(href, '_blank', 'noopener');
    return;
  }
  push(href);
}
