'use client';

import { ReactNode, useMemo } from 'react';
import { track } from '@vercel/analytics';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    posthog?: { capture: (event: string, properties?: Record<string, unknown>) => void };
  }
}

// ─── Affiliate configuration ─────────────────────────────
// Each platform can use a different affiliate network.
// Flip `enabled` to true as each approval comes through.

type AffiliateType = 'utm' | 'impact' | 'partnerize';

interface AffiliateConfig {
  type: AffiliateType;
  enabled: boolean;
  // UTM-based (simple param append)
  params?: Record<string, string>;
  // Impact (TodayTix, Ticketmaster) — wraps URL via Impact tracking domain
  impactDomain?: string;     // e.g. "todaytix.pxf.io"
  impactPublisherId?: string;
  impactCampaignId?: string;
  // Partnerize (StubHub) — wraps URL via Partnerize redirect
  partnerizeCampaignRef?: string;
}

const AFFILIATE_CONFIG: Record<string, AffiliateConfig> = {
  TodayTix: {
    type: 'impact',
    // Once approved on Impact: fill in these three values and set enabled: true
    impactDomain: '',       // e.g. "todaytix.pxf.io"
    impactPublisherId: '',  // your Impact publisher ID
    impactCampaignId: '',   // TodayTix campaign ID from Impact dashboard
    enabled: false,
  },
  Ticketmaster: {
    type: 'impact',
    impactDomain: '',
    impactPublisherId: '',
    impactCampaignId: '',
    enabled: false,
  },
  StubHub: {
    type: 'partnerize',
    partnerizeCampaignRef: '', // from Partnerize dashboard after StubHub approval
    enabled: false,
  },
  SeatGeek: {
    type: 'impact',
    impactDomain: '',
    impactPublisherId: '',
    impactCampaignId: '',
    enabled: false,
  },
};

function buildAffiliateUrl(url: string, platform: string, pageType: string): { url: string; isAffiliate: boolean } {
  const config = AFFILIATE_CONFIG[platform];
  if (!config?.enabled) return { url, isAffiliate: false };

  try {
    if (config.type === 'impact' && config.impactDomain && config.impactPublisherId && config.impactCampaignId) {
      // Impact deep link format: https://{domain}/click/camref:{campaignId}/pubref:{publisherId}/destination:{encodedUrl}
      const encodedUrl = encodeURIComponent(url);
      const affiliateUrl = `https://${config.impactDomain}/click/camref:${config.impactCampaignId}/pubref:${config.impactPublisherId}/destination:${encodedUrl}`;
      return { url: affiliateUrl, isAffiliate: true };
    }

    if (config.type === 'partnerize' && config.partnerizeCampaignRef) {
      // Partnerize deep link format: https://prf.hn/click/camref:{ref}/destination:{encodedUrl}
      const encodedUrl = encodeURIComponent(url);
      const affiliateUrl = `https://prf.hn/click/camref:${config.partnerizeCampaignRef}/destination:${encodedUrl}`;
      return { url: affiliateUrl, isAffiliate: true };
    }

    if (config.type === 'utm' && config.params) {
      const parsed = new URL(url);
      for (const [key, value] of Object.entries(config.params)) {
        if (!parsed.searchParams.has(key)) {
          parsed.searchParams.set(key, value);
        }
      }
      parsed.searchParams.set('utm_content', pageType);
      return { url: parsed.toString(), isAffiliate: true };
    }

    return { url, isAffiliate: false };
  } catch {
    return { url, isAffiliate: false };
  }
}

// ─── Ticket link sorting ────────────────────────────────
// Priority order for ticket platforms. Lower number = shown first.
// Affiliate-enabled platforms get priority to maximize revenue.
const TICKET_PLATFORM_PRIORITY: Record<string, number> = {
  TodayTix: 1,
  Telecharge: 2,
  Ticketmaster: 2,
  StubHub: 3,
  SeatGeek: 3,
};

export interface TicketLinkData {
  platform: string;
  url: string;
  priceFrom?: number | null;
  isOfficial?: boolean;
}

/** Sort ticket links by platform priority. Stable sort preserves shows.json order for equal priority. */
export function sortTicketLinks(links: TicketLinkData[]): TicketLinkData[] {
  return [...links].sort((a, b) => {
    return (TICKET_PLATFORM_PRIORITY[a.platform] ?? 99) - (TICKET_PLATFORM_PRIORITY[b.platform] ?? 99);
  });
}

/** Check whether a platform has affiliate tracking enabled */
export function isAffiliateEnabled(platform: string): boolean {
  return AFFILIATE_CONFIG[platform]?.enabled ?? false;
}

// ─── Component ───────────────────────────────────────────

interface TicketLinkProps {
  showName: string;
  showId: string;
  showSlug?: string;
  showStatus?: string;
  showCategory?: string;
  showScore?: number | null;
  platform: string;
  url: string;
  pageType: 'show' | 'guide' | 'browse' | 'comparison' | 'showtimes';
  linkPosition?: number;
  totalLinks?: number;
  className?: string;
  children: ReactNode;
}

export default function TicketLink({
  showName, showId, showSlug, showStatus, showCategory, showScore,
  platform, url, pageType,
  linkPosition = 0, totalLinks = 1,
  className, children,
}: TicketLinkProps) {
  const { url: affiliateUrl, isAffiliate } = useMemo(
    () => buildAffiliateUrl(url, platform, pageType),
    [url, platform, pageType],
  );

  const handleClick = () => {
    if (typeof window === 'undefined') return;

    // Vercel Analytics
    track('ticket_click', { show_id: showId, platform, page_type: pageType, is_affiliate: isAffiliate });

    // PostHog — native event with full context (not just autocapture)
    if (window.posthog?.capture) {
      window.posthog.capture('ticket_click', {
        show_id: showId,
        show_name: showName,
        platform,
        page_type: pageType,
        is_affiliate: isAffiliate,
        link_position: linkPosition,
        total_links: totalLinks,
      });
    }

    if (typeof window.gtag !== 'function') return;

    // Primary click event — enriched with full attribution context
    window.gtag('event', 'ticket_link_click', {
      show_name: showName,
      show_id: showId,
      show_slug: showSlug ?? '',
      show_status: showStatus ?? '',
      show_category: showCategory ?? '',
      show_score: showScore ?? null,
      platform,
      ticket_url: url,
      affiliate_url: affiliateUrl,
      is_affiliate: isAffiliate,
      page_type: pageType,
      link_position: linkPosition,
      total_links: totalLinks,
    });

    // Separate affiliate-specific event for easy GA4 filtering / conversion setup
    if (isAffiliate) {
      window.gtag('event', 'affiliate_click', {
        show_name: showName,
        show_id: showId,
        platform,
        affiliate_url: affiliateUrl,
        page_type: pageType,
      });
    }
  };

  return (
    <a
      href={affiliateUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}
