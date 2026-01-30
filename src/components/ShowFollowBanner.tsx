'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLoopsCapture } from '@/hooks/useLoopsCapture';

const DISMISSED_PREFIX = 'bsc_show_follow_dismissed_';
const SUBSCRIBED_KEY = 'bsc_email_subscribed';

interface ShowFollowBannerProps {
  showId: string;
  showTitle: string;
}

export default function ShowFollowBanner({ showId, showTitle }: ShowFollowBannerProps) {
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [email, setEmail] = useState('');

  const loopsOptions = useMemo(() => ({
    userGroup: 'show-follower',
    source: 'show-page',
    showId,
    showTitle,
  }), [showId, showTitle]);

  const { status, errorMessage, submit, isSubscribed } = useLoopsCapture(loopsOptions);

  // Check dismiss state and subscription
  useEffect(() => {
    try {
      const wasDismissed = localStorage.getItem(`${DISMISSED_PREFIX}${showId}`);
      const alreadySubscribed = localStorage.getItem(SUBSCRIBED_KEY) === 'true';
      if (!wasDismissed && !alreadySubscribed) {
        setDismissed(false);
      }
    } catch { /* noop */ }
  }, [showId]);

  // Scroll-triggered visibility at 60%
  useEffect(() => {
    if (dismissed || isSubscribed) return;

    const handleScroll = () => {
      const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollHeight > 0) {
        const pct = window.scrollY / scrollHeight;
        if (pct >= 0.6) {
          setVisible(true);
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [dismissed, isSubscribed]);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    setDismissed(true);
    try {
      localStorage.setItem(`${DISMISSED_PREFIX}${showId}`, 'true');
    } catch { /* noop */ }
  }, [showId]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await submit(email);
    if (ok) {
      setEmail('');
      setTimeout(() => {
        setVisible(false);
        setDismissed(true);
      }, 3000);
    }
  }, [email, submit]);

  if (dismissed || isSubscribed || !visible) return null;

  // Success state
  if (status === 'success' || status === 'already_subscribed') {
    return (
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-surface-raised border-t border-white/10 shadow-2xl animate-in slide-in-from-bottom">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-center gap-2 text-sm text-emerald-400">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span>Following {showTitle}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-surface-raised border-t border-white/10 shadow-2xl animate-in slide-in-from-bottom">
      <div className="max-w-3xl mx-auto px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white leading-tight mb-2">
              Follow {showTitle} for new reviews, cast changes & lottery alerts
            </p>
            <form onSubmit={handleSubmit} className="flex gap-2">
              <label htmlFor="show-follow-email" className="sr-only">Email address</label>
              <input
                id="show-follow-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
                required
                className="flex-1 min-w-0 px-3 py-2 bg-surface border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
              />
              <button
                type="submit"
                disabled={status === 'submitting'}
                className="px-4 py-2 bg-brand hover:bg-brand-hover disabled:bg-brand/50 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap"
              >
                {status === 'submitting' ? '...' : 'Follow'}
              </button>
            </form>
            {status === 'error' && errorMessage && (
              <p className="mt-1 text-xs text-red-400">{errorMessage}</p>
            )}
          </div>
          <button
            onClick={handleDismiss}
            className="flex-shrink-0 p-1 text-gray-500 hover:text-white transition-colors mt-0.5"
            aria-label="Dismiss"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
