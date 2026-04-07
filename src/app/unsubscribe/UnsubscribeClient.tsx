'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { SUBSCRIBED_KEY, SUBSCRIBED_KEY_PREFIX } from '@/hooks/useFormspreeSubscribed';

const FORMSPREE_SUBSCRIBER_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || '';
const FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID || '';

export default function UnsubscribeClient() {
  const searchParams = useSearchParams();
  const email = searchParams.get('email') || '';
  const market = searchParams.get('market') === 'west-end' ? 'west-end' : 'broadway';

  const isWestEnd = market === 'west-end';
  const siteName = isWestEnd ? 'West End Scorecard' : 'Broadway Scorecard';
  const homeLink = isWestEnd ? '/west-end' : '/';
  // Fall back to Broadway form if WE form not configured
  const formId = isWestEnd && FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID
    ? FORMSPREE_WESTEND_SUBSCRIBER_FORM_ID
    : FORMSPREE_SUBSCRIBER_FORM_ID;

  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');

  if (!email) {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-bold text-white mb-4">Invalid Unsubscribe Link</h1>
        <p className="text-gray-400 mb-6">This link appears to be incomplete.</p>
        <Link href={homeLink} className="text-brand hover:text-brand-hover transition-colors">
          Back to {siteName}
        </Link>
      </div>
    );
  }

  const handleUnsubscribe = async () => {
    setStatus('submitting');
    try {
      const res = await fetch(`https://formspree.io/f/${formId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.toLowerCase().trim(),
          action: 'unsubscribe',
        }),
      });
      if (res.ok) {
        // Clear localStorage so the site doesn't falsely show "Subscribed"
        // Also reset page view counter to avoid immediately re-gating the user
        try {
          localStorage.removeItem(SUBSCRIBED_KEY_PREFIX + market);
          localStorage.removeItem(SUBSCRIBED_KEY); // Legacy key
          localStorage.removeItem('bsc_user_data');
          localStorage.removeItem('bsc_page_views');
        } catch { /* noop */ }
        setStatus('success');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  };

  if (status === 'success') {
    return (
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
          <svg className="w-8 h-8 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-white mb-3">Unsubscribed</h1>
        <p className="text-gray-400 mb-8">
          You&apos;ve been unsubscribed from opening night email alerts.
        </p>
        <Link href={homeLink} className="text-brand hover:text-brand-hover transition-colors">
          Back to {siteName}
        </Link>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold text-white mb-3">Unsubscribe?</h1>
      <p className="text-gray-400 mb-2">
        You&apos;ll stop receiving opening night email alerts from {siteName}.
      </p>
      <p className="text-gray-500 text-sm mb-8">
        {email}
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <button
          onClick={handleUnsubscribe}
          disabled={status === 'submitting'}
          className="px-6 py-3 bg-red-500/80 hover:bg-red-500 disabled:bg-red-500/40 text-white font-semibold rounded-lg transition-colors"
        >
          {status === 'submitting' ? 'Unsubscribing...' : 'Yes, Unsubscribe'}
        </button>
        <Link
          href={homeLink}
          className="px-6 py-3 bg-surface-raised hover:bg-surface-overlay text-gray-300 font-semibold rounded-lg transition-colors border border-white/10"
        >
          Cancel
        </Link>
      </div>
      {status === 'error' && (
        <p className="mt-4 text-sm text-red-400">Something went wrong. Please try again.</p>
      )}
    </div>
  );
}
