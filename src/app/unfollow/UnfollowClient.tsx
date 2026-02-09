'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

const FORMSPREE_FOLLOW_FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_FOLLOW_FORM_ID || '';
const FOLLOW_PREFIX = 'bsc_show_follow_subscribed_';

export default function UnfollowClient() {
  const searchParams = useSearchParams();
  const email = searchParams.get('email') || '';
  const showId = searchParams.get('show') || '';
  const showTitle = searchParams.get('title') || showId;

  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');

  // Auto-clear localStorage follow state on mount if params present
  useEffect(() => {
    if (showId) {
      try { localStorage.removeItem(`${FOLLOW_PREFIX}${showId}`); } catch { /* noop */ }
    }
  }, [showId]);

  if (!email || !showId) {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-bold text-white mb-4">Invalid Unfollow Link</h1>
        <p className="text-gray-400 mb-6">This link appears to be incomplete.</p>
        <Link href="/" className="text-brand hover:text-brand-hover transition-colors">
          Back to Broadway Scorecard
        </Link>
      </div>
    );
  }

  const handleUnfollow = async () => {
    setStatus('submitting');
    try {
      const res = await fetch(`https://formspree.io/f/${FORMSPREE_FOLLOW_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.toLowerCase().trim(),
          showId,
          showTitle,
          action: 'unfollow',
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
        <h1 className="text-2xl font-bold text-white mb-3">Unfollowed</h1>
        <p className="text-gray-400 mb-8">
          You won&apos;t receive any more updates for <span className="text-white font-medium">{showTitle}</span>.
        </p>
        <Link href={`/show/${showId}`} className="text-brand hover:text-brand-hover transition-colors">
          View {showTitle} on Broadway Scorecard
        </Link>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold text-white mb-3">Unfollow {showTitle}?</h1>
      <p className="text-gray-400 mb-8">
        You&apos;ll stop receiving email updates about this show.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <button
          onClick={handleUnfollow}
          disabled={status === 'submitting'}
          className="px-6 py-3 bg-red-500/80 hover:bg-red-500 disabled:bg-red-500/40 text-white font-semibold rounded-lg transition-colors"
        >
          {status === 'submitting' ? 'Unfollowing...' : 'Yes, Unfollow'}
        </button>
        <Link
          href={`/show/${showId}`}
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
