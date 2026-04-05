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

export const AFFILIATE_CONFIG: Record<string, AffiliateConfig> = {
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

export function buildAffiliateUrl(url: string, platform: string, pageType: string): { url: string; isAffiliate: boolean } {
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

/** Check whether a platform has affiliate tracking enabled */
export function isAffiliateEnabled(platform: string): boolean {
  return AFFILIATE_CONFIG[platform]?.enabled ?? false;
}

/** Check whether a platform is an affiliate partner (configured, even if not yet enabled) */
export function isAffiliatePartner(platform: string): boolean {
  return platform in AFFILIATE_CONFIG;
}
