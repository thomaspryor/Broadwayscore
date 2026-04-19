'use client';

import Link from 'next/link';
import HeaderSubscribeButton from '@/components/HeaderSubscribeButton';
import { useCurrentMarket } from '@/hooks/useCurrentMarket';

export default function FooterBranding({ totalReviews }: { totalReviews: number }) {
  const marketId = useCurrentMarket();
  const isLondon = marketId === 'west-end' || marketId === 'off-west-end';
  const logoPrefix = isLondon ? 'West End' : 'Broadway';

  return (
    <>
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex items-center">
          <span className="text-lg font-bold text-white">{logoPrefix}</span>
          <span className={`text-lg font-bold ${isLondon ? 'bg-gradient-to-r from-pink-400 to-pink-500 bg-clip-text text-transparent' : 'text-gradient'}`}>Scorecard</span>
          <span className="text-[8px] text-gray-500 font-normal align-super">™</span>
        </div>
        <div className="flex flex-col sm:flex-row items-center gap-1 sm:gap-2 text-sm text-gray-400">
          <Link href="/about" className="hover:text-white transition-colors">About</Link>
          <span className="text-gray-500 hidden sm:inline">|</span>
          <Link href="/methodology" className="hover:text-white transition-colors">Methodology</Link>
          <span className="text-gray-500 hidden sm:inline">|</span>
          <a href="https://buymeacoffee.com/broadwayscorecard" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Buy Me a Coffee</a>
          <span className="text-gray-500 hidden sm:inline">|</span>
          <HeaderSubscribeButton />
          <span className="text-gray-500 hidden sm:inline">|</span>
          <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
          <span className="text-gray-500 hidden sm:inline">|</span>
          <span>Every show. Every review. One score.</span>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Aggregating <span className="text-gray-400 font-medium">{totalReviews.toLocaleString()}</span> critic reviews and counting...
        </p>
      </div>
      <div className="mt-4 pt-4 border-t border-white/5 text-center text-xs text-gray-500 space-y-1">
        <p>All ratings and reviews belong to their respective sources.</p>
        <p>Some ticket links are affiliate links. We may earn a commission at no extra cost to you.</p>
        <p>&copy; 2026 Broadway Scorecard™ LLC. All rights reserved.</p>
        <p>By using this site, you agree to our <Link href="/terms" className="text-gray-400 hover:text-white transition-colors underline underline-offset-2">Terms of Service</Link>.</p>
      </div>
    </>
  );
}
