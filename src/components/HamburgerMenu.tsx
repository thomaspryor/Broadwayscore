'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { featureFlags } from '@/config/feature-flags';
import type { SignInOptions } from '@/contexts/AuthContext';
import { trackUgc } from '@/lib/ugc-analytics';
import { useLocalWatchlist } from '@/hooks/useLocalWatchlist';
import type { UserProfile } from '@/types/user';

interface HamburgerMenuProps {
  isAuthenticated?: boolean;
  /** Auth still resolving: don't show signed-out-only hints yet. */
  authLoading?: boolean;
  profile?: UserProfile | null;
  email?: string;
  /** 'watchlist_local' when the visitor has shows saved on this device. */
  onSignIn?: (context: 'generic' | 'watchlist_local', options?: SignInOptions) => void;
  onSignOut?: () => void;
  onDeleteAccount?: () => void;
}

export default function HamburgerMenu({
  isAuthenticated = false,
  authLoading = false,
  profile = null,
  email,
  onSignIn,
  onSignOut,
  onDeleteAccount,
}: HamburgerMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { localList } = useLocalWatchlist();
  // Phones have no sign-in button in the header (no room), so a signed-out
  // visitor gets a small gold dot on the menu icon until they open the menu
  // once (BRO-4616). Read after mount: storage isn't available during SSG.
  const [showDot, setShowDot] = useState(false);
  useEffect(() => {
    if (!featureFlags.userAccounts || isAuthenticated || authLoading) { setShowDot(false); return; }
    try { setShowDot(localStorage.getItem(MENU_SEEN_KEY) !== '1'); } catch { setShowDot(false); }
  }, [isAuthenticated, authLoading]);

  const open = useCallback(() => {
    setIsOpen(true);
    if (!isAuthenticated && !authLoading && featureFlags.userAccounts) {
      trackUgc('menu_opened', { signed_in: false, had_dot: showDot, local_count: localList.length });
      try { localStorage.setItem(MENU_SEEN_KEY, '1'); } catch { /* storage unavailable */ }
      setShowDot(false);
    }
  }, [isAuthenticated, authLoading, showDot, localList.length]);

  const triggerRef = useRef<HTMLButtonElement>(null);
  // Every way out (Escape, backdrop, close button, a menu item) parks focus
  // on the trigger before the panel unmounts, so keyboard users don't land
  // on <body>.
  const close = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  // For items that open a modal (sign in, delete account): close first so
  // the modal captures the trigger as its return target and Cancel goes
  // back there.
  const closeInto = (action?: () => void) => {
    close();
    action?.();
  };

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, close]);

  return (
    <>
      {/* Hamburger trigger button. On phones a signed-in user sees their
          avatar here instead of the lines — the standalone header avatar is
          desktop-only (three 44px targets don't fit a phone header; owner
          report, 2026-07-17). The menu carries My Shows / Sign in either way. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={open}
        className="relative p-1.5 sm:p-2 shrink-0 flex items-center justify-center text-gray-400 hover:text-white transition-colors"
        aria-label="Open menu"
        aria-expanded={isOpen}
      >
        {isAuthenticated && (
          profile?.avatar_url ? (
            <img
              src={profile.avatar_url}
              alt=""
              className="sm:hidden w-7 h-7 rounded-full border border-white/20"
            />
          ) : (
            <span className="ph-mask sm:hidden w-7 h-7 rounded-full bg-brand/20 flex items-center justify-center text-brand font-bold text-xs">
              {(profile?.display_name || email || '?').charAt(0).toUpperCase()}
            </span>
          )
        )}
        <svg className={`w-5 h-5 ${isAuthenticated ? 'hidden sm:block' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        {showDot && (
          <span
            data-testid="menu-account-dot"
            aria-hidden="true"
            className="sm:hidden absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-brand ring-2 ring-surface"
          />
        )}
      </button>

      {/* Overlay + slide-in panel */}
      {isOpen && (
        <div className="fixed inset-0 z-[70]">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={close}
          />

          {/* Panel */}
          <div className="absolute right-0 top-0 bottom-0 w-72 bg-[#141418] border-l border-white/10 shadow-2xl animate-in slide-in-from-right duration-200 overflow-y-auto">
            {/* Close button */}
            <div className="flex justify-end p-4">
              <button
                type="button"
                onClick={close}
                className="text-gray-500 hover:text-white transition-colors"
                aria-label="Close menu"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* User section */}
            {featureFlags.userAccounts && (
              <div className="px-5 pb-4 border-b border-white/[0.06]">
                {isAuthenticated ? (
                  <div className="flex items-center gap-3">
                    {profile?.avatar_url ? (
                      <img
                        src={profile.avatar_url}
                        alt=""
                        className="w-10 h-10 rounded-full border border-white/10"
                      />
                    ) : (
                      <div className="ph-mask w-10 h-10 rounded-full bg-brand/20 flex items-center justify-center text-brand font-bold text-sm">
                        {(profile?.display_name || email || '?').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="ph-mask text-sm font-semibold text-white truncate">{profile?.display_name || email || 'Signed In'}</p>
                    </div>
                  </div>
                ) : (
                  // Signed out: say what an account is for, then one tap to
                  // sign in (BRO-4616). The bare "Sign In" button got zero
                  // phone taps on launch day.
                  <div data-testid="menu-account-card" className="rounded-xl border border-brand/30 bg-brand/[0.08] p-4">
                    <p className="flex items-center gap-2 text-sm font-bold text-white">
                      <span className="text-base" aria-hidden="true">🎭</span> My Shows
                    </p>
                    <ul className="mt-2 space-y-1 text-xs text-gray-400">
                      <li>Rate the shows you&apos;ve seen</li>
                      <li>Keep a watchlist of what&apos;s next</li>
                      <li>Build and share ranked lists</li>
                    </ul>
                    {localList.length > 0 && (
                      <p className="mt-2 text-xs font-semibold text-brand">
                        {localList.length === 1 ? '1 show' : `${localList.length} shows`} saved on this device
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        // Land on My Shows afterwards. Asked for through the
                        // sign-in flow, which saves the return page itself
                        // (saving the return page here directly was overwritten, BRO-4894).
                        closeInto(() => onSignIn?.(localList.length > 0 ? 'watchlist_local' : 'generic', { returnTo: '/my-shows' }));
                      }}
                      className="mt-3 w-full flex items-center justify-center px-4 py-2.5 text-sm font-semibold text-surface bg-brand rounded-lg hover:bg-brand-hover transition-colors"
                    >
                      {localList.length > 0 ? 'Sign in to keep them' : 'Sign in · free'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Navigation links */}
            <nav className="py-3">
              {/* Authenticated-only links */}
              {featureFlags.userAccounts && isAuthenticated && (
                <div className="pb-3 mb-3 border-b border-white/[0.06]">
                  <MenuLink href="/my-shows" onClick={close} icon="🎭">
                    My Shows
                  </MenuLink>
                </div>
              )}

              {/* General links */}
              <MenuLink href="/about" onClick={close}>About</MenuLink>
              <MenuLink href="/methodology" onClick={close}>How It Works</MenuLink>
              <MenuLink href="/feedback" onClick={close}>Feedback</MenuLink>
              <MenuLink href="/reviews" onClick={close}>Reviews</MenuLink>
              <MenuLink href="/guides" onClick={close}>Guides</MenuLink>

              {/* Sign out */}
              {featureFlags.userAccounts && isAuthenticated && (
                <div className="pt-3 mt-3 border-t border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      onSignOut?.();
                    }}
                    className="w-full text-left px-5 py-2.5 text-sm text-gray-400 hover:text-red-400 hover:bg-white/[0.02] transition-colors"
                  >
                    Sign Out
                  </button>
                  {onDeleteAccount && (
                    <button
                      type="button"
                      onClick={() => closeInto(onDeleteAccount)}
                      className="w-full text-left px-5 py-2.5 text-sm text-gray-400 hover:text-score-skip hover:bg-white/[0.02] transition-colors"
                    >
                      Delete account
                    </button>
                  )}
                </div>
              )}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}

const MENU_SEEN_KEY = 'bsc_menu_seen';

function MenuLink({
  href,
  onClick,
  icon,
  children,
}: {
  href: string;
  onClick: () => void;
  icon?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-2.5 px-5 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.03] transition-colors"
    >
      {icon && <span className="text-base">{icon}</span>}
      {children}
    </Link>
  );
}
