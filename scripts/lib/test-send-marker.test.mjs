// BRO-3577: manual test sends of real email templates must be unmistakably
// marked, so they can never be mistaken for a real send in a real inbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { markTestSend } = require('./test-send-marker.js');

test('prefixes the subject with [TEST]', () => {
  const { subject } = markTestSend({ subject: 'Your 2026 Tony Award Picks (confirmed)', html: '<p>x</p>' });
  assert.equal(subject, '[TEST] Your 2026 Tony Award Picks (confirmed)');
});

test('prepends a visible warning banner to the html, keeping the original body intact', () => {
  const { html } = markTestSend({ subject: 's', html: '<p>real body</p>' });
  assert.match(html, /TEST EMAIL/);
  assert.match(html, /<p>real body<\/p>/);
  assert.ok(html.indexOf('TEST EMAIL') < html.indexOf('real body'), 'banner must come before the body');
});

test('throws on non-string input rather than silently sending unmarked', () => {
  assert.throws(() => markTestSend({ subject: undefined, html: '<p>x</p>' }), TypeError);
  assert.throws(() => markTestSend({ subject: 's', html: undefined }), TypeError);
});
