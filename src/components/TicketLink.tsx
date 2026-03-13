'use client';

import { ReactNode } from 'react';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

interface TicketLinkProps {
  showName: string;
  showId: string;
  platform: string;
  url: string;
  pageType: 'show' | 'guide';
  className?: string;
  children: ReactNode;
}

export default function TicketLink({ showName, showId, platform, url, pageType, className, children }: TicketLinkProps) {
  const handleClick = () => {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag('event', 'ticket_link_click', {
        show_name: showName,
        show_id: showId,
        platform,
        ticket_url: url,
        page_type: pageType,
      });
    }
  };

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}
