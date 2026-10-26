import type { MouseEvent } from 'react';

/**
 * Click anywhere on a table row to open its show (owner, 2026-10-26). The
 * name cell keeps its real <Link> for keyboards, screen readers and crawlers;
 * this only widens the mouse target. Left alone: clicks on a link, button or
 * other control, on a help note (a title tooltip or cursor-help span, whose
 * text a click or tap should not leave behind), double-clicks (copying a
 * number), and drags that select text.
 */
const SKIP_SELECTOR = 'a, button, input, select, textarea, label, summary, [role="button"], [contenteditable], [title], .cursor-help';

export type RowClickInput = {
  /** Whether the click landed inside an element the row should not hijack. */
  insideSkip: boolean;
  /** The click count (2 on the second click of a double-click). */
  detail: number;
  /** Whether text is currently selected on the page. */
  hasSelection: boolean;
  /** 0 primary, 1 middle. */
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
};

/** What a row click should do. Pure, so it is unit-tested (CLAUDE.md §15). */
export function rowClickAction(i: RowClickInput): 'ignore' | 'new-tab' | 'open' {
  if (i.insideSkip || i.detail > 1 || i.hasSelection) return 'ignore';
  if (i.button === 1 || i.metaKey || i.ctrlKey || i.shiftKey) return 'new-tab';
  if (i.button !== 0) return 'ignore';
  return 'open';
}

/** onClick and onAuxClick handler for a show row. */
export function openRowLink(e: MouseEvent<HTMLElement>, href: string, push: (href: string) => void): void {
  const target = e.target as HTMLElement | null;
  const action = rowClickAction({
    insideSkip: !!target?.closest(SKIP_SELECTOR),
    detail: e.detail,
    hasSelection: typeof window !== 'undefined' && !!window.getSelection()?.toString(),
    button: e.button,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
  });
  if (action === 'ignore') return;
  if (action === 'new-tab') {
    window.open(href, '_blank', 'noopener');
    return;
  }
  push(href);
}
