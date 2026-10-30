'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import { prepareAppleSignIn } from '@/lib/apple-auth';
import EmailCodeForm, { type EmailAuthResult } from './EmailCodeForm';

type SignInContext = 'rating' | 'watchlist' | 'watchlist_local' | 'generic';

interface SignInModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSignIn: (provider: 'google' | 'apple') => void;
  /** Email sign-in with a one-time code (BRO-6575). Hidden when omitted. */
  onSendEmailCode?: (email: string) => Promise<EmailAuthResult>;
  onVerifyEmailCode?: (email: string, code: string) => Promise<EmailAuthResult>;
  context?: SignInContext;
  loading?: boolean;
  error?: string | null;
}

const CONTEXT_HEADLINES: Record<SignInContext, string> = {
  rating: 'Sign in to save your rating',
  watchlist: 'Sign in to save your watchlist',
  watchlist_local: 'Saved. Keep your list with a free account',
  // "Sign in" alone read as "for people who already have an account", and
  // email-list members assumed they did (BRO-4893).
  generic: 'Sign in or create a free account',
};

const CONTEXT_SUBTEXT: Record<SignInContext, string> = {
  rating: 'Your rating will be saved automatically after sign-in.',
  watchlist: 'Your watchlist will be saved automatically after sign-in.',
  watchlist_local: "Your list is on this device for now. Sign in to see it on your phone and computer, and we'll move it over for you.",
  generic: 'Track shows, rate performances, and build your theater diary.',
};

export default function SignInModal({ isOpen, onClose, onSignIn, onSendEmailCode, onVerifyEmailCode, context = 'generic', loading = false, error = null }: SignInModalProps) {
  const [appleReady, setAppleReady] = useState(false);
  const [emailMode, setEmailMode] = useState(false);
  // Every opening starts at the provider buttons.
  useEffect(() => {
    if (!isOpen) setEmailMode(false);
  }, [isOpen]);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  // Set Apple up while the box is open, so the tap opens its popup directly
  // (Safari blocks a popup that opens after any waiting).
  useEffect(() => {
    let cancelled = false;
    setAppleReady(false);
    setPrepareError(null);
    if (isOpen && !loading) {
      prepareAppleSignIn().then(() => {
        if (!cancelled) setAppleReady(true);
      }).catch(() => {
        if (!cancelled) setPrepareError('Apple sign-in is unavailable. Please try again, or continue with Google.');
      });
    }
    return () => { cancelled = true; };
  }, [isOpen, loading]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} zIndex={80} maxWidth="sm" ariaLabel="Sign in or create a free account">
      <div className="p-6">
        <ModalCloseButton onClick={onClose} className="absolute top-4 right-4" />

        {/* Logo */}
        <div className="flex items-center justify-center mb-4">
          <span className="text-lg font-bold text-white">Broadway<span className="text-gradient">Scorecard</span></span>
        </div>

        {/* Headline */}
        <h2 className="text-lg font-bold text-white text-center mb-1">
          {CONTEXT_HEADLINES[context]}
        </h2>
        <p className="text-sm text-gray-400 text-center mb-6">
          {CONTEXT_SUBTEXT[context]}
        </p>

        {emailMode && onSendEmailCode && onVerifyEmailCode ? (
          <EmailCodeForm
            onSendCode={onSendEmailCode}
            onVerifyCode={onVerifyEmailCode}
            onBack={() => setEmailMode(false)}
            disabled={loading}
          />
        ) : (
        /* Sign in buttons: Google and Apple first, email third (owner, 2026-10-30) */
        <div className="space-y-3">
          {/* Google */}
          <button
            type="button"
            onClick={() => onSignIn('google')}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white text-gray-800 font-semibold text-sm rounded-lg hover:bg-gray-100 disabled:opacity-50 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            {loading ? 'Signing in...' : 'Continue with Google'}
          </button>

          {/* Apple */}
          <button
            type="button"
            onClick={() => onSignIn('apple')}
            disabled={loading || !appleReady}
            aria-busy={!appleReady && !prepareError}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-black text-white font-semibold text-sm rounded-lg border border-white/20 hover:bg-surface-raised disabled:opacity-50 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
            </svg>
            {loading ? 'Signing in...' : 'Continue with Apple'}
          </button>

          {onSendEmailCode && onVerifyEmailCode && (
            <>
              <div className="flex items-center gap-3 pt-1" aria-hidden="true">
                <div className="h-px flex-1 bg-white/10" />
                <span className="text-xs text-fg-muted">or</span>
                <div className="h-px flex-1 bg-white/10" />
              </div>
              <button
                type="button"
                onClick={() => setEmailMode(true)}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-transparent text-gray-200 font-semibold text-sm rounded-lg border border-white/20 hover:bg-surface-overlay disabled:opacity-50 transition-colors"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M3 7l9 6 9-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Continue with email
              </button>
            </>
          )}
        </div>
        )}

        {(error || prepareError) && (
          <p role="alert" className="mt-4 text-sm text-score-skip">
            {error || prepareError}
          </p>
        )}

        {/* Footer */}
        <p className="mt-5 text-center text-xs text-gray-400 leading-relaxed">
          New here? This creates your free account. You&apos;ll also get our Broadway opening night emails; unsubscribe anytime. By continuing, you agree to our{' '}
          <Link href="/terms" target="_blank" className="underline hover:text-gray-200">Terms</Link> and{' '}
          <Link href="/privacy" target="_blank" className="underline hover:text-gray-200">Privacy Policy</Link>.
        </p>
      </div>
    </Modal>
  );
}
