/**
 * BRO-4893: the email list must never read as an account.
 *
 * The owner's partner skipped account sign-up because the header said
 * "Subscribed" next to "Sign in". These tests pin the fix:
 *  - email-capture surfaces don't use account words or stale promises,
 *  - the promise mentions the Sunday roundup subscribers actually get,
 *  - the footer stays inside UserProviders (it needs auth for the nudge),
 *  - both email footers carry the sign-in line, and ?signin=1 parses.
 *
 * Runs in the tsx batch (imports src TS directly, gate-logic.test precedent).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const require = createRequire(import.meta.url);

const { EMAIL_LIST_COPY, ACCOUNT_NUDGE_COPY } = await import('../../src/config/email-list-copy.ts');
const { getTriggerCopy } = await import('../../src/lib/gate-logic.ts');
const { signInSourceFromSearch } = await import('../../src/lib/deferred-auth.ts');
const { buildAccountCtaHtml, buildBroadcastFooterHtml, buildFooterHtml } = require('../../scripts/lib/email-templates.js');

// Email-list surfaces a visitor sees. Comments are stripped before matching.
const SURFACES = [
  'src/components/HeaderSubscribeButton.tsx',
  'src/components/FooterEmailCapture.tsx',
  'src/components/FooterBranding.tsx',
  'src/config/email-list-copy.ts',
];
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('email-list surfaces never say Subscribed / no schedule / Get the Scorecard', () => {
  for (const file of SURFACES) {
    const code = stripComments(read(file));
    for (const banned of [/(?<![A-Za-z])Subscribed/, /no schedule/i, /Get the Scorecard/, /Nothing else/]) {
      assert.doesNotMatch(code, banned, `${file} shows "${banned.source}" to visitors`);
    }
  }
});

test('the list promise and popups mention the Sunday roundup, not "Nothing else"', () => {
  for (const market of ['broadway', 'west-end']) {
    assert.match(EMAIL_LIST_COPY.promise(market), /Sunday roundup/);
  }
  for (const trigger of ['exit_intent', 'scroll_depth']) {
    for (const isWE of [false, true]) {
      const { subheading } = getTriggerCopy(trigger, isWE);
      assert.doesNotMatch(subheading, /Nothing else/, `${trigger} still promises nothing else`);
      assert.match(subheading, /Sunday roundup/, `${trigger} must mention the Sunday roundup`);
    }
  }
});

test('nudge copy says the email list is not an account', () => {
  assert.match(ACCOUNT_NUDGE_COPY.separate, /aren't an account/);
  assert.match(ACCOUNT_NUDGE_COPY.button, /account/i);
});

test('footer stays inside UserProviders (nudge needs auth)', () => {
  const layout = read('src/app/layout.tsx');
  const footerClose = layout.indexOf('</footer>');
  const providersClose = layout.lastIndexOf('</UserProviders>');
  assert.ok(footerClose > 0 && providersClose > 0);
  assert.ok(providersClose > footerClose, '</UserProviders> must close after </footer>');
});

test('footer promotes the account next to the email box, not a second email button (BRO-4946)', () => {
  const layout = read('src/app/layout.tsx');
  assert.match(layout, /<FooterEmailCapture[^>]*\/>\s*<FooterAccountBox \/>/);
  const branding = read('src/components/FooterBranding.tsx');
  assert.match(branding, /<FooterAccountLink \/>/);
  assert.doesNotMatch(branding, /HeaderSubscribeButton/);
});

test('sign-in modal headline offers account creation', () => {
  assert.match(read('src/components/auth/SignInModal.tsx'), /generic: 'Sign in or create a free account'/);
});

test('signInSourceFromSearch reads ?signin=1 and the email name', () => {
  assert.equal(signInSourceFromSearch(''), null);
  assert.equal(signInSourceFromSearch('?signin=0'), null);
  assert.equal(signInSourceFromSearch('?utm_source=newsletter'), null);
  assert.equal(signInSourceFromSearch('?signin=1'), 'email_link');
  assert.equal(signInSourceFromSearch('?signin=1&utm_source=newsletter'), 'email_newsletter');
  assert.equal(signInSourceFromSearch('?signin=1&utm_source=we-weekly'), 'email_we_weekly');
  assert.equal(signInSourceFromSearch('?signin=1&utm_source=%3Cscript%3E'), 'email_link');
});

test('account line links each market home with ?signin=1', () => {
  const bway = buildAccountCtaHtml('broadway', 'opening_night');
  const we = buildAccountCtaHtml('west-end', 'newsletter');
  assert.match(bway, /href="https:\/\/broadwayscorecard\.com\?signin=1&amp;utm_source=opening_night/);
  assert.match(we, /href="https:\/\/broadwayscorecard\.com\/west-end\?signin=1&amp;utm_source=newsletter/);
  assert.match(bway, /sign in or create a free account/);
});

test('both email footers carry the account line', () => {
  for (const market of ['broadway', 'west-end']) {
    const footer = buildBroadcastFooterHtml(null, market);
    assert.match(footer, /signin=1/, `opening-night footer (${market}) is missing the account line`);
    assert.doesNotMatch(footer, /opening night alerts/);
  }
  // The weekly newsletter builds its own footer; it must call the same helper.
  assert.match(read('scripts/newsletter/generate.mjs'), /\$\{buildAccountCtaHtml\(/);
});

test('per-show email banner and its emails say "email me", not "follow" (BRO-4897)', () => {
  const banner = stripComments(read('src/components/ShowFollowBanner.tsx'));
  assert.doesNotMatch(banner, /Following \{showTitle\}|'Follow'|>\s*Follow \{showTitle\}/);
  assert.match(banner, /SHOW_EMAIL_COPY\.prompt\(showTitle\)/);
  const footer = buildFooterHtml('Hamilton', 'hamilton-2015', 'a@example.com', 'broadway');
  assert.doesNotMatch(footer, /you followed|Unfollow this show/);
  assert.match(footer, /Stop emails about this show/);
});
