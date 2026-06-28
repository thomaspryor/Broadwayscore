import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dismissConsent, waitForBanner, CONSENT_ACCEPT_SELECTORS } = require('./cookie-consent.js');

// Minimal Playwright Page mock.
function mockPage({ visibleSelector = null, clickThrows = false, urlBefore = 'https://x/review', urlAfter = null } = {}) {
  const calls = { clicked: [] };
  let url = urlBefore;
  return {
    calls,
    url() { return url; },
    locator(sel) {
      return { first() { return {
        async isVisible() { return sel === visibleSelector; },
        async click() {
          if (clickThrows) throw new Error('not clickable');
          calls.clicked.push(sel);
          if (urlAfter) url = urlAfter; // simulate navigation
        },
      }; } };
    },
    async waitForTimeout() {},
  };
}

test('selectors are consent-specific only — no bare Accept/Agree that could hit a newsletter modal', () => {
  // A text/title/aria "Accept"-style match is safe only if it ALSO mentions
  // "cookie", OR is scoped to a known consent-platform container class/id
  // (so it can't match a global newsletter/terms "Accept" button).
  const CONSENT_CONTAINER = /onetrust|qc-cmp|message-component|message-button|didomi|truste|sp_message|cookie/i;
  for (const s of CONSENT_ACCEPT_SELECTORS) {
    if (s.includes(':has-text(') || s.includes('title*=') || s.includes('aria-label*=')) {
      assert.ok(/cookie/i.test(s) || CONSENT_CONTAINER.test(s), `selector not consent-scoped: ${s}`);
    }
  }
  // The dangerous bare matches from the first version must be gone.
  const joined = CONSENT_ACCEPT_SELECTORS.join('|').toLowerCase();
  assert.ok(!joined.includes('i accept'));
  assert.ok(!joined.includes('agree and continue'));
  assert.ok(!joined.includes('yes, i agree'));
  assert.ok(!joined.includes(':has-text("accept all")') || joined.includes('cookies')); // no bare "Accept all"
});

test('clicks the first visible consent button; returns it; no navigation', async () => {
  const target = CONSENT_ACCEPT_SELECTORS[0];
  const page = mockPage({ visibleSelector: target });
  const r = await dismissConsent(page, { waitMs: 0 });
  assert.equal(r.clicked, target);
  assert.equal(r.navigatedAway, false);
});

test('no banner → clicked null, no navigation, no click', async () => {
  const page = mockPage({ visibleSelector: null });
  const r = await dismissConsent(page, { waitMs: 0 });
  assert.deepEqual(r, { clicked: null, navigatedAway: false });
  assert.deepEqual(page.calls.clicked, []);
});

test('navigation guard: a click that changes the URL is reported navigatedAway', async () => {
  const target = CONSENT_ACCEPT_SELECTORS[0];
  const page = mockPage({ visibleSelector: target, urlBefore: 'https://x/review', urlAfter: 'https://x/signup' });
  const warnings = [];
  const r = await dismissConsent(page, { waitMs: 0, log: { warn: (m) => warnings.push(m) } });
  assert.equal(r.clicked, target);
  assert.equal(r.navigatedAway, true);
  assert.equal(warnings.length, 1);
});

test('hash-only URL change is NOT treated as navigation', async () => {
  const target = CONSENT_ACCEPT_SELECTORS[0];
  const page = mockPage({ visibleSelector: target, urlBefore: 'https://x/review', urlAfter: 'https://x/review#consent' });
  const r = await dismissConsent(page, { waitMs: 0 });
  assert.equal(r.navigatedAway, false);
});

test('click failure does not throw → clicked null', async () => {
  const target = CONSENT_ACCEPT_SELECTORS[1];
  const page = mockPage({ visibleSelector: target, clickThrows: true });
  const r = await dismissConsent(page, { waitMs: 0 });
  assert.equal(r.clicked, null);
});

test('waitForBanner returns the visible selector / null with no banner', async () => {
  const target = CONSENT_ACCEPT_SELECTORS[2];
  assert.equal(await waitForBanner(mockPage({ visibleSelector: target }), 0), target);
  assert.equal(await waitForBanner(mockPage({ visibleSelector: null }), 0), null);
});
