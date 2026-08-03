// ─── Affiliate configuration ─────────────────────────────
// src/config/affiliate-platforms.json is the single source of truth, shared
// with scripts/lib/affiliate-stats.js (revenue reporting) and
// scripts/verify-affiliate-links.js (link integrity probe). Edit the JSON,
// not this file, when a platform's IDs or enabled state change.
import affiliatePlatforms from '@/config/affiliate-platforms.json';

type AffiliateType = 'utm' | 'impact' | 'partnerize';

interface AffiliateConfig {
  type: AffiliateType;
  enabled: boolean;
  /** Counts as an affiliate row in revenue reports even when link rendering is off (StubHub history). */
  revenueReporting?: boolean;
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

export const AFFILIATE_CONFIG: Record<string, AffiliateConfig> =
  affiliatePlatforms.platforms as Record<string, AffiliateConfig>;

/**
 * Optional click-time tracking forwarded to Impact via subId1/subId2.
 * Impact echoes these back on each conversion record (Actions API) so
 * analyze-ab-test.js can join conversions to PostHog clicks per-user
 * (subId1 = distinct_id) and per-variant (subId2 = ab_variant string).
 */
export interface AffiliateTracking {
  distinctId?: string;
  abVariant?: string;
}

export function buildAffiliateUrl(
  url: string,
  platform: string,
  pageType: string,
  tracking?: AffiliateTracking,
): { url: string; isAffiliate: boolean } {
  const config = AFFILIATE_CONFIG[platform];
  if (!config?.enabled) return { url, isAffiliate: false };

  try {
    if (config.type === 'impact' && config.impactDomain && config.impactPublisherId && config.impactCampaignId && config.impactProgramId) {
      // Impact deep link format: https://{domain}/c/{publisherId}/{campaignId}/{programId}?u={encodedUrl}
      const encodedUrl = encodeURIComponent(url);
      const subParams: string[] = [];
      if (tracking?.distinctId) subParams.push(`subId1=${encodeURIComponent(tracking.distinctId)}`);
      if (tracking?.abVariant) subParams.push(`subId2=${encodeURIComponent(tracking.abVariant)}`);
      const subSuffix = subParams.length ? `&${subParams.join('&')}` : '';
      const affiliateUrl = `https://${config.impactDomain}/c/${config.impactPublisherId}/${config.impactCampaignId}/${config.impactProgramId}?u=${encodedUrl}${subSuffix}`;
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

/**
 * rel attribute for a ticket/lottery/rush <a> tag. Affiliate links (Impact,
 * Partnerize, UTM-tracked) need sponsored+nofollow so crawlers don't follow
 * them and inflate Impact click counts / trip Google's paid-link policy.
 */
export function affiliateRel(isAffiliate: boolean): string {
  return isAffiliate ? 'sponsored nofollow noopener noreferrer' : 'noopener noreferrer';
}

/** Check whether a platform has affiliate tracking enabled */
export function isAffiliateEnabled(platform: string): boolean {
  return AFFILIATE_CONFIG[platform]?.enabled ?? false;
}

/** Check whether a platform is an affiliate partner (configured, even if not yet enabled) */
export function isAffiliatePartner(platform: string): boolean {
  return platform in AFFILIATE_CONFIG;
}
