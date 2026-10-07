'use client';

import StarRating from '@/components/user/StarRating';
import WatchlistButton from '@/components/user/WatchlistButton';
import SignInModal from '@/components/auth/SignInModal';
import { useState } from 'react';

/**
 * Visual regression test fixture for UGC (User-Generated Content) components.
 * Renders real components with hardcoded mock data so screenshots are stable
 * regardless of auth state or live data changes. Only used by Playwright tests.
 */

export default function UGCFixturePage() {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-10">

        {/* ---- Star Ratings at different sizes & states ---- */}
        <section data-testid="star-ratings-section">
          <h2 className="text-lg font-bold text-white mb-4">Star Ratings</h2>
          <div className="space-y-4">
            {/* Empty */}
            <div data-testid="stars-empty">
              <span className="text-xs text-gray-500 mb-1 block">Empty (lg)</span>
              <StarRating rating={null} onRatingChange={() => {}} size="lg" />
            </div>
            {/* Full ratings */}
            <div data-testid="stars-full-5">
              <span className="text-xs text-gray-500 mb-1 block">5.0 stars (lg)</span>
              <StarRating rating={5} onRatingChange={() => {}} size="lg" readOnly />
            </div>
            <div data-testid="stars-half-3-5">
              <span className="text-xs text-gray-500 mb-1 block">3.5 stars (lg)</span>
              <StarRating rating={3.5} onRatingChange={() => {}} size="lg" readOnly />
            </div>
            <div data-testid="stars-low-1">
              <span className="text-xs text-gray-500 mb-1 block">1.0 star (lg)</span>
              <StarRating rating={1} onRatingChange={() => {}} size="lg" readOnly />
            </div>
            {/* Small size */}
            <div data-testid="stars-sm-4">
              <span className="text-xs text-gray-500 mb-1 block">4.0 stars (sm)</span>
              <StarRating rating={4} onRatingChange={() => {}} size="sm" readOnly />
            </div>
            {/* Medium with label hidden */}
            <div data-testid="stars-md-no-label">
              <span className="text-xs text-gray-500 mb-1 block">2.5 stars (md, no label)</span>
              <StarRating rating={2.5} onRatingChange={() => {}} size="md" readOnly hideLabel />
            </div>
          </div>
        </section>

        {/* ---- Watchlist Button states ---- */}
        <section data-testid="watchlist-buttons-section">
          <h2 className="text-lg font-bold text-white mb-4">Watchlist Button</h2>
          <div className="flex flex-wrap gap-4">
            <div data-testid="watchlist-off">
              <span className="text-xs text-gray-500 mb-1 block">Not watchlisted</span>
              <WatchlistButton isWatchlisted={false} onToggle={() => {}} />
            </div>
            <div data-testid="watchlist-on">
              <span className="text-xs text-gray-500 mb-1 block">Watchlisted</span>
              <WatchlistButton isWatchlisted={true} onToggle={() => {}} />
            </div>
            <div data-testid="watchlist-loading">
              <span className="text-xs text-gray-500 mb-1 block">Loading</span>
              <WatchlistButton isWatchlisted={false} onToggle={() => {}} loading={true} />
            </div>
          </div>
        </section>

        {/* ---- Show Page Rating section (full layout) ---- */}
        <section data-testid="show-page-rating-section">
          <h2 className="text-lg font-bold text-white mb-4">Show Page Rating Section</h2>

          {/* Simulate the rating section layout from ShowPageRating.tsx */}
          <div className="card p-5">
            <div className="mt-0 pt-5 border-t border-white/[0.06]">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Your Rating</h3>
                    <span className="text-[10px] font-medium text-gray-500 bg-white/[0.05] px-1.5 py-0.5 rounded">
                      Seen 3 times
                    </span>
                  </div>

                  {/* Existing rating with edit/new viewing */}
                  <div className="flex items-center gap-2" data-testid="existing-rating-row">
                    <StarRating rating={4.5} onRatingChange={() => {}} size="lg" readOnly />
                    <button
                      type="button"
                      className="p-1 text-gray-500 hover:text-white transition-colors"
                      aria-label="Edit rating"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                    <button type="button" className="text-xs text-gray-500 hover:text-brand transition-colors">
                      + New Viewing
                    </button>
                  </div>

                  {/* Previous viewings */}
                  <div className="mt-2 space-y-1" data-testid="previous-viewings">
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <StarRating rating={4} onRatingChange={() => {}} size="sm" readOnly hideLabel />
                      <span>Nov 15, 2024</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <StarRating rating={4.5} onRatingChange={() => {}} size="sm" readOnly hideLabel />
                      <span>Aug 3, 2024</span>
                    </div>
                  </div>

                  <a href="/my-shows" className="inline-block mt-2 text-xs text-gray-500 hover:text-brand transition-colors">
                    See all my Ratings &amp; Reviews
                  </a>
                </div>

                {/* Watchlist column */}
                <div className="flex-shrink-0 pt-5 flex flex-col items-center" data-testid="watchlist-column">
                  <WatchlistButton isWatchlisted={true} onToggle={() => {}} />
                  <span className="mt-1.5 flex items-center gap-1 text-[11px] text-gray-500">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <span>Mar 15</span>
                  </span>
                  <a href="/my-shows?tab=watchlist" className="mt-1 text-[11px] text-gray-500 hover:text-brand transition-colors">
                    See Watchlist
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---- Sign-In Modal trigger ---- */}
        <section data-testid="sign-in-section">
          <h2 className="text-lg font-bold text-white mb-4">Sign-In Modal</h2>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="px-4 py-2 bg-white/10 rounded-lg text-sm"
            data-testid="open-modal-btn"
          >
            Open Sign-In Modal
          </button>
        </section>

        {/* Sign-In Modal (rendered but closed by default, tests open it) */}
        <SignInModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSignIn={() => {}}
          context="rating"
        />

      </div>
    </div>
  );
}
