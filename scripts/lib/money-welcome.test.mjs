// BRO-7995: the welcome email must stay a plain, personal-looking note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const w = createRequire(import.meta.url)('./money-welcome.js');

test('welcome email is plain text only, signed Tom, with one question and a one-line footer', () => {
  const m = w.buildWelcomeEmail({ email: 'Fan@Example.org' });
  assert.equal(m.html, undefined, 'no HTML part: it must not look like a styled marketing email');
  assert.match(m.text, /\nTom\n/);
  assert.equal((m.text.split('\n--\n')[0].match(/\?/g) || []).length, 1, 'exactly one question');
  assert.doesNotMatch(m.text, /—/, 'no em dashes');
  assert.match(m.text, /--\nYou signed up at broadwayscorecard\.com\/biz\. Unsubscribe: https:\/\/broadwayscorecard\.com\/api\/unsubscribe\?list=money&email=fan%40example\.org\n$/);
  assert.match(m.headers['List-Unsubscribe-Post'], /One-Click/);
  assert.doesNotMatch(m.subject, /welcome/i);
  assert.doesNotMatch(w.FROM, /Broadway Scorecard</, 'sender reads as a person');
});
