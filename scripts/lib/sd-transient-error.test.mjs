/**
 * Unit tests for scripts/lib/sd-transient-error.js (BRO-6492).
 * Run: node --test scripts/lib/sd-transient-error.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scrapingdogErrorMessage, isTransientScrapingdogError, parseScrapingdogHttpError } = require('./sd-transient-error.js');

test('network errors and 5xx are transient', () => {
  assert.equal(isTransientScrapingdogError({}), true);
  assert.equal(isTransientScrapingdogError({ status: 502 }), true);
});

test('the "something went wrong" 400 is transient, as string or JSON body', () => {
  const sd = scrapingdogErrorMessage({ message: 'Something went wrong, please try again' });
  assert.equal(isTransientScrapingdogError({ status: 400, message: sd }), true);
  const page = "Oops! Something went wrong. You won’t be charged for this request";
  assert.equal(isTransientScrapingdogError({ status: 400, message: scrapingdogErrorMessage(page) }), true);
});

test('the stealth-mode hint is not transient (scraper.js escalates it instead)', () => {
  const hint = "Oops! Something went wrong. You won't be charged for this request. Try enabling Stealth Mode using stealth_mode=true";
  assert.equal(isTransientScrapingdogError({ status: 400, message: hint }), false);
});

test('structural 4xx stay permanent', () => {
  assert.equal(isTransientScrapingdogError({ status: 404, message: 'This URL does not exist or the url is wrong.' }), false);
  assert.equal(isTransientScrapingdogError({ status: 400, message: 'The site could not be reached securely' }), false);
  assert.equal(isTransientScrapingdogError({ status: 401, message: 'Something went wrong' }), false);
  assert.equal(isTransientScrapingdogError({ status: 400, message: null }), false);
});

test('object bodies without a string message give null, not "[object Object]"', () => {
  assert.equal(scrapingdogErrorMessage({ detail: 1 }), null);
  assert.equal(scrapingdogErrorMessage({ error: 'Something went wrong' }), 'Something went wrong');
  assert.equal(scrapingdogErrorMessage(undefined), null);
});

test('parses scraper.js error messages', () => {
  assert.deepEqual(parseScrapingdogHttpError('Scrapingdog HTTP 400: Oops! Something went wrong.'), { status: 400, message: 'Oops! Something went wrong.' });
  assert.equal(parseScrapingdogHttpError('Scrapingdog request timeout'), null);
});
