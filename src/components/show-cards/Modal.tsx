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

  // Escape dismisses only the TOPMOST open modal — with stacked modals (e.g.
  // sign-in over the rating editor) a single Escape used to close both,
  // discarding the editor draft beneath (2026-07-05). Topmost-ness is decided
  // from the DOM, NOT a module-level stack: Next.js code-splitting duplicates
  // this module across chunks (verified: two chunks carry the Modal component),
  // so module state is split-brain and every copy thought it was topmost
  // (2026-07-11). All modals portal to <body>, so among open modal overlays
  // the one latest in body order is the top of the stack.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const overlays = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    if (overlays.length && overlays[overlays.length - 1] !== overlayRef.current) return;
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

  const panelRounding = bottomSheet
    ? 'rounded-t-2xl sm:rounded-2xl'
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
      <div className={`relative w-full ${MAX_WIDTH_CLASS[maxWidth]} bg-surface-raised border border-white/10 ${panelRounding} shadow-2xl max-h-[85vh] overflow-y-auto`}>
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
