// BRO-5336: outlet displayNames that are just the capitalized run-together id
// ("Hackneycitizen") render under every review on the site. Logic is the real
// helper in scripts/lib/outlet-auto-register.js (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  findRunTogetherSlugDisplayNames,
  isRunTogetherSlugDisplayName,
  extractSiteNames,
  deriveOutletDisplayName,
} = require('../../scripts/lib/outlet-auto-register.js');
// The live-registry ceiling (at most 10 slug-shaped names) runs in
// tests/unit/outlet-registry-live-data.test.mjs, the data-health batch (BRO-5728).

// outlet-tiers.json names are intentionally not checked: src/lib/data-reviews.ts slugifies them into
// public /critics/outlets URLs, so renaming one 404s the old page (BRO-5336 review).

test('shape detection: long run-together slug matches, real names and short ids do not', () => {
  assert.equal(isRunTogetherSlugDisplayName('lifewithlilred', 'Life With Lil Red'), false);
  assert.equal(isRunTogetherSlugDisplayName('hackneycitizen', 'Hackneycitizen'), true);
  assert.equal(isRunTogetherSlugDisplayName('hackneycitizen', 'Hackney Citizen'), false);
  assert.equal(isRunTogetherSlugDisplayName('variety', 'Variety'), false);
  assert.equal(isRunTogetherSlugDisplayName('time-out', 'Timeout'), false);
  const rows = findRunTogetherSlugDisplayNames({
    hackneycitizen: { displayName: 'Hackneycitizen' },
    washingtonian: { displayName: 'Washingtonian', displayNameReviewed: true },
    variety: { displayName: 'Variety' },
  });
  assert.deepEqual(rows, [{ outletId: 'hackneycitizen', displayName: 'Hackneycitizen' }]);
});

test('lowercase raw ids reach the masthead audit without widening capitalized or short names', () => {
  const rows = findRunTogetherSlugDisplayNames({
    theatlantic: { displayName: 'theatlantic' },
    primarytimes: { displayName: 'primarytimes' },
    timesofsandiego: { displayName: 'timesofsandiego' },
    melissamaney: { displayName: 'melissamaney' },
    washingtonian: { displayName: 'washingtonian', displayNameReviewed: true },
    singleticket: { displayName: 'Single Ticket' },
    variety: { displayName: 'variety' },
    letterboxd: { displayName: 'letterboxd' },
    anotheroutlet: { displayName: 'primarytimes' },
  });
  assert.deepEqual(rows.map(row => row.outletId), ['theatlantic', 'primarytimes', 'timesofsandiego', 'melissamaney']);
  assert.equal(isRunTogetherSlugDisplayName('theatlantic', 'The Atlantic'), false);
  assert.equal(isRunTogetherSlugDisplayName('theatlantic', 'Theatlantic'), false);
});

test('auto-add derivation prefers og:site_name over the capitalized slug', () => {
  const html = '<head><title>Home &#8211; Hackney Citizen</title><meta property="og:site_name" content="Hackney Citizen"></head>';
  const siteNames = extractSiteNames(html);
  assert.equal(siteNames[0], 'Hackney Citizen');
  assert.deepEqual(deriveOutletDisplayName({ outletId: 'hackneycitizen', siteNames }), { displayName: 'Hackney Citizen', inferred: false });
  // Domain label spelling and a leading "The" are accepted.
  assert.equal(deriveOutletDisplayName({ outletId: 'sandiegodowntownnews', domain: 'sddowntownnews.com', siteNames: ['SD Downtown News'] }).displayName, 'SD Downtown News');
  assert.equal(deriveOutletDisplayName({ outletId: 'hudsonreview', siteNames: ['The Hudson Review'] }).displayName, 'The Hudson Review');
  // A site name that does not spell the outlet (platform name, other brand) is refused.
  assert.deepEqual(deriveOutletDisplayName({ outletId: 'hackneycitizen', siteNames: ['WordPress', 'Blogger'] }), { displayName: 'Hackneycitizen', inferred: true });
});

test('the outlet masthead wins over a regional subdomain label', () => {
  const siteNames = extractSiteNames('<meta property="og:site_name" content="London"><title>London | Muddy Stilettos</title>');
  assert.deepEqual(deriveOutletDisplayName({
    outletId: 'muddystilettos', domain: 'london.muddystilettos.co.uk', siteNames,
  }), { displayName: 'Muddy Stilettos', inferred: false });
});

