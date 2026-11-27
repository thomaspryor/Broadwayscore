/**
 * BRO-8389 (Australia pilot): Australian productions are `category: 'regional'` but are
 * neither Broadway tryouts nor UK flagship shows. getRegionalCountry is the ONE seam, in
 * TS (src/lib/market-utils.ts) and its JS twin (scripts/lib/market-label.js). Real functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import {
  getRegionalCountry, isAuRegionalShow, isUsRegionalShow, isUkRegionalShow,
  getMarketCountry, getMarketCurrency, getCurrencySymbol, getRegionalLabel, getAuRegionalVenueCity,
} from '../../src/lib/market-utils';

const require = createRequire(import.meta.url);
const twin = require('../../scripts/lib/market-label.js');

const AU = ['Roslyn Packer Theatre, Sydney, NSW', 'Roslyn Packer Theatre', 'Sydney Theatre Company, Sydney',
  'Princess Theatre, Melbourne', 'Her Majesty\'s Theatre, Melbourne', 'Regent Theatre, Melbourne, VIC',
  'Lyric Theatre, QPAC, Brisbane, QLD', 'Some New Venue, Hobart, TAS'];
// Houses that share a name with an AU one, plus WA/SA-style US suffixes: must stay US.
const NOT_AU = ['Princess Theatre, Torquay', 'Capitol Theatre, Chicago, IL', 'Seattle Rep, Seattle, WA',
  'Regent Theatre, Ipswich', 'Goodman Theatre, Chicago, IL', 'Arena Stage, Washington, DC', 'Lyric Theatre, London'];

test('AU venues resolve AU on the TS seam and the JS twin; look-alikes stay US', () => {
  for (const venue of AU) {
    assert.equal(getRegionalCountry({ category: 'regional', venue }), 'AU', venue);
    assert.equal(twin.getRegionalCountry(venue), 'AU', `twin: ${venue}`);
  }
  for (const venue of NOT_AU) {
    assert.notEqual(getRegionalCountry({ category: 'regional', venue }), 'AU', venue);
    assert.notEqual(twin.getRegionalCountry(venue), 'AU', `twin: ${venue}`);
  }
});

test('country, currency, symbol and label follow the seam', () => {
  const v = 'Roslyn Packer Theatre, Sydney, NSW';
  assert.equal(getMarketCountry('regional', v), 'AU');
  assert.equal(getMarketCurrency('regional', v), 'AUD');
  assert.equal(getCurrencySymbol('regional', v), 'A$');
  assert.equal(getRegionalLabel({ category: 'regional', venue: v }), 'Australia');
  assert.equal(getAuRegionalVenueCity('regional', v), 'Sydney');
  // Existing markets are unchanged.
  assert.deepEqual([getMarketCountry('regional', 'Goodman Theatre, Chicago, IL'), getMarketCurrency('regional', 'Goodman Theatre, Chicago, IL'), getCurrencySymbol('regional', 'Goodman Theatre, Chicago, IL')], ['US', 'USD', '$']);
  assert.deepEqual([getMarketCountry('regional', 'Royal Shakespeare Theatre'), getMarketCurrency('west-end'), getCurrencySymbol('west-end')], ['GB', 'GBP', '£']);
  assert.equal(getMarketCountry('broadway', v), 'US', 'only regional shows can be AU');
});

test('exactly one of US/UK/AU holds for a regional show, and non-regional is never AU', () => {
  for (const venue of [...AU, ...NOT_AU, 'Royal Shakespeare Theatre, Stratford-upon-Avon']) {
    const s = { category: 'regional', venue };
    assert.equal([isUsRegionalShow(s), isUkRegionalShow(s), isAuRegionalShow(s)].filter(Boolean).length, 1, venue);
  }
  assert.equal(isAuRegionalShow({ category: 'off-broadway', venue: 'Roslyn Packer Theatre' }), false);
});

test('the AU prompt names Australia, never "a US theater outside New York"', () => {
  const t = twin.getRegionalPromptContext('Roslyn Packer Theatre, Sydney, NSW');
  assert.match(t, /AUSTRALIAN/);
  assert.doesNotMatch(t, /US theater|Broadway production and/);
  assert.match(twin.getMarketLabel('regional', 'Roslyn Packer Theatre, Sydney, NSW'), /Australia/);
  assert.match(twin.getRegionalPromptContext('Goodman Theatre, Chicago, IL'), /a US theater outside New York/);
});

test('class guard: every "not UK" regional consumer was reviewed for AU', () => {
  // A new `!isUkRegionalShow` / `!isUkRegionalVenue` consumer silently treats AU as a US tryout.
  // Add it to this list only after deciding what AU should do there.
  // Both are UK-only pipelines that skip non-UK rows, which is right for AU too.
  const REVIEWED = new Set(['scripts/uk-regional-coverage.js', 'scripts/lib/auto-close-expired.js']);
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) { if (!['node_modules', '.next', 'worktrees'].includes(e.name)) walk(p); }
    else if (/\.(tsx?|js|mjs)$/.test(e.name) && !/\.test\./.test(e.name) && /!\s*isUkRegional(Show|Venue)\(/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
  } };
  walk('src'); walk('scripts');
  assert.deepEqual(hits.filter((h) => !REVIEWED.has(h)), [], 'unreviewed !isUkRegional* consumers');
});

test('AU regional runs use Sydney calendar day and the stale-run rule (BRO-8389)', () => {
  const ac = require('../../scripts/lib/auto-close-expired.js');
  // 2026-11-25 16:00 UTC is already 2026-11-26 in Sydney, still 2026-11-25 in New York.
  const now = new Date('2026-11-25T16:00:00Z');
  assert.equal(ac.getMarketDate('regional', now, 'Roslyn Packer Theatre, Sydney, NSW'), '2026-11-26');
  assert.equal(ac.getMarketDate('regional', now, 'Arena Stage, Washington, DC'), '2026-11-25');
});

// BRO-8393: Whispering Jack's timeout.com/sydney review was filed as T1 Time Out New York, and
// its Guardian review (Steve Dow) was credited to Alexis Soloski. Real functions, real registry.
const norm = require('../../scripts/lib/review-normalization.js');
const { validateUrlDomain } = require('../../scripts/lib/url-discovery.js');
const { classifyOutletHostMismatch } = require('../../scripts/lib/outlet-domain-validation.js');
const { EDITION_PAIRS } = require('../../scripts/lib/outlet-registry-domain-collisions.js');
const { defaultCriticForOutlet } = require('../../scripts/lib/gather-default-critic.js');
// Loaded through the library (a tracked config table, not live data: BRO-7101 rule).
const registry = norm.loadOutletRegistry();
const outletTiers = JSON.parse(fs.readFileSync(new URL('../../src/config/outlet-tiers.json', import.meta.url), 'utf8'));
const WJ_TIMEOUT = 'https://www.timeout.com/sydney/theatre/whispering-jack-the-john-farnham-musical';

test('Time Out Sydney is its own T2 outlet, the same tier as the SMH and The Australian', () => {
  const entry = registry.outlets['timeout-sydney'];
  assert.ok(entry, 'timeout-sydney registered');
  assert.equal(entry.displayName, 'Time Out Sydney');
  assert.equal(entry.tier, registry.outlets.smh.tier);
  assert.equal(entry.tier, registry.outlets.australian.tier);
  assert.equal(entry.tier, 2);
  assert.equal(outletTiers['timeout-sydney']?.tier, 2, 'outlet-tiers.json carries the same tier');
  assert.equal(norm.normalizeOutlet('Time Out Sydney'), 'timeout-sydney');
  assert.equal(norm.normalizeOutlet('time-out-sydney'), 'timeout-sydney', 'the old id still resolves');
  const group = EDITION_PAIRS.find((p) => p.includes('timeout'));
  for (const id of Object.values(norm.TIMEOUT_CITY_OUTLETS)) {
    assert.ok(registry.outlets[id], `${id} registered`);
    assert.ok(group.includes(id), `${id} declared in the timeout.com edition group`);
  }
});

test('a timeout.com/<city> URL never resolves to Time Out New York outside NYC', () => {
  assert.equal(norm.resolveOutletFromUrl(WJ_TIMEOUT)?.outletId, 'timeout-sydney');
  assert.equal(norm.resolveOutletFromUrl('https://sydney.timeout.com/theatre/x')?.outletId, 'timeout-sydney');
  for (const u of ['https://www.timeout.com/melbourne/theatre/x', 'https://www.timeout.com/chicago/theater/x',
    'https://www.timeout.com/san-francisco/theater/x', 'https://www.timeout.com/brisbane/theatre/x']) {
    assert.notEqual(norm.resolveOutletFromUrl(u)?.outletId, 'timeout', u);
  }
  // NYC and London are unchanged.
  assert.equal(norm.resolveOutletFromUrl('https://www.timeout.com/newyork/theater/x')?.outletId, 'timeout');
  assert.equal(norm.resolveOutletFromUrl('https://www.timeout.com/theater-reviews/x')?.outletId, 'timeout');
  assert.equal(norm.resolveOutletFromUrl('https://www.timeout.com/london/theatre/x')?.outletId, 'timeout-london');
});

test('class guard: a Time Out NY (or London) id on another city edition is refused everywhere', () => {
  assert.equal(norm.timeoutEditionMismatch('timeout', WJ_TIMEOUT)?.expected, 'timeout-sydney');
  const chicago = norm.timeoutEditionMismatch('timeout', 'https://www.timeout.com/chicago/theater/x');
  assert.ok(chicago && chicago.expected === null, 'unregistered city: mismatch with no outlet to move to');
  assert.ok(norm.timeoutEditionMismatch('timeout-london', WJ_TIMEOUT), 'London id on a Sydney URL');
  assert.equal(norm.timeoutEditionMismatch('timeout-sydney', WJ_TIMEOUT), null);
  assert.equal(norm.timeoutEditionMismatch('Time Out New York', 'https://www.timeout.com/newyork/theater/x'), null);
  assert.equal(norm.timeoutEditionMismatch('timeout', 'https://www.theguardian.com/stage/x'), null);
  // The write-path domain gate and the rebuild's host-mismatch audit both use it.
  assert.equal(validateUrlDomain(WJ_TIMEOUT, 'timeout').valid, false);
  assert.equal(validateUrlDomain('https://www.timeout.com/chicago/theater/x', 'timeout').valid, false);
  assert.equal(validateUrlDomain(WJ_TIMEOUT, 'timeout-sydney').valid, true);
  assert.equal(validateUrlDomain('https://www.timeout.com/newyork/theater/x', 'timeout').valid, true);
  // The rebuild heals a registered edition from the URL; an unregistered city has no heal target,
  // so the rebuild's host-mismatch audit flags it.
  assert.deepEqual(norm.resolveOutletFromUrlIfPathInformed(WJ_TIMEOUT), { outletId: 'timeout-sydney', displayName: 'Time Out Sydney' });
  const audit = classifyOutletHostMismatch({ outletId: 'timeout', url: 'https://www.timeout.com/chicago/theater/x' }, registry);
  assert.equal(audit.mismatch, true);
  assert.equal(classifyOutletHostMismatch({ outletId: 'timeout-sydney', url: WJ_TIMEOUT }, registry).mismatch, false);
  assert.equal(classifyOutletHostMismatch({ outletId: 'timeout', url: 'https://www.timeout.com/newyork/theater/x' }, registry).mismatch, false);
});

test('gather default critic: a legacy NYC critic list never names a byline', () => {
  const legacy = JSON.parse(fs.readFileSync(new URL('../../scripts/config/critic-outlets.json', import.meta.url), 'utf8'));
  const guardian = legacy.tier1.find((o) => o.id === 'guardian');
  assert.deepEqual(guardian.critics, ['Alexis Soloski'], 'fixture: the legacy list still has one name');
  assert.equal(defaultCriticForOutlet(guardian), 'Unknown', 'Whispering Jack Guardian review was Steve Dow');
  assert.equal(defaultCriticForOutlet(legacy.tier3.find((o) => o.id === 'broadwayworld')), 'Unknown');
  assert.equal(defaultCriticForOutlet({ id: 'x', critics: ['Jane Roe'], criticsAreDefaults: true }), 'Jane Roe');
  assert.equal(defaultCriticForOutlet({ id: 'x', critics: ['A', 'B'], criticsAreDefaults: true }), 'Unknown');
  assert.equal(defaultCriticForOutlet(null), 'Unknown');
});
