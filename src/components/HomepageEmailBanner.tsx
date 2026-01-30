'use client';

import { useState, useEffect, useCallback } from 'react';
import { useLoopsCapture } from '@/hooks/useLoopsCapture';

const VISIT_COUNT_KEY = 'bsc_visit_count';
const BANNER_DISMISSED_KEY = 'bsc_homepage_banner_dismissed';
const SUBSCRIBED_KEY = 'bsc_email_subscribed';
const COOLDOWN_DAYS = 30;

export default function HomepageEmailBanner() {
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState('');

  const { status, errorMessage, submit, isSubscribed } = useLoopsCapture({
    userGroup: 'main-site-subscriber',
    source: 'homepage-banner',
  });

  // Track visit count and check eligibility
  useEffect(() => {
    try {
      const alreadySubscribed = localStorage.getItem(SUBSCRIBED_KEY) === 'true';
      if (alreadySubscribed) return;

      // Increment visit count
      const count = parseInt(localStorage.getItem(VISIT_COUNT_KEY) || '0', 10) + 1;
      localStorage.setItem(VISIT_COUNT_KEY, String(count));

      // Need 2+ visits
      if (count < 2) return;

      // Check cooldown
      const dismissedAt = localStorage.getItem(BANNER_DISMISSED_KEY);
      if (dismissedAt) {
        const daysSince = (Date.now() - parseInt(dismissedAt, 10)) / (1000 * 60 * 60 * 24);
        if (daysSince < COOLDOWN_DAYS) return;
      }

      // Scroll trigger at 200px
      const handleScroll = () => {
        if (window.scrollY >= 200) {
          setVisible(true);
          window.removeEventListener('scroll', handleScroll);
        }
      };
      window.addEventListener('scroll', handleScroll, { passive: true });
      return () => window.removeEventListener('scroll', handleScroll);
    } catch { /* noop */ }
  }, []);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    try {
      localStorage.setItem(BANNER_DISMISSED_KEY, String(Date.now()));
    } catch { /* noop */ }
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await submit(email);
    if (ok) {
      setEmail('');
      setTimeout(() => setVisible(false), 3000);
    }
  }, [email, submit]);

  if (!visible || isSubscribed) return null;

  // Success state
  if (status === 'success' || status === 'already_subscribed') {
    return (
      <div className="sticky top-16 z-40 bg-emerald-500/10 border-b border-emerald-500/20">
        <div className="max-w-3xl mx-auto px-4 py-2 flex items-center justify-center gap-2 text-sm text-emerald-400">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span>You&apos;re in! We&apos;ll email you when new shows open.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="sticky top-16 z-40 bg-surface-raised border-b border-white/10">
      <div className="max-w-3xl mx-auto px-4 py-2">
        <form onSubmit={handleSubmit} className="flex items-center gap-2 sm:gap-3">
          <p className="hidden sm:block text-sm text-gray-300 whitespace-nowrap">
            <span className="font-semibold text-white">Never miss a new Broadway show</span> &mdash; we&apos;ll email you the Critic Score on opening night
          </p>
          <p className="sm:hidden text-xs text-gray-300 whitespace-nowrap font-medium">
            Opening night scores, as they happen
          </p>
          <label htmlFor="homepage-banner-email" className="sr-only">Email address</label>
          <input
            id="homepage-banner-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@example.com"
            required
            className="flex-1 min-w-0 px-3 py-1.5 bg-surface border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
          />
          <button
            type="submit"
            disabled={status === 'submitting'}
            className="px-3 py-1.5 bg-brand hover:bg-brand-hover disabled:bg-brand/50 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap"
          >
            {status === 'submitting' ? '...' : 'Subscribe'}
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            className="flex-shrink-0 p-1 text-gray-500 hover:text-white transition-colors"
            aria-label="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </form>
        {status === 'error' && errorMessage && (
          <p className="mt-1 text-xs text-red-400">{errorMessage}</p>
        )}
      </div>
    </div>
  );
}
