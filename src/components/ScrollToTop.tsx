'use client';

import { useState, useEffect, useCallback } from 'react';

export default function ScrollToTop() {
  const [isVisible, setIsVisible] = useState(false);

  const toggleVisibility = useCallback(() => {
    // Show button when page is scrolled down 400px
    setIsVisible(window.scrollY > 400);
  }, []);

  useEffect(() => {
    // Throttle scroll handler using requestAnimationFrame
    let ticking = false;
    const throttledScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          toggleVisibility();
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', throttledScroll, { passive: true });
    return () => window.removeEventListener('scroll', throttledScroll);
  }, [toggleVisibility]);

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  };

  if (!isVisible) return null;

  return (
    <button
      onClick={scrollToTop}
      type="button"
      aria-label="Scroll to top of page"
      className="fixed bottom-20 sm:bottom-6 right-4 sm:right-6 z-40 w-10 h-10 rounded-full bg-surface-raised border border-white/10 shadow-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-surface-overlay hover:border-white/20 transition-all duration-200 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 focus:ring-offset-surface"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
      </svg>
    </button>
  );
}
