'use client';

/**
 * MoneyGate - email gate for the Profitability Scorecard's show-level detail (BRO-6210).
 *
 * Wraps gated content. The content is always server-rendered into the HTML
 * (search engines read it; the paywall JSON-LD below says it is gated, so it
 * is not cloaking). While locked, CSS clips it to a blurred preview and the
 * sign-up card sits over the fade. One sign-up unlocks every gate on every
 * money page in this browser (src/lib/money-gate.ts). Signed-in readers and
 * newsletter / opening-night subscribers skip it (BRO-6248).
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { track } from '@vercel/analytics';
import { captureEvent } from '@/lib/posthog-events';
import { gaEvent } from '@/lib/analytics/ga-event';
import { useAuth } from '@/contexts/AuthContext';
import { featureFlags } from '@/config/feature-flags';
import {
  MONEY_EMAIL_USE,
  MONEY_GATE_BOOT_SCRIPT,
  MONEY_ROLES,
  MONEY_UNLOCKED_EVENT,
  isMoneyUnlocked,
  markMoneyUnlocked,
  moneyGatePaywallSchema,
  moneyUnlockReason,
  submitMoneySignup,
  retryPendingMoneySignups,
  unlockForExistingReader,
  type MoneyBypassReason,
  type MoneyRole,
} from '@/lib/money-gate';
import { MONEY_EMAIL_PROBLEM_MESSAGES, moneyEmailProblem, suggestMoneyEmail } from '@/lib/money-email';

interface MoneyGateProps {
  children: ReactNode;
  /** Analytics label for where the gate sits, e.g. 'biz-dashboard', 'show-page'. */
  page: string;
  /** How much of the gated content shows, blurred, above the card. */
  preview?: 'short' | 'tall';
  /** Emit the paywall JSON-LD (once per page; off for a second gate on the same page). */
  schema?: boolean;
}

// The boot script only runs on a full page load; on a client-side navigation
// the attribute has to be set before paint here, or a returning reader sees
// the lock flash for a frame.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// money_gate_bypassed counts readers who see the money data without the gate.
// Like money_gate_shown it fires when the content scrolls into view, and once
// per page view: a page with several gates, or a sign-in after a load-time
// unlock, must not count twice. The flag resets when the page's last gate unmounts.
type Bypass = { reason: MoneyBypassReason; when: 'load' | 'midvisit' };
let mountedGates = 0;
let bypassTracked = false;
function trackMoneyBypass(page: MoneyGateProps['page'], { reason, when }: Bypass) {
  if (bypassTracked) return;
  bypassTracked = true;
  track('money_gate_bypassed', { page, reason, when });
  gaEvent('money_gate_bypassed', { page, reason, when });
  captureEvent('money_gate_bypassed', { page, reason, when, path: window.location.pathname });
}

