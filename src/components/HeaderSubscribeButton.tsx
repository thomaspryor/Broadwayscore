'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useLoopsCapture } from '@/hooks/useLoopsCapture';

export default function HeaderSubscribeButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);
  const { status, errorMessage, submit, isSubscribed } = useLoopsCapture({
    userGroup: 'main-site-subscriber',
    source: 'header',
  });

  // Auto-close on success
  useEffect(() => {
    if (status === 'success' || status === 'already_subscribed') {
      const timer = setTimeout(() => setIsOpen(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [status]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen]);

  // Prevent body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await submit(email);
    if (ok) setEmail('');
  }, [email, submit]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
      setIsOpen(false);
    }
  }, []);

  // Already subscribed — show checkmark button
  if (isSubscribed && !isOpen) {
    return (
      <button
        className="ml-1 px-3 py-1.5 text-sm font-semibold text-emerald-400 bg-emerald-400/10 rounded-lg cursor-default flex items-center gap-1.5"
        aria-label="Subscribed"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        Subscribed
      </button>
    );
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="ml-1 px-3 py-1.5 text-sm font-semibold text-white bg-brand hover:bg-brand-hover rounded-lg transition-colors"
      >
        Get the Scorecard
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          onClick={handleBackdropClick}
          role="dialog"
          aria-modal="true"
          aria-label="Subscribe to Broadway Scorecard"
        >
          <div ref={modalRef} className="relative w-full max-w-sm bg-surface-raised border border-white/10 rounded-2xl p-6 shadow-2xl">
            {/* Close button */}
            <button
              onClick={() => setIsOpen(false)}
              className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            {status === 'success' || status === 'already_subscribed' ? (
              <div className="text-center py-4">
                <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-400/10 flex items-center justify-center">
                  <svg className="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-white font-semibold">You&apos;re in!</p>
                <p className="text-sm text-gray-400 mt-1">We&apos;ll email you whenever a new show opens on Broadway with its Critic Score.</p>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-bold text-white">Never Miss a New Broadway Show</h2>
                <p className="text-sm text-gray-400 mt-1 mb-4">Get opening night scores, closing alerts, and a roundup of what&apos;s hot on Broadway.</p>

                <form onSubmit={handleSubmit}>
                  <label htmlFor="header-modal-email" className="sr-only">Email address</label>
                  <input
                    id="header-modal-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="email@example.com"
                    required
                    autoFocus
                    className="w-full px-3 py-2.5 bg-surface border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
                  />
                  <button
                    type="submit"
                    disabled={status === 'submitting'}
                    className="w-full mt-3 px-4 py-2.5 bg-brand hover:bg-brand-hover disabled:bg-brand/50 text-white text-sm font-semibold rounded-lg transition-colors"
                  >
                    {status === 'submitting' ? 'Subscribing...' : 'Subscribe'}
                  </button>
                </form>

                {status === 'error' && errorMessage && (
                  <p className="mt-2 text-xs text-red-400 text-center">{errorMessage}</p>
                )}

                <p className="mt-3 text-xs text-gray-500 text-center">No spam, no schedule &mdash; just opening night scores. Unsubscribe anytime.</p>
                <p className="mt-1.5 text-xs text-gray-600 text-center">Aggregating 1,150+ reviews from the NYT, Variety, Vulture &amp; more</p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
