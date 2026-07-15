'use client';

import { useRef, type ReactNode } from 'react';

interface DatePickerButtonProps {
  /** YYYY-MM-DD, or '' when unset. */
  value: string;
  onChange: (val: string) => void;
  min?: string;
  max?: string;
  ariaLabel: string;
  /**
   * Trigger button classes — each surface keeps its own look.
   * When using onClear, include right padding (e.g. pr-9) so the label
   * doesn't run under the absolutely-positioned ✕.
   */
  className: string;
  /** Must keep `relative` when onClear is used — the ✕ positions against it. */
  wrapClassName?: string;
  /** Trigger content (icon + label). */
  children: ReactNode;
  /** Render a clear ✕ at the right edge when set and value is non-empty. */
  onClear?: () => void;
}

/**
 * Shared date-picker mechanics: a BUTTON trigger + visually-hidden native
 * date input that only anchors the picker.
 *
 * Why a button: password managers attach to focusable text-entry fields and
 * ignore the data-1p-ignore family of attributes in practice (owner's manager
 * popped autofill over the native picker, 2026-07-13). A button gives them
 * nothing to bind. The attributes stay on the hidden input as belt-and-braces.
 *
 * The input is untabbable (tabIndex -1) and aria-hidden — the button is the
 * accessible control. Trigger clicks preventDefault/stopPropagation so the
 * component works inside link-wrapped cards.
 */
export default function DatePickerButton({
  value,
  onChange,
  min,
  max,
  ariaLabel,
  className,
  wrapClassName = 'relative',
  children,
  onClear,
}: DatePickerButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={wrapClassName}>
      <input
        ref={inputRef}
        type="date"
        aria-hidden="true"
        tabIndex={-1}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore="true"
        value={value}
        onChange={e => { e.stopPropagation(); onChange(e.target.value); }}
        min={min}
        max={max}
        className="absolute inset-0 w-full h-full opacity-0 pointer-events-none [color-scheme:dark]"
      />
      <button
        type="button"
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          try {
            inputRef.current?.showPicker();
          } catch {
            // Pre-showPicker browsers: focusing opens the iOS wheel; desktop
            // fallback is click.
            inputRef.current?.focus();
            inputRef.current?.click();
          }
        }}
        aria-label={ariaLabel}
        className={className}
      >
        {children}
      </button>
      {onClear && value && (
        <button
          type="button"
          onClick={e => { e.preventDefault(); e.stopPropagation(); onClear(); }}
          aria-label="Clear date"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-gray-500 hover:text-white transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
