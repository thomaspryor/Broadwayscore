import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dismissConsent, CONSENT_ACCEPT_SELECTORS } = require('./cookie-consent.js');

// Minimal Playwright Page mock: a locator whose isVisible/click are scripted.
function mockPage({ visibleSelector = null, clickThrows = false } = {}) {
  const calls = { clicked: [], waited: false };
  return {
    calls,
    locator(sel) {
      return {
        first() {
          return {
            async isVisible() { return sel === visibleSelector; },
            async click() {
              if (clickThrows) throw new Error('not clickable');
              calls.clicked.push(sel);
            },
          };
        },
      };
    },
    async waitForTimeout() { calls.waited = true; },
  };
}

test('selector list is non-empty and includes the major consent platforms', () => {
  assert.ok(CONSENT_ACCEPT_SELECTORS.length >= 8);
  assert.ok(CONSENT_ACCEPT_SELECTORS.some((s) => s.includes('onetrust')));
  assert.ok(CONSENT_ACCEPT_SELECTORS.some((s) => /accept all/i.test(s)));
});

test('clicks the first visible accept button and returns its selector', async () => {
  const target = CONSENT_ACCEPT_SELECTORS[0];
  const page = mockPage({ visibleSelector: target });
  const clicked = await dismissConsent(page, { perSelectorTimeout: 1 });
  assert.equal(clicked, target);
  assert.deepEqual(page.calls.clicked, [target]);
});

test('returns null when no banner is present (no throw)', async () => {
  const page = mockPage({ visibleSelector: null });
  const clicked = await dismissConsent(page, { perSelectorTimeout: 1 });
  assert.equal(clicked, null);
  assert.deepEqual(page.calls.clicked, []);
});

test('best-effort: a click failure does not throw, falls through to null', async () => {
  // The visible selector throws on click; with only that one visible, result is null.
  const target = CONSENT_ACCEPT_SELECTORS[1];
  const page = mockPage({ visibleSelector: target, clickThrows: true });
  const clicked = await dismissConsent(page, { perSelectorTimeout: 1 });
  assert.equal(clicked, null);
});
