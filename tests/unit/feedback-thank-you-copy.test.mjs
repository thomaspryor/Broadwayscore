// Reader-facing thank-you copy: no em dashes (owner style rule for external
// copy, BRO-4452 cousin). Covers every type, named and anonymous.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildFeedbackThankYouEmail } = require('../../scripts/lib/email-templates.js');

test('thank-you emails contain no em dashes', () => {
  for (const type of ['fixed', 'praise', 'content', 'feature', 'acknowledged']) {
    for (const name of ['Jo', null]) {
      for (const show of ['Wicked', null]) {
        const { subject, html } = buildFeedbackThankYouEmail(type, name, show);
        assert.ok(subject && html, `${type} renders`);
        assert.doesNotMatch(subject + html, /—|&mdash;/, `${type}/${name}/${show}`);
      }
    }
  }
});
