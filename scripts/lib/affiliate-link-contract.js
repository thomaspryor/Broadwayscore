'use strict';

/**
 * affiliate-link-contract.js — parse + validate rendered affiliate links
 * against src/config/affiliate-platforms.json (the single source of truth).
 *
 * Affiliate hardening plan 2026-08-03. This is a PARSER, deliberately not a
 * builder: the builder lives in src/lib/affiliate-utils.ts (TypeScript, used
 * by the site), and duplicating it here in JS would recreate the exact
 * two-copies-drift bug the shared JSON config just killed. Instead the probe
 * (scripts/verify-affiliate-links.js) validates what the TS builder actually
 * RENDERED on production pages against this contract, which closes the loop
 * on the real output rather than a parallel implementation.
 *
 * Pure functions, no I/O — unit-tested in affiliate-link-contract.test.mjs.
 */

const PLATFORMS = require('../../src/config/affiliate-platforms.json').platforms;
const RENDERING = require('../../src/config/affiliate-platforms.json').rendering;

/**
 * Parse an Impact deep link:
 *   https://{domain}/c/{publisherId}/{campaignId}/{programId}?u={encodedDest}&subId1=..&subId2=..
 * @returns {null|{domain:string, publisherId:string, campaignId:string,
 *   programId:string, destination:string|null, subId1:string|null, subId2:string|null}}
 */
function parseImpactLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const m = parsed.pathname.match(/^\/c\/(\d+)\/(\d+)\/(\d+)\/?$/);
  if (!m) return null;
  const rawDest = parsed.searchParams.get('u');
  let destination = null;
  if (rawDest) {
    // searchParams already decodes once; the builder encodeURIComponent()s the
    // destination exactly once, so this is the original URL.
    destination = rawDest;
  }
  return {
    domain: parsed.hostname,
    publisherId: m[1],
    campaignId: m[2],
    programId: m[3],
    destination,
    subId1: parsed.searchParams.get('subId1'),
    subId2: parsed.searchParams.get('subId2'),
  };
}

/**
 * Validate a rendered Impact link against a platform's configured identity.
 * @param {string} url rendered affiliate link
 * @param {string} platformName key in affiliate-platforms.json (e.g. 'TodayTix')
 * @param {object} [platforms] config override for tests
 * @returns {{ok:boolean, problems:Array<string>, parsed:object|null}}
 */
function validateImpactLink(url, platformName, platforms = PLATFORMS) {
  const cfg = platforms[platformName];
  const problems = [];
  if (!cfg) return { ok: false, problems: [`unknown platform "${platformName}"`], parsed: null };
  if (cfg.type !== 'impact') {
    return { ok: false, problems: [`platform "${platformName}" is type ${cfg.type}, not impact`], parsed: null };
  }
  const parsed = parseImpactLink(url);
  if (!parsed) return { ok: false, problems: [`not a parseable Impact deep link: ${url}`], parsed: null };

  if (parsed.domain !== cfg.impactDomain) {
    problems.push(`domain ${parsed.domain} != configured ${cfg.impactDomain}`);
  }
  if (parsed.publisherId !== cfg.impactPublisherId) {
    problems.push(`publisherId ${parsed.publisherId} != configured ${cfg.impactPublisherId}`);
  }
  if (parsed.campaignId !== cfg.impactCampaignId) {
    problems.push(`campaignId ${parsed.campaignId} != configured ${cfg.impactCampaignId}`);
  }
  if (parsed.programId !== cfg.impactProgramId) {
    problems.push(`programId ${parsed.programId} != configured ${cfg.impactProgramId}`);
  }
  if (!parsed.destination) {
    problems.push('missing u= destination param');
  } else {
    let dest;
    try {
      dest = new URL(parsed.destination);
    } catch {
      problems.push(`u= does not decode to a URL: ${parsed.destination}`);
    }
    if (dest && !/^https:$/.test(dest.protocol)) {
      problems.push(`destination is not https: ${parsed.destination}`);
    }
  }
  return { ok: problems.length === 0, problems, parsed };
}

/**
 * Structural sanity of the shared config itself: every enabled impact
 * platform must carry a complete, numeric Impact identity. Catches the
 * "someone enabled SeatGeek with empty IDs" class at test time.
 * @param {object} [platforms]
 * @param {object} [rendering] affiliate-platforms.json's "rendering" section
 * @returns {Array<string>} problems (empty = valid)
 */
function validatePlatformConfig(platforms = PLATFORMS, rendering = RENDERING) {
  const problems = [];
  for (const [name, cfg] of Object.entries(platforms)) {
    if (!cfg.enabled) continue;
    if (cfg.type === 'impact') {
      for (const field of ['impactDomain', 'impactPublisherId', 'impactCampaignId', 'impactProgramId']) {
        if (!cfg[field]) problems.push(`${name}: enabled impact platform missing ${field}`);
      }
      for (const field of ['impactPublisherId', 'impactCampaignId', 'impactProgramId']) {
        if (cfg[field] && !/^\d+$/.test(cfg[field])) problems.push(`${name}: ${field} "${cfg[field]}" is not numeric`);
      }
    }
    if (cfg.type === 'partnerize' && !cfg.partnerizeCampaignRef) {
      problems.push(`${name}: enabled partnerize platform missing partnerizeCampaignRef`);
    }
    // Coherence: an enabled platform that isn't revenue-reporting would show
    // its paid traffic as non-affiliate in every report (Codex finding).
    if (cfg.enabled && !cfg.revenueReporting) {
      problems.push(`${name}: enabled but revenueReporting=false — its affiliate traffic would report as unmonetized`);
    }
    // Coherence: an enabled affiliate platform with no "rendering" entry
    // silently falls back to lowest sort priority (99) and un-hidden in
    // src/lib/ticket-utils.ts, rather than a deliberate choice — the exact
    // "added in one config, forgotten in the other" drift BRO-174 unified
    // the two configs to prevent.
    if (cfg.enabled && !rendering[name]) {
      problems.push(`${name}: enabled affiliate platform has no "rendering" entry in affiliate-platforms.json — add one (even just { "priority": N }) so its sort/visibility is a deliberate choice`);
    }
  }
  return problems;
}

/** Extract every Impact deep link (any configured impact domain) from an HTML string. */
function extractImpactLinks(html, platforms = PLATFORMS) {
  const domains = Object.values(platforms)
    .filter((c) => c.type === 'impact' && c.impactDomain)
    .map((c) => c.impactDomain.replace(/\./g, '\\.'));
  if (!domains.length) return [];
  const re = new RegExp(`https://(?:${domains.join('|')})/c/[^"'\\\\\\s<>]+`, 'g');
  const found = html.match(re) || [];
  // Static-export HTML escapes & as &amp; inside attributes.
  return [...new Set(found.map((u) => u.replace(/&amp;/g, '&')))];
}

module.exports = {
  PLATFORMS,
  RENDERING,
  parseImpactLink,
  validateImpactLink,
  validatePlatformConfig,
  extractImpactLinks,
};
