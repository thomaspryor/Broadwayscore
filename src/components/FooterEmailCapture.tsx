'use client';

import { useState, useCallback } from 'react';
import { useFormspreeCapture } from '@/hooks/useFormspreeCapture';
import { EMAIL_LIST_COPY } from '@/config/email-list-copy';

export default function FooterEmailCapture({ inputId = 'footer-email' }: { inputId?: string }) {
  const [email, setEmail] = useState('');
  const { status, errorMessage, submit, isSubscribed, market } = useFormspreeCapture({
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
      <div className="py-4">
        {/* Left-aligned like the account box beside it in the footer (BRO-4946).
            Inline check so it stays next to the text when the line wraps on phones. */}
        <p className="text-sm text-emerald-400">
          <svg className="inline-block w-4 h-4 mr-1.5 -mt-0.5 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {EMAIL_LIST_COPY.joined(market)}
        </p>
      </div>
    );
  }

  return (
    <div className="py-4">
      <p className="text-sm font-semibold text-white mb-1">{EMAIL_LIST_COPY.heading(market)}</p>
      <p className="text-xs text-gray-500 mb-3">{EMAIL_LIST_COPY.promise(market)}</p>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <label htmlFor={inputId} className="sr-only">Email address</label>
        <input
          id={inputId}
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
          className="min-h-[40px] px-4 py-2 bg-brand hover:bg-brand-hover disabled:bg-brand/50 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap"
        >
          {status === 'submitting' ? 'Sending...' : 'Get emails'}
        </button>
      </form>
      {status === 'error' && errorMessage && (
        <p className="mt-2 text-xs text-red-400">{errorMessage}</p>
      )}
    </div>
  );
}
