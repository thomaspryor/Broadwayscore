'use client';

import { useState, useCallback, useEffect } from 'react';
import { useFormspreeCapture } from '@/hooks/useFormspreeCapture';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import CreateAccountNudge from '@/components/CreateAccountNudge';
import { EMAIL_LIST_COPY, marketLabel as labelFor } from '@/config/email-list-copy';
import { featureFlags } from '@/config/feature-flags';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Opening night emails signup button + modal.
 *
 * `placement="header"`: renders nothing once this browser is on the list or
 * the visitor is signed in. A joined-state badge here sat next to "Sign in"
 * and read as "you have an account" (BRO-4893).
 * `placement="footer"` (footer link row): shows plain joined text instead.
 */
export default function HeaderSubscribeButton({ placement = 'header' }: { placement?: 'header' | 'footer' }) {
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState('');
  const { loading: authLoading, isAuthenticated } = useAuth();
  const { status, errorMessage, submit, isSubscribed, market } = useFormspreeCapture({
    userGroup: 'main-site-subscriber',
    source: placement === 'header' ? 'header' : 'footer_link',
  });
  const marketLabel = labelFor(market);
  // Signed-out success shows the account nudge; keep the modal open so it can be clicked.
  const showsNudge = featureFlags.userAccounts && !isAuthenticated;

  // Auto-close on success, unless the account nudge is showing
  useEffect(() => {
    if ((status === 'success' || status === 'already_subscribed') && !showsNudge) {
      const timer = setTimeout(() => setIsOpen(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [status, showsNudge]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await submit(email);
    if (ok) setEmail('');
  }, [email, submit]);

  if (!isOpen) {
    if (placement === 'header') {
      // Signed-in visitors are already on the list (auto-subscribe on sign-in).
      if (isSubscribed || isAuthenticated || (featureFlags.userAccounts && authLoading)) return null;
    } else if (isSubscribed) {
      // Only this market's flag: sign-in joins the Broadway list, so a
      // signed-in visitor on a West End page may not be on that list.
      return <span>{EMAIL_LIST_COPY.joinedShort}</span>;
    }
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="ml-1 px-3 py-1.5 text-sm font-semibold text-white bg-brand hover:bg-brand-hover rounded-lg transition-colors whitespace-nowrap"
      >
        {EMAIL_LIST_COPY.cta}
      </button>

      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} zIndex={70} maxWidth="sm" ariaLabel={`${EMAIL_LIST_COPY.cta}: ${marketLabel}`}>
        <div className="p-6">
          <ModalCloseButton onClick={() => setIsOpen(false)} className="absolute top-4 right-4" />

          {status === 'success' || status === 'already_subscribed' ? (
              <div className="text-center py-4">
                <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-400/10 flex items-center justify-center">
                  <svg className="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-white font-semibold">{EMAIL_LIST_COPY.successTitle}</p>
                <p className="text-sm text-gray-400 mt-1">{EMAIL_LIST_COPY.promise(market)}</p>
                <CreateAccountNudge source="newsletter_success" className="mt-5 pt-5 border-t border-white/10" />
              </div>
            ) : (
              <>
                <h2 className="text-lg font-bold text-white">{EMAIL_LIST_COPY.heading(market)}</h2>
                <p className="text-sm text-gray-400 mt-1 mb-4">{EMAIL_LIST_COPY.promise(market)}</p>

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
                    {status === 'submitting' ? 'Sending...' : EMAIL_LIST_COPY.cta}
                  </button>
                </form>

                {status === 'error' && errorMessage && (
                  <p className="mt-2 text-xs text-red-400 text-center">{errorMessage}</p>
                )}
              </>
            )}
        </div>
      </Modal>
    </>
  );
}
