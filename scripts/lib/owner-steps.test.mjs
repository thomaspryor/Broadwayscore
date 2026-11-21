// BRO-7994: pins scripts/lib/owner-steps.js on the incident thread (2026-11-21). The four instructions the owner could
// not use are flagged; the owner-approved rewrite (link + numbered steps) and reply-only asks pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const s = require('./owner-steps.js');
const codes = (t) => s.lintOwnerSteps(t).map((p) => p.code);

const BRIEF = "You need to: In the Google console, add both broadwayscorecard.com addresses as authorized JavaScript origins on the web client starting 1084460721483-0vvpc, leaving the redirect URIs alone, then tell me when you've saved.";
const LIVE = 'Still running: nothing.\nYou need to: in Google Cloud Console, add https://broadwayscorecard.com and https://www.broadwayscorecard.com as allowed web addresses on the Google sign-in credentials the site uses.\n\nACTION NEEDED FROM YOU — add the two site addresses in Google Cloud Console so the desktop card can appear.';
const REWRITE = [
  "You're right. On your computer:",
  '1. Open this link: https://console.cloud.google.com/apis/credentials/oauthclient/1084460721483-abc.apps.googleusercontent.com?project=1084460721483',
  '2. You\'ll see a settings page. Scroll down to the box called **Authorized JavaScript origins**.',
  '3. Click **+ Add URI**. In the empty line that appears, paste: `https://broadwayscorecard.com`',
  '4. Click the blue **Save** button at the bottom.',
  '5. Reply "done" here.',
  '',
  'You need to: follow the steps above, then reply "done".',
].join('\n');

test('incident instructions are flagged', () => {
  assert.deepEqual(codes(BRIEF).sort(), ['jargon', 'no-link', 'no-seen']);
  const live = codes(LIVE);
  for (const c of ['no-link', 'jargon', 'no-seen']) assert.ok(live.includes(c), c);
});

test('a URL the owner is told to type is not a link to open', () => {
  assert.ok(codes(LIVE).includes('no-link'));
});

test('the owner-approved rewrite passes', () => {
  assert.deepEqual(codes(REWRITE), []);
});

test('chained actions in one step are flagged', () => {
  const t = 'You need to: do the steps above.\n1. Open https://console.cloud.google.com/apis/credentials\n2. Tap the menu at the top left, then tap "Credentials".\nYou\'ll see the list.';
  assert.ok(codes(t).includes('two-actions'));
});

test('reply-only asks and nothing-needed are not judged', () => {
  assert.deepEqual(codes('You need to: reply "yes" on the preview, or tell me what to change.'), []);
  assert.deepEqual(codes('You need to: nothing.'), []);
  assert.deepEqual(codes('Nothing needed from you.\nI checked the Google console settings in the report.'), []);
});

test('every recipe renders steps that pass its own lint', () => {
  for (const id of Object.keys(s.RECIPES)) {
    const out = s.render(id, { clientId: '1084460721483-abc.apps.googleusercontent.com', name: 'X_KEY' });
    assert.deepEqual(s.lintOwnerSteps(out), [], id);
    assert.match(out, /^1\. /m, id);
    assert.match(out, /https:\/\//, id);
  }
});

test('google recipe links straight to the web client the site uses', () => {
  const id = s.googleWebClientId({});
  assert.match(id, /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
  assert.match(s.render('google-js-origins'), new RegExp(`oauthclient/${id.replace(/\./g, '\\.')}\\?project=\\d+`));
  assert.equal(s.googleWebClientId({ NEXT_PUBLIC_GOOGLE_CLIENT_ID: '9-z.apps.googleusercontent.com' }), '9-z.apps.googleusercontent.com');
});

test('no recipe trips the Stop hook human-time-estimate gate (hours/days wording)', () => {
  // A recipe said "can take a few minutes to a few hours" and every closing built from it was blocked by
  // verify-edits.sh [VE:HUMAN_TIME_ESTIMATE]. Keep recipe text free of hour/day/week estimates.
  for (const id of Object.keys(s.RECIPES)) {
    const out = s.render(id, { clientId: '1084460721483-abc.apps.googleusercontent.com', name: 'X_KEY' });
    assert.doesNotMatch(out, /\b(?:a\s+few|several|couple(?:\s+of)?|\d+(?:[-–]\d+)?)\s+(?:hours?|days?|weeks?)\b/i, id);
  }
});

// Ship-check (Claude reviewer): asks about our own site or the board are not outside-site manual steps.
test('own-site and board asks are not outside asks; a chained clause still is', async () => {
  const { isManualOutsideAsk, ownerBlock } = (await import('node:module')).createRequire(import.meta.url)('./owner-steps.js');
  for (const m of [
    'You need to: open the preview and check the settings page: https://broadwayscorecard.com/settings',
    'You need to: sign in to the site with Google once: https://broadwayscorecard.com',
    'You need to: tap Approve on the Linear card.',
  ]) assert.equal(isManualOutsideAsk(ownerBlock(m)), false, m);
  assert.equal(isManualOutsideAsk(ownerBlock('You need to: approve the screenshots below, then open the Vercel dashboard and add the domain.')), true);
});
