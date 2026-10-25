// ─── Ticket link rendering config ──────────────────────────
// src/config/affiliate-platforms.json's "rendering" section is the single
// source of truth for platform sort priority and visibility (unified with
// the affiliate "platforms" section 2026-08-26 — see its _renderingComment
// for field semantics and each platform's hiddenReason for why it's hidden).
// Edit the JSON, not this file, when priority or hidden state change.
import affiliatePlatforms from '@/config/affiliate-platforms.json';

interface PlatformRenderingConfig {
  priority: number;
  hidden?: boolean;
  hiddenUnlessNoTodayTix?: boolean;
  hiddenReason?: string;
}

const RENDERING_CONFIG: Record<string, PlatformRenderingConfig> =
  affiliatePlatforms.rendering as Record<string, PlatformRenderingConfig>;

const HIDDEN_PLATFORMS: Set<string> = new Set(
  Object.entries(RENDERING_CONFIG).filter(([, cfg]) => cfg.hidden).map(([platform]) => platform)
);

const HIDDEN_UNLESS_NO_TODAYTIX: Set<string> = new Set(
  Object.entries(RENDERING_CONFIG).filter(([, cfg]) => cfg.hiddenUnlessNoTodayTix).map(([platform]) => platform)
);

export interface TicketLinkData {
  platform: string;
  url: string;
  priceFrom?: number | null;
  isOfficial?: boolean;
}

/**
 * Sort ticket links by platform priority, filtering out hidden platforms.
 * Stable sort preserves shows.json order for equal priority.
 * @param overrideFirstPlatform — A/B test override: force a specific platform to position 0.
 *   Only used by TicketButtonsAB on show pages. Other callers omit this param.
 */
/**
 * The single source of truth for which of a show's ticket links are visible.
 * Never leaves a show buttonless: the HIDDEN_PLATFORMS rationale above is
 * explicitly conditioned on "no official buy path is lost" (every hidden
 * link had a TodayTix/Official sibling). When hiding would remove a show's
 * ONLY link (e.g. Les Mis Arena Concert at Radio City — Ticketmaster is the
 * sole seller), the affiliate-consolidation logic doesn't apply and the
 * best hidden link renders instead. StubHub stays hidden even here —
 * resale-only is worse than no button.
 *
 * Every caller that decides visibility from ticket links MUST use this (or
 * sortTicketLinks, which wraps it) — a bare isPlatformHidden() filter answers
 * a different question and drifts from what the show page actually renders
 * (the exact class behind the Les Mis zero-button incident).
 */
export function getVisibleTicketLinks(links: TicketLinkData[]): TicketLinkData[] {
  const hasTodayTix = links.some(l => l.platform === 'TodayTix');
  const effectiveHidden = hasTodayTix
    ? HIDDEN_PLATFORMS
    : new Set(Array.from(HIDDEN_PLATFORMS).filter(p => !HIDDEN_UNLESS_NO_TODAYTIX.has(p)));
  const visible = links.filter(l => !effectiveHidden.has(l.platform));
  return visible.length > 0 ? visible : links.filter(l => l.platform !== 'StubHub');
}

export function sortTicketLinks(links: TicketLinkData[], overrideFirstPlatform?: string): TicketLinkData[] {
  return [...getVisibleTicketLinks(links)]
    .sort((a, b) => {
      if (overrideFirstPlatform) {
        if (a.platform === overrideFirstPlatform && b.platform !== overrideFirstPlatform) return -1;
        if (b.platform === overrideFirstPlatform && a.platform !== overrideFirstPlatform) return 1;
      }
      return (RENDERING_CONFIG[a.platform]?.priority ?? 99) - (RENDERING_CONFIG[b.platform]?.priority ?? 99);
    });
}

/**
 * Is this platform hidden by DEFAULT (i.e. when a show also carries TodayTix)?
 * Ticketmaster's real hidden status is link-set-dependent — see
 * getVisibleTicketLinks — so this answers "hidden in the common case," not
 * "hidden on every show." Exposed for analytics/debug only; nothing in this
 * repo calls it as of 2026-08-03. Prefer getVisibleTicketLinks/sortTicketLinks
 * for anything that decides real per-show visibility.
 */
export function isPlatformHidden(platform: string): boolean {
  return HIDDEN_PLATFORMS.has(platform);
}
