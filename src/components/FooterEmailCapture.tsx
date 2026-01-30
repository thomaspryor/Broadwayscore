'use client';

import { useState, useCallback } from 'react';
import { useLoopsCapture } from '@/hooks/useLoopsCapture';

export default function FooterEmailCapture() {
  const [email, setEmail] = useState('');
  const { status, errorMessage, submit, isSubscribed } = useLoopsCapture({
    userGroup: 'main-site-subscriber',
    source: 'footer',
  });

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await submit(email);
    if (ok) setEmail('');
  }, [email, submit]);

  if (isSubscribed || status === 'success' || status === 'already_subscribed') {
    return (
      <div className="text-center py-4">
        <div className="flex items-center justify-center gap-2 text-sm text-emerald-400">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span>Subscribed &mdash; we&apos;ll email you when new shows open</span>
        </div>
      </div>
    );
  }

  return (
    <div className="py-4">
      <p className="text-sm font-semibold text-white mb-1">Never Miss a New Broadway Show</p>
      <p className="text-xs text-gray-500 mb-3">No spam, no schedule &mdash; just opening night scores. Unsubscribe anytime.</p>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <label htmlFor="footer-email" className="sr-only">Email address</label>
        <input
          id="footer-email"
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
          {status === 'submitting' ? 'Sending...' : 'Subscribe'}
        </button>
      </form>
      {status === 'error' && errorMessage && (
        <p className="mt-2 text-xs text-red-400">{errorMessage}</p>
      )}
    </div>
  );
}
