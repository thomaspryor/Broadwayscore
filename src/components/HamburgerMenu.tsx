'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { featureFlags } from '@/config/feature-flags';
import { saveReturnUrl } from '@/lib/deferred-auth';
import type { UserProfile } from '@/types/user';

interface HamburgerMenuProps {
  isAuthenticated?: boolean;
  profile?: UserProfile | null;
  email?: string;
  onSignIn?: () => void;
  onSignOut?: () => void;
}

export default function HamburgerMenu({
  isAuthenticated = false,
  profile = null,
  email,
  onSignIn,
  onSignOut,
}: HamburgerMenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  const close = useCallback(() => setIsOpen(false), []);

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
        type="button"
        onClick={() => setIsOpen(true)}
        className="p-1.5 sm:p-2 shrink-0 flex items-center justify-center text-gray-400 hover:text-white transition-colors"
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
            <span className="sm:hidden w-7 h-7 rounded-full bg-brand/20 flex items-center justify-center text-brand font-bold text-xs">
              {(profile?.display_name || email || '?').charAt(0).toUpperCase()}
            </span>
          )
        )}
        <svg className={`w-5 h-5 ${isAuthenticated ? 'hidden sm:block' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
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
                      <div className="w-10 h-10 rounded-full bg-brand/20 flex items-center justify-center text-brand font-bold text-sm">
                        {(profile?.display_name || email || '?').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{profile?.display_name || email || 'Signed In'}</p>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      saveReturnUrl('/my-shows');
                      close();
                      onSignIn?.();
                    }}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-brand/20 border border-brand/30 rounded-lg hover:bg-brand/30 transition-colors"
                  >
                    Sign In
                  </button>
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
                </div>
              )}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}

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