export default function MoneyGate({ children, page, preview = 'tall', schema = true }: MoneyGateProps) {
  // null until mounted: the server render is the locked markup, and CSS
  // (driven by the boot script's <html> attribute) decides what shows.
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [justUnlocked, setJustUnlocked] = useState(false);
  const [bypass, setBypass] = useState<Bypass | null>(null);
  const lockRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const { isAuthenticated } = useAuth();

  useIsoLayoutEffect(() => {
    const reason = moneyUnlockReason();
    const unlockedNow = reason !== null;
    // A bypass unlock is page-only: after sign-out and a client navigation the
    // attribute would outlive it and leave the content shown but inert.
    if (unlockedNow) document.documentElement.setAttribute('data-money-unlocked', '');
    else document.documentElement.removeAttribute('data-money-unlocked');
    setUnlocked(unlockedNow);
    if (reason) setBypass({ reason, when: 'load' });
    const onUnlock = () => setUnlocked(true);
    // Joining the main list elsewhere on the page (footer, header) counts too.
    const onSubscribed = () => {
      if (isMoneyUnlocked() && unlockForExistingReader()) setBypass({ reason: 'subscriber', when: 'midvisit' });
    };
    window.addEventListener(MONEY_UNLOCKED_EVENT, onUnlock);
    window.addEventListener('bsc_subscribed', onSubscribed);
    return () => {
      window.removeEventListener(MONEY_UNLOCKED_EVENT, onUnlock);
      window.removeEventListener('bsc_subscribed', onSubscribed);
    };
  }, []);

  // A sign-up whose save failed on an earlier page view is retried here (BRO-6289).
  useEffect(() => {
    retryPendingMoneySignups().then(({ stored, remaining }) => {
      if (stored) captureEvent('money_gate_signup_retried', { stored, remaining });
    }).catch(() => { /* stays queued for the next page view */ });
  }, []);

  useEffect(() => {
    mountedGates += 1;
    return () => {
      mountedGates -= 1;
      if (mountedGates === 0) bypassTracked = false;
    };
  }, []);

  // Signed in (on load or mid-visit): unlock without asking for an email.
  useEffect(() => {
    if (isAuthenticated && unlockForExistingReader()) setBypass({ reason: 'account', when: 'midvisit' });
  }, [isAuthenticated]);

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
      // An OAuth return can unlock the page just before this fires.
      if (document.documentElement.hasAttribute('data-money-unlocked')) { io.disconnect(); return; }
      if (entries.some((e) => e.isIntersecting)) {
        track('money_gate_shown', { page });
        gaEvent('money_gate_shown', { page });
        captureEvent('money_gate_shown', { page, path: window.location.pathname });
        io.disconnect();
      }
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [unlocked, page]);

  useEffect(() => {
    if (!bypass || !contentRef.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        trackMoneyBypass(page, bypass);
        io.disconnect();
      }
    });
    io.observe(contentRef.current);
    return () => io.disconnect();
  }, [bypass, page]);

  // The submit button disappears with the card: move focus to the confirmation.
  useEffect(() => {
    if (justUnlocked) statusRef.current?.focus();
  }, [justUnlocked]);

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
        <p ref={statusRef} tabIndex={-1} role="status" className="money-gate-success mb-3 focus:outline-none inline-flex items-center gap-2 rounded-full border border-status-open/30 bg-status-open/10 px-3 py-1 text-xs font-medium text-status-open">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          Unlocked on every Profitability Scorecard page
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
  const { showSignIn } = useAuth();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MoneyRole | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // A likely typo (gmial.com): offered once, never forced. 'Keep mine' skips it.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [keepMine, setKeepMine] = useState('');
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuggestion(null);
    const problem = moneyEmailProblem(email);
    if (problem) {
      setError(MONEY_EMAIL_PROBLEM_MESSAGES[problem]);
      captureEvent('money_gate_email_refused', { page, reason: problem });
      return;
    }
    const fix = email.trim() === keepMine ? null : suggestMoneyEmail(email);
    if (fix) {
      setKeepMine(email.trim()); // offered once: pressing Unlock again goes ahead
      setSuggestion(fix);
      return;
    }
    setSubmitting(true);
    const result = await submitMoneySignup(email, role, `${page}:${window.location.pathname}`);
    setSubmitting(false);
    if (result === 'invalid' || result === 'no_mail_server') {
      const reason = result === 'invalid' ? 'format' : result;
      setError(MONEY_EMAIL_PROBLEM_MESSAGES[reason]);
      captureEvent('money_gate_email_refused', { page, reason });
      return;
    }
    const props = { page, role: role || 'none', stored: result === 'stored' };
    track('money_gate_unlocked', props);
    gaEvent('money_gate_unlocked', { page, role: props.role, stored: String(props.stored) });
    captureEvent('money_gate_unlocked', { ...props, path: window.location.pathname });
    markMoneyUnlocked();
    onUnlocked();
  }, [email, role, page, onUnlocked, keepMine]);

  return (
    <div className="money-gate-card card-premium mx-auto w-full max-w-lg rounded-2xl border border-brand/25 bg-surface-elevated p-5 shadow-2xl sm:p-7">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand/15 text-brand" aria-hidden="true">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="5" y="11" width="14" height="10" rx="2" strokeWidth={2} />
            <path d="M8 11V8a4 4 0 118 0v3" strokeWidth={2} strokeLinecap="round" />
          </svg>
        </span>
        <span className="text-xs font-bold uppercase tracking-[0.14em] text-brand">Profitability Scorecard</span>
      </div>
      <h3 className="text-xl font-bold leading-tight text-white sm:text-2xl">Unlock the Profitability Scorecard</h3>
      <p className="mt-2 text-sm leading-relaxed text-gray-300">
        Always free. Show-by-show capitalization, recoupment and box office for every Broadway show.
        One sign&#8209;up unlocks every page.
      </p>

      <form onSubmit={handleSubmit} className="mt-5" noValidate>
        <label htmlFor={`${id}-email`} className="sr-only">Email address</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={inputRef}
            id={`${id}-email`}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setSuggestion(null); setError(''); }}
            placeholder="you@example.com"
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className="min-h-[44px] w-full min-w-0 flex-1 rounded-lg border border-white/10 bg-surface px-3.5 text-base text-white placeholder-fg-placeholder focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand sm:text-sm"
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
          <legend className="mb-2 text-xs text-gray-400">I&apos;m a… <span className="text-gray-400">(optional)</span></legend>
          <div className="flex flex-wrap gap-1.5">
            {MONEY_ROLES.map((r) => {
              const active = role === r.value;
              return (
                <button
                  key={r.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setRole(active ? '' : r.value)}
                  className={`min-h-[36px] rounded-full border px-3 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
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

        {suggestion && (
          <div role="status" className="money-gate-suggestion mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-score-tepid/30 bg-score-tepid/10 px-3 py-2 text-xs text-gray-200">
            <span className="min-w-0 break-all">Did you mean <strong className="text-white">{suggestion}</strong>?</span>
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => { setEmail(suggestion); setSuggestion(null); inputRef.current?.focus(); }}
                className="min-h-[36px] rounded-full border border-brand bg-brand/10 px-3 font-medium text-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                Use it
              </button>
              <button
                type="button"
                onClick={() => { setKeepMine(email.trim()); setSuggestion(null); inputRef.current?.focus(); }}
                className="min-h-[36px] rounded-full border border-white/10 bg-white/5 px-3 font-medium text-gray-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                Keep mine
              </button>
            </span>
          </div>
        )}
        {error && (
          <p id={`${id}-error`} role="alert" className="mt-3 text-xs text-score-skip">{error}</p>
        )}
        <p className="mt-4 text-xs leading-relaxed text-gray-400">
          {MONEY_EMAIL_USE}{' '}
          <a href="/privacy" className="underline underline-offset-2 hover:text-white">Privacy</a>
        </p>
        {featureFlags.userAccounts && (
          <p className="mt-2 text-xs text-gray-400">
            Already have an account?{' '}
            <button
              type="button"
              onClick={() => showSignIn('generic', `money_gate:${page}`)}
              className="font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
            >
              Sign in
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
