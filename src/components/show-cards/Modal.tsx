'use client';

import { useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** z-index layer (default 100) */
  zIndex?: number;
  /** Max width class: 'sm' (384px), 'md' (448px), 'lg' (520px) */
  maxWidth?: 'sm' | 'md' | 'lg';
  /** Whether backdrop click closes modal (default true) */
  closeOnBackdrop?: boolean;
  /** Whether Escape key closes modal (default true) */
  closeOnEscape?: boolean;
  /** Mobile bottom-sheet style: slides up from bottom on mobile (default false) */
  bottomSheet?: boolean;
  /** ARIA label for the dialog */
  ariaLabel?: string;
}

const MAX_WIDTH_CLASS = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-[520px]',
} as const;

/**
 * Shared modal wrapper — handles backdrop, escape, scroll lock, and iOS Safari fixes.
 *
 * Usage:
 *   <Modal isOpen={open} onClose={() => setOpen(false)} maxWidth="sm">
 *     <div className="p-6">Modal content</div>
 *   </Modal>
 */
export default function Modal({
  isOpen,
  onClose,
  children,
  zIndex = 100,
  maxWidth = 'sm',
  closeOnBackdrop = true,
  closeOnEscape = true,
  bottomSheet = false,
  ariaLabel,
}: ModalProps) {
  const scrollYRef = useRef(0);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const isTopmost = useCallback(
    () => {
      const overlays = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      return !overlays.length || overlays[overlays.length - 1] === overlayRef.current;
    },
    [],
  );

  // Focus management: move focus into the modal on open, restore it on close,
  // and trap Tab within the modal so keyboard/screen-reader users can't wander
  // onto the obscured page behind the backdrop. Only the TOPMOST modal traps
  // (same rule as Escape) so a stacked sign-in over the editor behaves right.
  useEffect(() => {
    if (!isOpen) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    const focusables = () => {
      const panel = panelRef.current;
      if (!panel) return [] as HTMLElement[];
      return Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(el => el.offsetParent !== null);
    };
    // Defer initial focus one frame so the panel is painted. Focus the PANEL
    // (tabIndex=-1), never the first control: Safari/Chrome treat programmatic
    // focus as :focus-visible, which painted an amber focus ring on the first
    // star the moment the rating sheet opened (owner report, 2026-07-19).
    // Tab from the panel still lands on the first control, so the trap holds.
    const raf = requestAnimationFrame(() => panelRef.current?.focus?.());
    // Manual traversal for EVERY Tab, not just first/last wrap: WebKit/Safari's
    // native Tab only visits text fields — it skips buttons entirely and then
    // walks out of the dialog into the page behind (caught by the webkit e2e
    // project, 2026-07-19). Stepping through the focusables list ourselves
    // gives every browser the same order and guarantees containment.
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !isTopmost()) return;
      e.preventDefault();
      const f = focusables();
      if (!f.length) { panelRef.current?.focus(); return; }
      const idx = f.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? (idx <= 0 ? f[f.length - 1] : f[idx - 1])
        : (idx === -1 || idx === f.length - 1 ? f[0] : f[idx + 1]);
      next.focus();
    };
    document.addEventListener('keydown', onTab);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onTab);
      restoreTo?.focus?.();
    };
  }, [isOpen, isTopmost]);

  // Escape dismisses only the TOPMOST open modal — with stacked modals (e.g.
  // sign-in over the rating editor) a single Escape used to close both,
  // discarding the editor draft beneath (2026-07-05/11). Two hard-won rules:
  //
  // 1. Topmost-ness comes from the DOM (all modals portal to <body>, so the
  //    last [role=dialog][aria-modal] in body order is on top) — NOT from a
  //    module-level stack: Next.js code-splitting can duplicate this module
  //    across chunks, giving each modal a private, split-brain stack.
  //
  // 2. One Escape = one modal, enforced by marking the EVENT. React 18
  //    flushes discrete-event state updates between native listeners: when the
  //    top modal's listener closes it, its dialog is already gone from the DOM
  //    by the time a later-attached listener runs, so the modal underneath
  //    sees itself as topmost and closes too (listener attach order is NOT
  //    mount order — e.g. the editor re-attaches when `saving` toggles). The
  //    string-keyed mark survives chunk duplication (same native event object).
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const ev = e as KeyboardEvent & { __bscEscapeConsumed?: boolean };
    if (ev.__bscEscapeConsumed) return;
    const overlays = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    if (overlays.length && overlays[overlays.length - 1] !== overlayRef.current) return;
    ev.__bscEscapeConsumed = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeOnEscape, handleKeyDown]);

  // Scroll lock — iOS Safari compatible
  // On iOS, overflow:hidden on body doesn't prevent scroll.
  // Fix: save scroll position, set body to fixed, restore on close.
  useEffect(() => {
    if (!isOpen) return;

    const scrollY = window.scrollY;
    scrollYRef.current = scrollY;
    const body = document.body;
    const originalStyles = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
    };

    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';

    return () => {
      body.style.overflow = originalStyles.overflow;
      body.style.position = originalStyles.position;
      body.style.top = originalStyles.top;
      body.style.width = originalStyles.width;
      window.scrollTo(0, scrollY);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const alignClass = bottomSheet
    ? 'flex items-end sm:items-center justify-center'
    : 'flex items-center justify-center p-4';

  // Bottom sheets sit flush against the screen edge — pad for the iOS home
  // indicator so the last action row isn't visually cut off (owner, 2026-07-19).
  const panelRounding = bottomSheet
    ? 'rounded-t-2xl sm:rounded-2xl pb-[env(safe-area-inset-bottom)] sm:pb-0'
    : 'rounded-2xl';

  // Portal to <body>: position:fixed resolves against the nearest containing
  // block, and any ancestor with a transform, filter, or CSS containment
  // creates one. The design system's .card sets `contain: layout style`, so a
  // Modal rendered inside a card (e.g. RatingEditor in the show hero) would be
  // trapped inside the card — on mobile that pushed the Save button below the
  // fold with body scroll locked (2026-07-05, caught on demo). The portal
  // guarantees the overlay is always viewport-anchored.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={overlayRef}
      className={`fixed inset-0 ${alignClass}`}
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={closeOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative w-full ${MAX_WIDTH_CLASS[maxWidth]} bg-surface-raised border border-white/10 ${panelRounding} shadow-2xl max-h-[85vh] overflow-y-auto focus:outline-none`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Reusable close button (X icon) for modal headers */
export function ModalCloseButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-gray-400 hover:text-white transition-colors ${className}`}
      aria-label="Close"
    >
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );
}
