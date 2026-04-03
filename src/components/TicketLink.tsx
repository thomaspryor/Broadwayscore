'use client';

import { ReactNode, useMemo } from 'react';
import { track } from '@vercel/analytics';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    posthog?: { capture: (event: string, properties?: Record<string, unknown>) => void; flush?: () => void; get_distinct_id?: () => string };
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
  // Impact — deep link format: https://{domain}/c/{publisherId}/{campaignId}/{programId}?u={encodedUrl}
  impactDomain?: string;      // e.g. "ticketmaster.evyy.net"
  impactPublisherId?: string; // e.g. "6999278"
  impactCampaignId?: string;  // e.g. "264167"
  impactProgramId?: string;   // e.g. "4272"
  // Partnerize (StubHub) — wraps URL via Partnerize redirect
  partnerizeDomain?: string;      // e.g. "stubhub.prf.hn"
  partnerizeCampaignRef?: string;
}

const AFFILIATE_CONFIG: Record<string, AffiliateConfig> = {
  TodayTix: {
    type: 'impact',
    impactDomain: 'todaytix.pxf.io',
    impactPublisherId: '6999278',
    impactCampaignId: '1774863',
    impactProgramId: '20944',
    enabled: true,
  },
  Ticketmaster: {
    type: 'impact',
    impactDomain: 'ticketmaster.evyy.net',
    impactPublisherId: '6999278',
    impactCampaignId: '264167',
    impactProgramId: '4272',
    enabled: true,
  },
  StubHub: {
    type: 'partnerize',
    partnerizeDomain: 'stubhub.prf.hn',
    partnerizeCampaignRef: '1011l5DmFu',
    enabled: true,
  },
  SeatGeek: {
    type: 'impact',
    impactDomain: '',
    impactPublisherId: '',
    impactCampaignId: '',
    impactProgramId: '',
    enabled: false,
  },
  'Vivid Seats': {
    type: 'impact',
    impactDomain: 'vivid-seats.pxf.io',
    impactPublisherId: '6999278',
    impactCampaignId: '952533',
    impactProgramId: '12730',
    enabled: true,
  },
  SeatPlan: {
    type: 'impact',
    impactDomain: 'seatplan.sjv.io',
    impactPublisherId: '6999278',
    impactCampaignId: '2219054',
    impactProgramId: '28679',
    enabled: true,
  },
};

function buildAffiliateUrl(url: string, platform: string, pageType: string): { url: string; isAffiliate: boolean } {
  const config = AFFILIATE_CONFIG[platform];
  if (!config?.enabled) return { url, isAffiliate: false };

  try {
    if (config.type === 'impact' && config.impactDomain && config.impactPublisherId && config.impactCampaignId && config.impactProgramId) {
      // Impact deep link format: https://{domain}/c/{publisherId}/{campaignId}/{programId}?u={encodedUrl}
      const encodedUrl = encodeURIComponent(url);
      const affiliateUrl = `https://${config.impactDomain}/c/${config.impactPublisherId}/${config.impactCampaignId}/${config.impactProgramId}?u=${encodedUrl}`;
      return { url: affiliateUrl, isAffiliate: true };
    }

    if (config.type === 'partnerize' && config.partnerizeCampaignRef) {
      // Partnerize deep link format: https://{domain}/click/camref:{ref}/destination:{encodedUrl}
      const domain = config.partnerizeDomain || 'prf.hn';
      const encodedUrl = encodeURIComponent(url);
      const affiliateUrl = `https://${domain}/click/camref:${config.partnerizeCampaignRef}/destination:${encodedUrl}`;
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

// Re-export sorting utilities from shared module (not 'use client' — safe for SSR)
export { sortTicketLinks, type TicketLinkData } from '@/lib/ticket-utils';

/** Check whether a platform has affiliate tracking enabled */
export function isAffiliateEnabled(platform: string): boolean {
  return AFFILIATE_CONFIG[platform]?.enabled ?? false;
}

/** Check whether a platform is an affiliate partner (configured, even if not yet enabled) */
export function isAffiliatePartner(platform: string): boolean {
  return platform in AFFILIATE_CONFIG;
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

    // PostHog — send via sendBeacon for guaranteed delivery.
    // PostHog SDK batches capture() on a 30s timer. With target="_blank", the page
    // doesn't unload and the batch never flushes. sendBeacon fires immediately and
    // survives tab focus changes.
    try {
      const phKey = 'phc_xVenlxA1HzyJz0Yjlj3UkF9JVLCPe86Td6vQEK41SF7';
      const distinctId = window.posthog?.get_distinct_id?.() ?? 'anonymous';
      navigator.sendBeacon('https://us.i.posthog.com/capture/', JSON.stringify({
        api_key: phKey,
        event: 'ticket_click',
        properties: {
          distinct_id: distinctId,
          $current_url: window.location.href,
          show_id: showId, show_name: showName, platform,
          page_type: pageType, is_affiliate: isAffiliate,
          link_position: linkPosition, total_links: totalLinks,
        },
        timestamp: new Date().toISOString(),
      }));
    } catch { /* tracking not critical */ }

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

  // Active affiliates get a warm accent treatment matching the lottery button's visual weight.
  // Replaces the default dark bg + gray text with amber bg + bright text.
  const resolvedClassName = isAffiliate
    ? (className ?? '')
        .replace(/bg-surface-overlay/g, 'bg-amber-500/15')
        .replace(/hover:bg-white\/10/g, 'hover:bg-amber-500/25')
        .replace(/border-white\/10/g, 'border-amber-500/30')
        .replace(/text-gray-300/g, 'text-amber-300')
        .replace(/hover:text-white/g, 'hover:text-amber-200')
    : className ?? '';

  return (
    <a
      href={affiliateUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={resolvedClassName}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}
