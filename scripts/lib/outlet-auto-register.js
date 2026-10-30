/**
 * outlet-auto-register.js — the decision behind rebuild-all-reviews.js's
 * post-build "auto-register new outlets" pass (BRO-4370 / BRO-4401).
 *
 * The rebuild used to write a registry row for EVERY unknown outletId it saw
 * on an included review, with `domain: null` whenever no domain could be
 * inferred from the outlet's own review URLs. Two things went wrong with
 * that on 2026-09-29:
 *
 *   1. Critic bylines that an aggregator parser had turned into outletIds
 *      (paula-citron, ben-ryland, bill-sullivan) were registered as outlets.
 *      A person is not a publication; each row also shadowed the real critic
 *      in getOutletDisplayName and stole byline-matched reviews.
 *   2. Every domainless row counts against the null-domain ceiling in
 *      tests/unit/outlet-registry-live-data.test.mjs (50) — a domainless
 *      outlet can't be site-restricted in a SERP search, so the ceiling is
 *      the thing that keeps per-outlet discovery working. 51 > 50 turned
 *      main red with no code change.
 *
 * The rule now: an outlet is auto-registered ONLY with a resolvable domain.
 * Anything else — a critic-name id, an id with no URL evidence, a domain that
 * would collide with an already-registered outlet — is PARKED in
 * data/audit/outlet-registry-staging.json for a human to resolve (give it a
 * domain, merge it into the right outlet, or delete the review). Parked ids
 * keep resolving at read time exactly as unregistered ids always have
 * (tier 3, raw-id display), and audit-outlet-registry.js --strict treats a
 * staged id as known rather than as a NEW registry gap, so parking never
 * turns Data Validation red either.
 *
 * Pure decision functions only (CLAUDE.md §15): the rebuild passes in the
 * facts, this file answers register-or-stage, and scripts/outlet-registry.test.mjs
 * exercises every branch without a real registry.
 */

'use strict';

const path = require('path');
const { slugifyName } = require('./bww-critic-name-phantoms');
const { foldDiacritics } = require('./title-match');

const STAGING_RELATIVE_PATH = path.join('data', 'audit', 'outlet-registry-staging.json');

const STAGE_REASONS = Object.freeze({
  CRITIC_NAME: 'critic-name',
  NO_DOMAIN: 'no-domain',
  DOMAIN_COLLISION: 'domain-collision',
  // An id that is a bare domain label ("co" from stagedoorjoe.co.uk), not an
  // outlet name (BRO-4468).
  UNUSABLE_SLUG: 'unusable-slug',
  // The only display name on offer is the capitalized run-together slug
  // ("Hackneycitizen"); no masthead or review label spells the id. Fail
  // closed (BRO-5732): a slug-shaped name rendered under every review and
  // was hand-renamed 167 + 4 times (BRO-5336, BRO-5642).
  NAME_UNRESOLVED: 'name-unresolved',
});

// Public-suffix / generic host labels that a domain-parsing writer can emit as
// an outlet id when it splits the wrong dot ("stagedoorjoe.co.uk" -> "co").
const DOMAIN_LABEL_SLUGS = new Set([
  'www', 'co', 'com', 'org', 'net', 'uk', 'ac', 'gov', 'edu', 'io', 'me', 'tv',
  'info', 'biz', 'us', 'ca', 'au', 'nz', 'ie', 'online', 'blog', 'site',
]);

/** True for an id that cannot be an outlet name: a domain label or under 3 chars. */
function isUnusableOutletSlug(outletId) {
  const id = String(outletId || '').trim().toLowerCase();
  return id.length < 3 || DOMAIN_LABEL_SLUGS.has(id);
}

const compactName = (v) => foldDiacritics(String(v || '')).toLowerCase()
  .replace(/\.(com|co\.uk|org|net|uk|ca|au)$/, '')
  .replace(/[^a-z0-9]/g, '');

