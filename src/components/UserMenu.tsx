'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';

export default function UserMenu() {
  const { user, profile, loading, signInWithGoogle, signOut } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close dropdown on Escape key
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Loading: render nothing to avoid flash
  if (loading) {
    return <></>;
  }

  // Logged out: show Sign In button
  if (!user) {
    return (
      <button
        onClick={signInWithGoogle}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        Sign In
      </button>
    );
  }

  // Logged in: show avatar with dropdown
  const displayLetter = (
    profile?.username?.[0] ||
    profile?.display_name?.[0] ||
    user.email?.[0] ||
    '?'
  ).toUpperCase();

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand text-sm font-medium transition-colors hover:bg-brand/30"
        aria-label="User menu"
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        {displayLetter}
      </button>

      {/* Dropdown */}
      <div
        className={`absolute right-0 top-full mt-2 w-48 bg-surface-raised border border-white/10 rounded-xl shadow-lg overflow-hidden z-50 transition-opacity duration-150 ${
          isOpen
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none'
        }`}
        role="menu"
      >
        <Link
          href="/my-scorecard"
          onClick={() => setIsOpen(false)}
          className="block px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors"
          role="menuitem"
        >
          My Scorecard
        </Link>
        <div className="border-t border-white/10" />
        <button
          onClick={() => {
            setIsOpen(false);
            signOut();
          }}
          className="w-full text-left px-4 py-3 text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          role="menuitem"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}
