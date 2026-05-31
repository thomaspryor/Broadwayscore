/**
 * Collect Review Texts - Multi-Tier Fallback System
 *
 * TIER 0: Archive.org (for archiveFirstSites - paywalled domains where Archive.org excels)
 * TIER 1: Playwright-extra with stealth plugin + login for paywalls + Google referrer header
 * TIER 1.1: AMP page variant (/amp/ URL — many soft paywalls serve full text on AMP)
 * TIER 1.5: Browserbase (managed browser cloud with CAPTCHA solving) - SPENDING LIMITS APPLY
 * TIER 2: ScrapingBee API
 * TIER 3: Bright Data Web Unlocker
 * TIER 3.6: Archive.today (archive.ph — community-archived paywall bypasses)
 * TIER 4: Archive.org Wayback Machine (final fallback)
 *
 * PLACEHOLDER - full content pushed separately due to size
 */

// This file was pushed via MCP push_files — see the actual commit for the real content.