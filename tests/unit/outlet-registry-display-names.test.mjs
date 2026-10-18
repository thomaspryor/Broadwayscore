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
const registry = require('../../data/outlet-registry.json');

const MAX_SLUG_DISPLAY_NAMES = 10;

test('live registry: at most 10 displayNames are the capitalized run-together id', () => {
  const rows = findRunTogetherSlugDisplayNames(registry.outlets || registry);
  assert.ok(
    rows.length <= MAX_SLUG_DISPLAY_NAMES,
    `${rows.length} slug-shaped displayNames (max ${MAX_SLUG_DISPLAY_NAMES}): ${rows.slice(0, 15).map((r) => r.outletId).join(', ')}. `
      + 'Fix with node scripts/audit-registry-slug-displaynames.js --fetch --apply, or stamp displayNameReviewed:true on a genuine one-word masthead.',
  );
});

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
