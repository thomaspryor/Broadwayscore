'use client';

import { useEffect, useCallback } from 'react';

type SignInContext = 'rating' | 'watchlist' | 'generic';

interface SignInModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSignIn: (provider: 'google') => void;
  context?: SignInContext;
  loading?: boolean;
}

const CONTEXT_HEADLINES: Record<SignInContext, string> = {
  rating: 'Sign in to save your rating',
  watchlist: 'Sign in to save your watchlist',
  generic: 'Sign in to Broadway Scorecard',
};

const CONTEXT_SUBTEXT: Record<SignInContext, string> = {
  rating: 'Your rating will be saved automatically after sign-in.',
  watchlist: 'Your watchlist will be saved automatically after sign-in.',
  generic: 'Track shows, rate performances, and build your theater diary.',
};

export default function SignInModal({ isOpen, onClose, onSignIn, context = 'generic', loading = false }: SignInModalProps) {
  // Close on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        document.body.style.overflow = '';
      };
    }
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-sm bg-[#1a1a24] rounded-2xl border border-white/10 shadow-2xl p-6 animate-in fade-in zoom-in-95 duration-200">
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-500 hover:text-white transition-colors"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Logo */}
        <div className="flex items-center justify-center mb-4">
          <span className="text-lg font-bold text-white">Broadway</span>
          <span className="text-lg font-bold text-gradient">Scorecard</span>
        </div>

        {/* Headline */}
        <h2 className="text-lg font-bold text-white text-center mb-1">
          {CONTEXT_HEADLINES[context]}
        </h2>
        <p className="text-sm text-gray-400 text-center mb-6">
          {CONTEXT_SUBTEXT[context]}
        </p>

        {/* Sign in buttons */}
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

          {/* Apple (disabled for Phase 1) */}
          <button
            type="button"
            disabled
            className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white/[0.05] text-gray-500 font-semibold text-sm rounded-lg border border-white/10 cursor-not-allowed"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
            </svg>
            Apple Sign-In (Coming Soon)
          </button>
        </div>

        {/* Footer */}
        <p className="mt-5 text-center text-[11px] text-gray-600 leading-relaxed">
          By signing in, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
}
