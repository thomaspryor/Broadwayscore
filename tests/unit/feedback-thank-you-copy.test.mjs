// Reader-facing thank-you copy: no em dashes (owner style rule for external
// copy, BRO-4452 cousin). Covers every type, named and anonymous.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildFeedbackThankYouEmail, buildFixApprovalEmail } = require('../../scripts/lib/email-templates.js');

test('fix-approval email names the reader with their email when given (BRO-4452)', () => {
  const base = {
    submitterName: 'Jo', showTitle: 'Wicked', originalMessage: 'Wrong date',
    planSummary: 'Fix the date', planSteps: ['Set closingDate'], riskLevel: 'low',
    currentState: [], verification: null, approveUrl: 'https://a', rejectUrl: 'https://r', issueNumber: 504,
  };
  const { html } = buildFixApprovalEmail({ ...base, submitterEmail: 'jo+t@x.com' });
  assert.match(html, /Jo \(<a href="mailto:jo%2Bt@x\.com">jo\+t@x\.com<\/a>\) wrote in about Wicked/);
  assert.doesNotMatch(html, /&mdash;|—/);
  const anon = buildFixApprovalEmail({ ...base, submitterName: 'Anonymous', submitterEmail: null });
  assert.match(anon.html, /Someone wrote in about Wicked/);
});

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
