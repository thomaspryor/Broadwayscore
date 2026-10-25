import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PLATFORMS,
  parseImpactLink,
  validateImpactLink,
  validatePlatformConfig,
  extractImpactLinks,
} = require('./affiliate-link-contract.js');

// A link exactly as src/lib/affiliate-utils.ts buildAffiliateUrl() renders it
// for TodayTix (IDs from src/config/affiliate-platforms.json — the shared
// source of truth, so these goldens move WITH deliberate config changes and
// break only on accidental ones).
const tt = PLATFORMS.TodayTix;
const DEST = 'https://www.todaytix.com/booking/seating-plan?showId=384&showtimeId=2349594';
const GOOD_LINK =
  `https://${tt.impactDomain}/c/${tt.impactPublisherId}/${tt.impactCampaignId}/${tt.impactProgramId}` +
  `?u=${encodeURIComponent(DEST)}&subId1=abc-123&subId2=${encodeURIComponent('flag:x,platform:todaytix')}`;

test('parseImpactLink extracts identity, destination and subIds', () => {
  const parsed = parseImpactLink(GOOD_LINK);
  assert.ok(parsed);
  assert.equal(parsed.domain, tt.impactDomain);
  assert.equal(parsed.publisherId, tt.impactPublisherId);
  assert.equal(parsed.campaignId, tt.impactCampaignId);
  assert.equal(parsed.programId, tt.impactProgramId);
  assert.equal(parsed.destination, DEST);
  assert.equal(parsed.subId1, 'abc-123');
  assert.equal(parsed.subId2, 'flag:x,platform:todaytix');
});

test('parseImpactLink rejects non-impact URLs', () => {
  assert.equal(parseImpactLink('https://www.todaytix.com/nyc/shows/384-hamilton'), null);
  assert.equal(parseImpactLink('not a url'), null);
  assert.equal(parseImpactLink('https://todaytix.pxf.io/some/other/path'), null);
});

test('validateImpactLink passes the rendered-good link', () => {
  const res = validateImpactLink(GOOD_LINK, 'TodayTix');
  assert.deepEqual(res.problems, []);
  assert.equal(res.ok, true);
});

test('validateImpactLink catches a wrong campaign id (the revenue-silently-lost case)', () => {
  const bad = GOOD_LINK.replace(`/${tt.impactCampaignId}/`, '/9999999/');
  const res = validateImpactLink(bad, 'TodayTix');
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.includes('campaignId')));
});

test('validateImpactLink catches a missing destination', () => {
  const bad = `https://${tt.impactDomain}/c/${tt.impactPublisherId}/${tt.impactCampaignId}/${tt.impactProgramId}`;
  const res = validateImpactLink(bad, 'TodayTix');
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.includes('destination')));
});

test('validatePlatformConfig: live config is structurally valid', () => {
  assert.deepEqual(validatePlatformConfig(), []);
});

test('validatePlatformConfig catches an enabled platform with empty IDs', () => {
  const problems = validatePlatformConfig({
    Broken: { type: 'impact', enabled: true, impactDomain: 'x.pxf.io', impactPublisherId: '', impactCampaignId: '1', impactProgramId: '2' },
  });
  assert.ok(problems.length > 0);
  assert.ok(problems[0].includes('impactPublisherId'));
});

test('validatePlatformConfig catches an enabled platform with no rendering entry (BRO-174 drift class)', () => {
  const problems = validatePlatformConfig(
    { NewPlatform: { type: 'utm', enabled: true, revenueReporting: true, params: {} } },
    {} // empty rendering config — NewPlatform has no entry
  );
  assert.ok(problems.some((p) => p.includes('NewPlatform') && p.includes('rendering')));
});

test('extractImpactLinks finds links in static-export HTML (incl. &amp; escaping)', () => {
  const html = `<a href="${GOOD_LINK.replace(/&/g, '&amp;')}">Get Tickets</a> <a href="https://example.com/x">other</a>`;
  const links = extractImpactLinks(html);
  assert.equal(links.length, 1);
  assert.equal(links[0], GOOD_LINK);
});

test('revenueReporting flags: derived AFFILIATE_PLATFORMS matches enabled+historical set', () => {
  const { AFFILIATE_PLATFORMS } = require('./affiliate-stats.js');
  // StubHub is rendering-disabled but must stay in revenue reporting (2026-04-11).
  assert.ok(AFFILIATE_PLATFORMS.has('StubHub'));
  assert.ok(AFFILIATE_PLATFORMS.has('TodayTix'));
  // SeatGeek has never been configured — must not appear.
  assert.ok(!AFFILIATE_PLATFORMS.has('SeatGeek'));
});
