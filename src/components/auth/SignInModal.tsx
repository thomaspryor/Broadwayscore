'use client';

import { Modal, ModalCloseButton } from '@/components/show-cards';

type SignInContext = 'rating' | 'watchlist' | 'generic';

interface SignInModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSignIn: (provider: 'google' | 'apple') => void;
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
  return (
    <Modal isOpen={isOpen} onClose={onClose} zIndex={80} maxWidth="sm" ariaLabel="Sign in">
      <div className="p-6">
        <ModalCloseButton onClick={onClose} className="absolute top-4 right-4" />

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

          {/* Apple */}
          <button
            type="button"
            onClick={() => onSignIn('apple')}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-black text-white font-semibold text-sm rounded-lg border border-white/20 hover:bg-surface-raised disabled:opacity-50 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
            </svg>
            {loading ? 'Signing in...' : 'Continue with Apple'}
          </button>
        </div>

        {/* Footer */}
        <p className="mt-5 text-center text-[11px] text-gray-600 leading-relaxed">
          By signing in, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </Modal>
  );
}