test('resolveMastheadName fetches the homepage through the injected fetcher and never throws', async () => {
  const { resolveMastheadName } = require('../../scripts/lib/outlet-auto-register.js');
  const seen = [];
  const ok = await resolveMastheadName({
    outletId: 'hackneycitizen',
    domain: 'hackneycitizen.co.uk',
    fetchPage: async (url) => { seen.push(url); return { content: '<meta property="og:site_name" content="Hackney Citizen">' }; },
  });
  assert.equal(ok.displayName, 'Hackney Citizen');
  assert.deepEqual(seen, ['https://hackneycitizen.co.uk/']);
  const blocked = await resolveMastheadName({ outletId: 'x'.repeat(12), domain: 'example.com', fetchPage: async () => ({ content: '<title>Just a moment...</title>' }) });
  assert.equal(blocked.displayName, null);
  // A hyphenated id's slug fallback is not a masthead either.
  const hyphen = await resolveMastheadName({ outletId: 'new-stage-news', domain: 'example.com', fetchPage: async () => ({ content: '<title>Home</title>' }) });
  assert.equal(hyphen.displayName, null);
  const failed = await resolveMastheadName({ outletId: 'hackneycitizen', domain: 'hackneycitizen.co.uk', fetchPage: async () => { throw new Error('All scraping methods failed'); } });
  assert.equal(failed.displayName, null);
  assert.match(failed.error, /fetch failed/);
});

// BRO-5732: fail closed. A slug-derived name must never reach the registry.
test('an outlet whose only name is the capitalized slug is staged, not registered', () => {
  const { decideOutletAutoRegistration, STAGE_REASONS } = require('../../scripts/lib/outlet-auto-register.js');
  const derived = deriveOutletDisplayName({ outletId: 'hackneycitizen', reviewOutletNames: [], siteNames: [] });
  assert.equal(derived.inferred, true);
  const facts = { outletId: 'hackneycitizen', domainHint: 'hackneycitizen.co.uk', criticSlugs: new Set() };
  assert.deepEqual(
    decideOutletAutoRegistration({ ...facts, displayNameInferred: derived.inferred }),
    { action: 'stage', reason: STAGE_REASONS.NAME_UNRESOLVED },
  );
  assert.deepEqual(decideOutletAutoRegistration({ ...facts, displayNameInferred: false }), { action: 'register', domain: 'hackneycitizen.co.uk' });
  // The more specific reasons still win.
  assert.equal(decideOutletAutoRegistration({ ...facts, domainHint: null, displayNameInferred: true }).reason, STAGE_REASONS.NO_DOMAIN);
});

test('a staged masthead name lets the next rebuild register with a real name, and survives staging refreshes', () => {
  const { mergeStagingEntries, STAGE_REASONS } = require('../../scripts/lib/outlet-auto-register.js');
  const existing = [{ outletId: 'hackneycitizen', reason: STAGE_REASONS.NAME_UNRESOLVED, mastheadName: 'Hackney Citizen', firstSeenAt: 'a', lastSeenAt: 'a' }];
  const fresh = [{ outletId: 'hackneycitizen', reason: STAGE_REASONS.NAME_UNRESOLVED, domainHint: 'hackneycitizen.co.uk', reviewCount: 3 }];
  const [row] = mergeStagingEntries(existing, fresh, { nowIso: 'b' });
  assert.equal(row.mastheadName, 'Hackney Citizen');
  assert.equal(row.firstSeenAt, 'a');
  const d = deriveOutletDisplayName({ outletId: 'hackneycitizen', domain: 'hackneycitizen.co.uk', siteNames: [row.mastheadName] });
  assert.deepEqual(d, { displayName: 'Hackney Citizen', inferred: false });
});

test('rebuild and audit writers gate on displayNameInferred (no entry written with a slug name)', async () => {
  const fs = require('node:fs');
  for (const f of ['scripts/rebuild-all-reviews.js', 'scripts/audit-outlet-registry.js']) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.match(src, /displayNameInferred(:\s*nameUnresolved)?,?\s*\n?\s*\}\);/, `${f} must pass displayNameInferred to decideOutletAutoRegistration`);
  }
});

test('a review label that is just the capitalized slug (gather-reviews fallback) is not a masthead', () => {
  assert.deepEqual(
    deriveOutletDisplayName({ outletId: 'hackneycitizen', reviewOutletNames: ['Hackneycitizen', 'Hackneycitizen'] }),
    { displayName: 'Hackneycitizen', inferred: true },
  );
  // a real multi-word label for the same id still wins
  assert.equal(deriveOutletDisplayName({ outletId: 'hackneycitizen', reviewOutletNames: ['Hackneycitizen', 'Hackney Citizen'] }).displayName, 'Hackney Citizen');
  // short real names are unaffected
  assert.deepEqual(deriveOutletDisplayName({ outletId: 'variety', reviewOutletNames: ['Variety'] }), { displayName: 'Variety', inferred: false });
});
