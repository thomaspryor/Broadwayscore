// BRO-7693: every email we write to a reader ends with the owner's closing line,
// just above the sign-off. One check across every builder, so a new email type
// or an inline rewrite that drops the line fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { READER_REPLY_CLOSING_LINE } = require('./reader-reply-closing.js');
const drafts = require('./feedback-reply-drafts.js');
const sub = require('./submission-decision.js');

const endsWithClosing = (text, signOff) =>
  assert.ok(text.endsWith(`${READER_REPLY_CLOSING_LINE}\n\n${signOff}`), `missing closing line:\n${text}`);

test('every feedback reply type ends with the closing line', () => {
  for (const type of ['fixed', 'reviews-added', 'praise', 'content', 'feature', 'acknowledged']) {
    const { text } = drafts.buildReplyText(type, 'Sam', 'Hamilton', { url: 'https://broadwayscorecard.com/show/x' });
    endsWithClosing(text, 'Tom\nBroadway Scorecard™');
  }
});

test('every review-form email ends with the closing line', () => {
  endsWithClosing(sub.approvedEmailText('https://x.com/r'), 'Tom\nBroadway Scorecard™');
  endsWithClosing(sub.alreadyListedEmailText('https://x.com/r', null), 'Tom\nBroadway Scorecard™');
  for (const kind of ['no-url', 'not-a-review-page', 'other']) {
    endsWithClosing(sub.rejectEmailText(kind, 'https://x.com/r'), 'Tom\nBroadway Scorecard™');
  }
});

test('the review-submission workflow builds its approved email from the shared helper', async () => {
  const fs = await import('node:fs');
  const wf = fs.readFileSync(new URL('../../.github/workflows/process-review-submission.yml', import.meta.url), 'utf8');
  assert.ok(!/text:"Great news!/.test(wf), 'approved email text is inline again; use approvedEmailText()');
  assert.ok(wf.includes('d.approvedEmailText(e.REVIEW_URL)'));
});