// Decode the handful of HTML entities a <meta content> / <title> carries.
function decodeHtmlText(v) {
  return String(v || '')
    .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c <= 0x10ffff ? String.fromCodePoint(c) : m; })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { const c = parseInt(n, 16); return c <= 0x10ffff ? String.fromCodePoint(c) : m; })
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '\u2013').replace(/&mdash;/g, '\u2014').replace(/&rsaquo;/g, '\u203a').replace(/&raquo;/g, '\u00bb')
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&hellip;/g, '...')
    .replace(/\s+/g, ' ').trim();
}

function metaContent(html, attr, value) {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp(`<meta[^>]+${attr}=["']${esc}["'][^>]*content=["']([^"']+)["']`, 'i').exec(html);
  if (a) return decodeHtmlText(a[1]);
  const b = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*${attr}=["']${esc}["']`, 'i').exec(html);
  return b ? decodeHtmlText(b[1]) : null;
}

/**
 * Masthead-name candidates from a fetched homepage (BRO-5336), strongest first:
 * og:site_name, application-name, then the <title> and its " | " / " - "
 * segments. Callers must still gate them through deriveOutletDisplayName,
 * which only accepts a candidate that spells the outlet's id or domain.
 *
 * @param {string} html
 * @returns {string[]}
 */
function extractSiteNames(html) {
  const src = String(html || '');
  const out = [];
  // Trailing separators/ornaments ("Rachel Weinberg Reviews -", "Istvan Dugalin \u27a4") are not part of the name.
  const push = (v) => {
    const t = decodeHtmlText(v).replace(/[\s\-\u2013\u2014|:\u00b7\u2022\u00bb\u203a\u27a4\u25ba\u2605]+$/u, '').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  const og = metaContent(src, 'property', 'og:site_name') || metaContent(src, 'name', 'og:site_name');
  if (og) push(og);
  const app = metaContent(src, 'name', 'application-name');
  if (app) push(app);
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  if (t) {
    const title = decodeHtmlText(t[1]);
    push(title);
    for (const seg of title.split(/\s+[|\u2013\u2014\-\u00b7:]\s+/)) push(seg);
  }
  return out;
}

/** compactName with a leading "the" dropped ("The Hudson Review" -> hudsonreview). */
const compactNoThe = (v) => compactName(String(v || '').replace(/^\s*the\s+/i, ''));

/**
 * True for a candidate name that spells the outlet's id or its domain's first
 * label (sddowntownnews.com for sandiegodowntownnews), with or without a
 * leading "The".
 */
function nameSpellsOutlet(name, outletId, domain) {
  const targets = new Set([compactName(outletId), compactNoThe(outletId)]);
  const label = String(domain || '').toLowerCase().replace(/^www\./, '').split('.')[0];
  if (label) { targets.add(compactName(label)); targets.add(compactNoThe(label)); }
  targets.delete('');
  return targets.has(compactName(name)) || targets.has(compactNoThe(name));
}

/**
 * Display name for a newly auto-registered outlet (BRO-4468). The old writers
 * used the capitalized slug, which is wrong for every compound id
 * (newjerseystage -> "Newjerseystage", liamodell -> "Liamodell").
 *
 * Order of preference:
 *   1. siteNames (BRO-5336): the outlet's own og:site_name / <title>, from
 *      extractSiteNames() on its homepage, accepted when it spells the id or
 *      the domain label ("San Diego Downtown News" for sandiegodowntownnews /
 *      sddowntownnews.com). Candidates spelling the id precede domain-only
 *      matches; otherwise the first accepted candidate wins.
 *   2. the most common `outlet` string the outlet's own review files carry,
 *      accepted only when it spells the same id, so a critic name or a
 *      different outlet's label can never become the display name.
 *   3. the hyphen-split capitalized slug, reported `inferred: true` when that
 *      fallback is for a single run-together token. Writers must not store
 *      that name: decideOutletAutoRegistration stages the outlet instead
 *      (NAME_UNRESOLVED, BRO-5732) until a masthead name is found.
 *
 * @param {{outletId: string, reviewOutletNames?: Array<string|null|undefined>, siteNames?: Array<string|null|undefined>, domain?: string|null}} facts
 * @returns {{displayName: string, inferred: boolean}}
 */
function deriveOutletDisplayName({ outletId, reviewOutletNames = [], siteNames = [], domain = null }) {
  const mastheads = [];
  for (const raw of siteNames) {
    const name = String(raw || '').trim();
    if (name.length < 2 || name.length > 60) continue;
    if (name === name.toLowerCase()) continue; // a bare lowercase slug is no masthead
    if (!nameSpellsOutlet(name, outletId, domain)) continue;
    mastheads.push(name);
  }
  // Prefer the outlet's name to a regional subdomain label ("London" on
  // london.muddystilettos.co.uk). Domain aliases remain the fallback.
  const masthead = mastheads.find(name => nameSpellsOutlet(name, outletId, null)) || mastheads[0];
  if (masthead) return { displayName: masthead, inferred: false };
  const idCompact = compactName(outletId);
  const counts = new Map();
  for (const raw of reviewOutletNames) {
    const name = String(raw || '').trim();
    if (name.length < 2 || name.length > 60) continue;
    // A name that is just the lowercase slug adds nothing over the fallback.
    if (name === String(outletId).toLowerCase()) continue;
    if (compactName(name) !== idCompact) continue;
    // gather-reviews.js writes review.outlet as the capitalized domain base for an
    // unresolved host ("Hackneycitizen"); that label IS the slug fallback, not a masthead (BRO-5732).
    if (!String(outletId).includes('-') && name === String(outletId).charAt(0).toUpperCase() + String(outletId).slice(1).toLowerCase()) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (best) return { displayName: best[0], inferred: false };
  const displayName = String(outletId).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { displayName, inferred: !String(outletId).includes('-') && String(outletId).length >= 8 };
}

/**
 * Fetch an outlet's homepage and return its masthead name when one spells the
 * id or domain (BRO-5336). The fetcher is injected (pass scraper.fetchPage)
 * so this file stays network-free and testable. Never throws: a failed fetch
 * resolves to { displayName: null, siteNames: [], error }.
 *
 * @param {{outletId: string, domain: string|null, fetchPage: (url: string, opts?: object) => Promise<{content: string}>}} args
 * @returns {Promise<{displayName: string|null, siteNames: string[], error?: string}>}
 */
async function resolveMastheadName({ outletId, domain, fetchPage }) {
  if (!domain || typeof fetchPage !== 'function') return { displayName: null, siteNames: [], error: 'no domain' };
  let siteNames = [];
  try {
    const page = await fetchPage(`https://${domain}/`, { skipVerify: true });
    siteNames = extractSiteNames(page && page.content);
  } catch (err) {
    return { displayName: null, siteNames: [], error: `fetch failed: ${err && err.message}` };
  }
  const { displayName } = deriveOutletDisplayName({ outletId, domain, siteNames });
  // Only a name the page itself offered counts; the slug fallback is not a masthead.
  return { displayName: siteNames.includes(displayName) ? displayName : null, siteNames };
}

/**
 * BRO-5336/BRO-5603: a displayName that is just a run-together id, either
 * capitalized (12+ chars) or lowercase (11+ chars, including "theatlantic").
 * Long single tokens only,
 * so real one-word mastheads ("Variety", "Playbill") never match.
 */
function isRunTogetherSlugDisplayName(outletId, displayName) {
  const d = String(displayName || '');
  return /^[A-Z]?[a-z]{11,}$/.test(d) && d.toLowerCase() === String(outletId || '').replace(/-/g, '');
}

/**
 * @param {Record<string, {displayName?: string, displayNameReviewed?: boolean}>} outlets
 * @returns {Array<{outletId: string, displayName: string}>} entries in that shape
 *   (an entry stamped displayNameReviewed is a deliberate one-word name and skipped)
 */
function findRunTogetherSlugDisplayNames(outlets) {
  const rows = [];
  for (const [id, entry] of Object.entries(outlets || {})) {
    if (!entry || entry.displayNameReviewed) continue;
    if (isRunTogetherSlugDisplayName(id, entry.displayName)) rows.push({ outletId: id, displayName: entry.displayName });
  }
  return rows;
}

/**
 * Every slug a critic could be filed under: the critic-registry key, the
 * slug of its display name (what an aggregator byline actually carries), AND
 * the slug of every criticName on the reviews being rebuilt.
 *
 * The third source is load-bearing. data/critic-registry.json is generated
 * from already-scored, already-attributed reviews, so a byline the parser
 * mis-filed as an outlet is exactly the one the registry has never seen:
 * on 2026-09-29 none of paula-citron / ben-ryland / bill-sullivan were in it
 * (verified against the live file while building this). Their names WERE
 * present as criticName on the correctly attributed twin records in the
 * same rebuild, which is what bww-critic-name-phantoms.js keys on too.
 *
 * @param {{critics?: Record<string, {displayName?: string}>}|null} criticRegistry data/critic-registry.json, or null when unreadable
 * @param {Array<{criticName?: string|null}>} [reviews] the rebuild's included reviews
 * @returns {Set<string>}
 */
function criticNameSlugs(criticRegistry, reviews) {
  const slugs = new Set();
  const critics = (criticRegistry && criticRegistry.critics) || {};
  for (const [key, entry] of Object.entries(critics)) {
    const keySlug = slugifyName(key);
    if (keySlug) slugs.add(keySlug);
    const nameSlug = slugifyName(entry && entry.displayName);
    if (nameSlug) slugs.add(nameSlug);
  }
  for (const r of reviews || []) {
    const name = r && r.criticName;
    if (!name || /^(unknown|unnamed|staff)$/i.test(String(name).trim())) continue;
    const slug = slugifyName(name);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

/**
 * Register-or-stage for ONE unknown outletId.
 *
 * @param {object} facts
 * @param {string} facts.outletId
 * @param {string|null} facts.domainHint  majority-vote hostname from the outlet's review URLs (outlet-domain-hint.js), or null
 * @param {boolean} [facts.domainCollides]  true when domainHint already belongs to a registered outlet
 * @param {Set<string>} [facts.criticSlugs]  from criticNameSlugs()
 * @param {boolean} [facts.displayNameInferred]  deriveOutletDisplayName's `inferred`: only a slug-derived name exists (BRO-5732)
 * @returns {{action:'register', domain:string}|{action:'stage', reason:string}}
 */
function decideOutletAutoRegistration({ outletId, domainHint, domainCollides = false, criticSlugs, displayNameInferred = false }) {
  const id = String(outletId || '').toLowerCase();
  if (isUnusableOutletSlug(id)) {
    return { action: 'stage', reason: STAGE_REASONS.UNUSABLE_SLUG };
  }
  // A critic's OWN site (carole-di-tosti → caroleditosti.com) is a real
  // outlet: the name matches a byline AND the domain is literally the name.
  // Only a critic-name id whose URL evidence points somewhere else (or
  // nowhere) is a mis-filed byline.
  // Exact host-label match, not a substring: a short mononym slug would
  // otherwise "own" almost any domain (ship-check finding).
  const compact = id.replace(/-/g, '');
  const ownSite = !!domainHint && String(domainHint).toLowerCase().split('.')
    .some((label) => label === compact || label === id);
  if (criticSlugs && criticSlugs.size > 0 && criticSlugs.has(id) && !ownSite) {
    return { action: 'stage', reason: STAGE_REASONS.CRITIC_NAME };
  }
  if (!domainHint) {
    return { action: 'stage', reason: STAGE_REASONS.NO_DOMAIN };
  }
  if (domainCollides) {
    return { action: 'stage', reason: STAGE_REASONS.DOMAIN_COLLISION };
  }
  if (displayNameInferred) {
    return { action: 'stage', reason: STAGE_REASONS.NAME_UNRESOLVED };
  }
  return { action: 'register', domain: domainHint };
}

/**
 * Merge this run's staged outlets into the persisted staging list.
 * Keyed by outletId; firstSeenAt survives, everything else refreshes. An
 * outlet that has since been registered (or whose reviews are gone) is
 * dropped when `stillUnregistered` says so, so the list self-prunes.
 *
 * @param {Array<object>} existing  prior staging entries
 * @param {Array<{outletId:string, reason:string, reviewCount?:number, exampleShowId?:string|null, domainHint?:string|null}>} fresh
 * @param {{nowIso: string, stillUnregistered?: (outletId: string) => boolean}} opts
 * @returns {Array<object>} sorted by outletId
 */
function mergeStagingEntries(existing, fresh, { nowIso, stillUnregistered } = {}) {
  const byId = new Map();
  for (const e of existing || []) {
    if (e && e.outletId) byId.set(e.outletId, { ...e });
  }
  for (const f of fresh || []) {
    if (!f || !f.outletId) continue;
    const prev = byId.get(f.outletId);
    byId.set(f.outletId, {
      outletId: f.outletId,
      reason: f.reason,
      domainHint: f.domainHint || null,
      reviewCount: f.reviewCount || 0,
      exampleShowId: f.exampleShowId || null,
      // A masthead found by audit-registry-slug-displaynames --fetch --apply
      // survives refreshes so the next rebuild can register with it.
      ...((f.mastheadName || (prev && prev.mastheadName)) ? { mastheadName: f.mastheadName || prev.mastheadName } : {}),
      firstSeenAt: (prev && prev.firstSeenAt) || nowIso,
      lastSeenAt: nowIso,
    });
  }
  const keep = typeof stillUnregistered === 'function' ? stillUnregistered : () => true;
  return [...byId.values()]
    .filter((e) => keep(e.outletId))
    .sort((a, b) => a.outletId.localeCompare(b.outletId));
}

/**
 * Staged outletIds as a Set, for audit-outlet-registry.js. Missing or
 * unreadable file → empty set (the audit then behaves exactly as before).
 *
 * @param {string} rootDir repo root
 * @returns {Set<string>}
 */
function loadStagedOutletIds(rootDir) {
  const fs = require('fs');
  const file = path.join(rootDir, STAGING_RELATIVE_PATH);
  if (!fs.existsSync(file)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set((data.staged || []).map((e) => e && e.outletId).filter(Boolean));
  } catch (err) {
    // A present-but-unreadable file must not look like "nothing staged":
    // the audit would then report every parked id as a brand-new gap with
    // no hint why (ship-check finding).
    console.warn(`⚠️  ${STAGING_RELATIVE_PATH} exists but could not be parsed (${err.message}) — treating as empty; staged ids will read as NEW`);
    return new Set();
  }
}

// BRO-5823: the rebuild parks an unregisterable outlet here by design, so a
// hygiene audit that fails on "unregistered live outlet" fires on every fresh
// staging row before anyone can resolve it. Staged ids inside this window are
// reported as pending, not failed; past it they fail (a human must decide).
const STAGED_GRACE_DAYS = 3;

/** Set of staged outletIds first seen within graceDays of nowMs. */
function recentlyStagedOutletIds(stagingDoc, nowMs, graceDays = STAGED_GRACE_DAYS) {
  const out = new Set();
  for (const e of (stagingDoc && stagingDoc.staged) || []) {
    const seen = e && e.firstSeenAt ? Date.parse(e.firstSeenAt) : NaN;
    if (e && e.outletId && Number.isFinite(seen) && nowMs >= seen && nowMs - seen <= graceDays * 86400000) out.add(e.outletId);
  }
  return out;
}

module.exports = {
  STAGED_GRACE_DAYS,
  recentlyStagedOutletIds,
  STAGING_RELATIVE_PATH,
  STAGE_REASONS,
  criticNameSlugs,
  decideOutletAutoRegistration,
  deriveOutletDisplayName,
  extractSiteNames,
  findRunTogetherSlugDisplayNames,
  isRunTogetherSlugDisplayName,
  isUnusableOutletSlug,
  nameSpellsOutlet,
  resolveMastheadName,
  mergeStagingEntries,
  loadStagedOutletIds,
};
