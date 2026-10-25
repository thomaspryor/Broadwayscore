'use client';

/**
 * MoneyGate - email gate for the Money Scorecard's show-level detail (BRO-6210).
 *
 * Wraps gated content. The content is always server-rendered into the HTML
 * (search engines read it; the paywall JSON-LD below says it is gated, so it
 * is not cloaking). While locked, CSS clips it to a blurred preview and the
 * sign-up card sits over the fade. One sign-up unlocks every gate on every
 * money page in this browser (src/lib/money-gate.ts).
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { track } from '@vercel/analytics';
import { captureEvent } from '@/lib/posthog-events';
import {
  MONEY_GATE_BOOT_SCRIPT,
  MONEY_ROLES,
  MONEY_UNLOCKED_EVENT,
  isMoneyUnlocked,
  isValidMoneyEmail,
  markMoneyUnlocked,
  moneyGatePaywallSchema,
  submitMoneySignup,
  type MoneyRole,
} from '@/lib/money-gate';

interface MoneyGateProps {
  children: ReactNode;
  /** Analytics label for where the gate sits, e.g. 'biz-dashboard', 'show-page'. */
  page: string;
  /** How much of the gated content shows, blurred, above the card. */
  preview?: 'short' | 'tall';
  /** Emit the paywall JSON-LD (once per page; off for a second gate on the same page). */
  schema?: boolean;
}

export default function MoneyGate({ children, page, preview = 'tall', schema = true }: MoneyGateProps) {
  // null until mounted: the server render is the locked markup, and CSS
  // (driven by the boot script's <html> attribute) decides what shows.
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [justUnlocked, setJustUnlocked] = useState(false);
  const lockRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlockedNow = isMoneyUnlocked();
    if (unlockedNow) document.documentElement.setAttribute('data-money-unlocked', '');
    setUnlocked(unlockedNow);
    const onUnlock = () => setUnlocked(true);
    window.addEventListener(MONEY_UNLOCKED_EVENT, onUnlock);
    return () => window.removeEventListener(MONEY_UNLOCKED_EVENT, onUnlock);
  }, []);

  // Locked content is blurred: keep keyboard focus and screen readers out of
  // it. Set once mounted (never in the server HTML, which stays readable).
  useEffect(() => {
    if (contentRef.current) contentRef.current.inert = unlocked === false;
  }, [unlocked]);

  // money_gate_shown fires once, when the card first scrolls into view.
  useEffect(() => {
    if (unlocked !== false || !lockRef.current) return;
    const el = lockRef.current;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        track('money_gate_shown', { page });
        captureEvent('money_gate_shown', { page, path: window.location.pathname });
        io.disconnect();
      }
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [unlocked, page]);

  const handleUnlocked = useCallback(() => {
    setJustUnlocked(true);
    setUnlocked(true);
  }, []);

  return (
    <div className="money-gate" data-money-gate={page} data-preview={preview}>
      <script dangerouslySetInnerHTML={{ __html: MONEY_GATE_BOOT_SCRIPT }} />
      {schema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(moneyGatePaywallSchema()) }}
        />
      )}
      {justUnlocked && (
        <p role="status" className="money-gate-success mb-3 inline-flex items-center gap-2 rounded-full border border-status-open/30 bg-status-open/10 px-3 py-1 text-xs font-medium text-status-open">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          Unlocked on every Money Scorecard page
        </p>
      )}
      <div ref={contentRef} className="money-gated money-gate-content">
        {children}
      </div>
      <div ref={lockRef} className="money-gate-lock">
        <MoneyGateCard page={page} onUnlocked={handleUnlocked} />
      </div>
    </div>
  );
}

function MoneyGateCard({ page, onUnlocked }: { page: string; onUnlocked: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MoneyRole | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const id = useId();

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!isValidMoneyEmail(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    setSubmitting(true);
    const result = await submitMoneySignup(email, role, `${page}:${window.location.pathname}`);
    setSubmitting(false);
    if (result === 'invalid') {
      setError('Please enter a valid email address.');
      return;
    }
    const props = { page, role: role || 'none', stored: result === 'stored' };
    track('money_gate_unlocked', props);
    captureEvent('money_gate_unlocked', { ...props, path: window.location.pathname });
    markMoneyUnlocked();
    onUnlocked();
  }, [email, role, page, onUnlocked]);

  return (
    <div className="money-gate-card card-premium mx-auto w-full max-w-lg rounded-2xl border border-brand/25 bg-surface-elevated p-5 shadow-2xl sm:p-7">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand/15 text-brand" aria-hidden="true">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="5" y="11" width="14" height="10" rx="2" strokeWidth={2} />
            <path d="M8 11V8a4 4 0 118 0v3" strokeWidth={2} strokeLinecap="round" />
          </svg>
        </span>
        <span className="text-xs font-bold uppercase tracking-[0.14em] text-brand">Money Scorecard</span>
      </div>
      <h3 className="text-xl font-bold leading-tight text-white sm:text-2xl">Free with your email</h3>
      <p className="mt-2 text-sm leading-relaxed text-gray-300">
        The Money Scorecard is for people who follow the business of Broadway. Show-by-show
        capitalization, recoupment and box office, on every page, with one sign-up.
      </p>

      <form onSubmit={handleSubmit} className="mt-5" noValidate>
        <label htmlFor={`${id}-email`} className="sr-only">Email address</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={`${id}-email`}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className="min-h-[44px] w-full min-w-0 flex-1 rounded-lg border border-white/10 bg-surface px-3.5 text-base text-white placeholder-gray-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand sm:text-sm"
          />
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary min-h-[44px] whitespace-nowrap px-5 text-sm disabled:opacity-60 disabled:hover:scale-100"
          >
            {submitting ? 'Unlocking…' : 'Unlock'}
          </button>
        </div>

        <fieldset className="mt-4">
          <legend className="mb-2 text-xs text-gray-400">I&apos;m a… <span className="text-gray-500">(optional)</span></legend>
          <div className="flex flex-wrap gap-1.5">
            {MONEY_ROLES.map((r) => {
              const active = role === r.value;
              return (
                <button
                  key={r.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setRole(active ? '' : r.value)}
                  className={`min-h-[36px] rounded-full border px-3 text-xs font-medium transition-colors ${
                    active
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-white/10 bg-white/5 text-gray-300 hover:border-white/20 hover:text-white'
                  }`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        {error && (
          <p id={`${id}-error`} role="alert" className="mt-3 text-xs text-score-skip">{error}</p>
        )}
        <p className="mt-4 text-xs text-gray-500">
          One step, no password. Its own list, separate from our newsletter.
        </p>
      </form>
    </div>
  );
}
