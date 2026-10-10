'use client';

import Link from 'next/link';
import { useCurrentMarket } from '@/hooks/useCurrentMarket';

/**
 * Header secondary market link.
 * Shown on the right side of the header, next to search.
 *
 * - On NYC pages: links to /off-broadway
 * - On London pages (West End or Off-West End): links to /off-west-end
 * - On the Off-Broadway page itself: hidden (avoids self-link)
 * - On the Off-West End page itself: hidden
 */
export default function HeaderSecondaryMarketLink() {
  const market = useCurrentMarket();

  if (market === 'off-broadway' || market === 'off-west-end') {
    return null;
  }

  const isLondon = market === 'west-end';
  const href = isLondon ? '/off-west-end' : '/off-broadway';
  const label = isLondon ? 'Off-West End' : 'Off-Broadway';

  return (
    <Link
      href={href}
      className="hidden lg:block text-sm text-gray-400 hover:text-white transition-colors font-medium"
    >
      {label}
    </Link>
  );
}
