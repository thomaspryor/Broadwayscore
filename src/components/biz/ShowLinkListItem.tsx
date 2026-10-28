'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { openRowLink } from '@/lib/row-click';

/** Widen a show link's mouse target while keeping the real link for keyboards. */
export default function ShowLinkListItem({ href, className = '', children }: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <li
      className={`group cursor-pointer hover:bg-white/5 transition-colors ${className}`}
      onClick={(e) => openRowLink(e, href, router.push)}
      onAuxClick={(e) => openRowLink(e, href, router.push)}
    >
      {children}
    </li>
  );
}
