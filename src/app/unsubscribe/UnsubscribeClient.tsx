'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

const FORMSPREE_FOLLOW_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_FOLLOW_FORM_ID || '';

export default function UnsubscribeClient() {
  const searchParams = useSearchParams();
  const email = searchParams.get('email') || '';

  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');

  if (!email) {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-bold text-white mb-4">Invalid Unsubscribe Link</h1>
        <p className="text-gray-400 mb-6">This link appears to be incomplete.</p>
        <Link href="/" className="text-brand hover:text-brand-hover transition-colors">
          Back to Broadway Scorecard
        </Link>
      </div>
    );
  }

  const handleUnsubscribe = async () => {
    setStatus('submitting');
    try {
      const res = await fetch(`https://formspree.io/f/${FORMSPREE_FOLLOW_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.toLowerCase().trim(),
          action: 'unsubscribe',
        }),
      });
      if (res.ok) {
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
        <Link href="/" className="text-brand hover:text-brand-hover transition-colors">
          Back to Broadway Scorecard
        </Link>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold text-white mb-3">Unsubscribe?</h1>
      <p className="text-gray-400 mb-2">
        You&apos;ll stop receiving opening night email alerts from Broadway Scorecard.
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
          href="/"
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
