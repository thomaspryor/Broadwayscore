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

/**
 * Display name for a newly auto-registered outlet (BRO-4468). The old writers
 * used the capitalized slug, which is wrong for every compound id
 * (newjerseystage -> "Newjerseystage", liamodell -> "Liamodell").
 *
 * Prefers the most common `outlet` string the outlet's own review files carry,
 * accepted only when it spells the same id once spaces/punctuation are removed
 * ("New Jersey Stage" for newjerseystage), so a critic name or a different
 * outlet's label can never become the display name. Falls back to the
 * hyphen-split capitalized slug and reports `inferred: true` when that fallback
 * is for a single run-together token (the case a human must look at).
 *
 * @param {{outletId: string, reviewOutletNames?: Array<string|null|undefined>}} facts
 * @returns {{displayName: string, inferred: boolean}}
 */
function deriveOutletDisplayName({ outletId, reviewOutletNames = [] }) {
  const idCompact = compactName(outletId);
  const counts = new Map();
  for (const raw of reviewOutletNames) {
    const name = String(raw || '').trim();
    if (name.length < 2 || name.length > 60) continue;
    // A name that is just the lowercase slug adds nothing over the fallback.
    if (name === String(outletId).toLowerCase()) continue;
    if (compactName(name) !== idCompact) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (best) return { displayName: best[0], inferred: false };
  const displayName = String(outletId).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { displayName, inferred: !String(outletId).includes('-') && String(outletId).length >= 8 };
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
 * @returns {{action:'register', domain:string}|{action:'stage', reason:string}}
 */
function decideOutletAutoRegistration({ outletId, domainHint, domainCollides = false, criticSlugs }) {
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

module.exports = {
  STAGING_RELATIVE_PATH,
  STAGE_REASONS,
  criticNameSlugs,
  decideOutletAutoRegistration,
  deriveOutletDisplayName,
  isUnusableOutletSlug,
  mergeStagingEntries,
  loadStagedOutletIds,
};
