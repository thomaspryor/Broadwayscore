// Unit tests for scripts/lib/welcome-email.js (BRO-4620).
// Run: node --test scripts/lib/welcome-email.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const w = require('./welcome-email.js');

const EMAIL = 'someone@example.com';

test('subject and preheader match the approved copy', () => {
  const { subject, html } = w.buildWelcomeEmail({ displayName: 'Ada Lovelace', email: EMAIL });
  assert.equal(subject, 'Welcome to Broadway Scorecard');
  assert.equal(w.PREHEADER, "Your diary, your watchlist, and how to bring over the shows you've already logged.");
  // Preheader is the hidden div right after <body>; escapeHtml leaves apostrophes alone.
  assert.match(html, /<div style="display:none[^"]*">Your diary, your watchlist, and how to bring over the shows you've already logged\.<\/div>/);
});

test('renders with a name: first word of the display name', () => {
  const { html, text } = w.buildWelcomeEmail({ displayName: '  Ada   Lovelace ', email: EMAIL });
  assert.match(html, /<h1[^>]*>Welcome, Ada\.<\/h1>/);
  assert.ok(text.startsWith('Welcome, Ada.\n'));
});

test('renders without a name', () => {
  for (const displayName of [undefined, null, '', '   ']) {
    const { html, text } = w.buildWelcomeEmail({ displayName, email: EMAIL });
    assert.match(html, /<h1[^>]*>Welcome to Broadway Scorecard\.<\/h1>/, `displayName=${JSON.stringify(displayName)}`);
    assert.ok(text.startsWith('Welcome to Broadway Scorecard.\n'));
  }
});

test('escapes the name and the email', () => {
  const { html } = w.buildWelcomeEmail({
    displayName: '<script>alert(1)</script> Evil',
    email: 'x<img src=y>@example.com',
  });
  assert.ok(!html.includes('<script>'), 'raw <script> leaked');
  assert.ok(!html.includes('<img src=y>'), 'raw <img> leaked');
  assert.match(html, /Welcome, &lt;script&gt;alert\(1\)&lt;\/script&gt;\./);
  assert.ok(html.includes('x&lt;img src=y&gt;@example.com'));
});

test('contains all three steps, the button, sign-off and footer', () => {
  const { html, text } = w.buildWelcomeEmail({ displayName: 'Ada', email: EMAIL });
  for (const s of ["Rate the shows you've seen", 'Bring your history over', 'Keep a watchlist',
    'Three ways to start', 'Open My Shows', 'Reply to this email. It comes straight to me.',
    'Follow Broadway Scorecard']) {
    assert.ok(html.includes(s), `html missing: ${s}`);
  }
  assert.ok(html.includes(`created a Broadway Scorecard account with ${EMAIL}.`));
  assert.ok(text.includes(`created a Broadway Scorecard account with ${EMAIL}.`));
  assert.ok(text.includes('THREE WAYS TO START'));
  assert.ok(text.includes('\nThomas\nBroadway Scorecard\n'));
});

test('button links to My Shows with welcome UTMs', () => {
  const { html, text } = w.buildWelcomeEmail({ displayName: 'Ada', email: EMAIL });
  const u = new URL(w.MY_SHOWS_URL);
  assert.equal(u.origin + u.pathname, 'https://broadwayscorecard.com/my-shows');
  assert.equal(u.searchParams.get('utm_source'), 'email');
  assert.equal(u.searchParams.get('utm_medium'), 'welcome');
  assert.equal(u.searchParams.get('utm_campaign'), 'welcome');
  assert.ok(html.includes(`href="${w.MY_SHOWS_URL.replace(/&/g, '&amp;')}"`));
  assert.ok(text.includes(w.MY_SHOWS_URL));
});

test('no em dashes or en dashes anywhere in the copy', () => {
  const { subject, html, text } = w.buildWelcomeEmail({ displayName: 'Ada', email: EMAIL });
  for (const [name, s] of [['subject', subject], ['html', html], ['text', text], ['preheader', w.PREHEADER]]) {
    assert.ok(!/[—–]|&mdash;|&ndash;|&#8212;|&#8211;/.test(s), `${name} has a dash`);
  }
});

test('kill switch: the committed default is OFF', () => {
  // Turning sending on is a deliberate one-line change; a test pins the default
  // so it can't flip by accident in an unrelated commit. Update this test in
  // the same commit that turns sending on.
  assert.equal(w.WELCOME_EMAIL_SEND_FROM, null);
  assert.equal(w.windowStart({ sendFrom: w.WELCOME_EMAIL_SEND_FROM }), null);
});

test('kill switch blocks sends (null, empty and malformed all count as off)', async () => {
  for (const sendFrom of [null, undefined, '', 'not-a-date']) {
    let claimed = false; let sent = false;
    const r = await w.sendWelcomeOnce({ id: 'u1', email: EMAIL }, {
      sendFrom,
      claim: async () => { claimed = true; return true; },
      release: async () => {},
      send: async () => { sent = true; },
    });
    assert.equal(r.status, 'off', `sendFrom=${sendFrom}`);
    assert.equal(claimed, false);
    assert.equal(sent, false);
  }
});

function fakeStore() {
  const claims = new Set();
  return {
    claims,
    claim: async (id) => { if (claims.has(id)) return false; claims.add(id); return true; },
    release: async (id) => { claims.delete(id); },
  };
}

test('once-only: an already-claimed account is refused and not sent', async () => {
  const store = fakeStore();
  const sends = [];
  const deps = { sendFrom: '2026-10-05T00:00:00Z', ...store, send: async (u) => { sends.push(u.id); } };
  const user = { id: 'u1', email: EMAIL };
  assert.equal((await w.sendWelcomeOnce(user, deps)).status, 'sent');
  assert.equal((await w.sendWelcomeOnce(user, deps)).status, 'already-sent');
  // Two overlapping runs racing on the same account: only one wins the claim.
  const store2 = fakeStore();
  const sends2 = [];
  const deps2 = { sendFrom: '2026-10-05T00:00:00Z', ...store2, send: async (u) => { sends2.push(u.id); } };
  const results = await Promise.all([w.sendWelcomeOnce(user, deps2), w.sendWelcomeOnce(user, deps2)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['already-sent', 'sent']);
  assert.deepEqual(sends, ['u1']);
  assert.deepEqual(sends2, ['u1']);
});

test('a failed send releases the claim and rethrows, so a later run retries', async () => {
  const store = fakeStore();
  const user = { id: 'u2', email: EMAIL };
  await assert.rejects(
    w.sendWelcomeOnce(user, { sendFrom: '2026-10-05T00:00:00Z', ...store, send: async () => { throw new Error('HTTP 500'); } }),
    /HTTP 500/,
  );
  assert.equal(store.claims.has('u2'), false);
  const r = await w.sendWelcomeOnce(user, { sendFrom: '2026-10-05T00:00:00Z', ...store, send: async () => {} });
  assert.equal(r.status, 'sent');
});

test('windowStart: later of the switch time and the max-age cutoff', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  // Switch flipped long ago: max-age window wins.
  assert.equal(w.windowStart({ sendFrom: '2026-01-01T00:00:00Z', now, maxAgeDays: 3 }).toISOString(), '2026-10-07T00:00:00.000Z');
  // Switch flipped recently: accounts before the switch are excluded.
  assert.equal(w.windowStart({ sendFrom: '2026-10-09T12:00:00Z', now, maxAgeDays: 3 }).toISOString(), '2026-10-09T12:00:00.000Z');
});

test('sendAllowance respects the daily and per-run caps', () => {
  assert.equal(w.sendAllowance({ sentLast24h: 0, dailyCap: 25, perRunCap: 10 }), 10);
  assert.equal(w.sendAllowance({ sentLast24h: 20, dailyCap: 25, perRunCap: 10 }), 5);
  assert.equal(w.sendAllowance({ sentLast24h: 30, dailyCap: 25, perRunCap: 10 }), 0);
});

test('idempotency key is stable per account', () => {
  assert.equal(w.idempotencyKeyFor('abc'), w.idempotencyKeyFor('abc'));
  assert.notEqual(w.idempotencyKeyFor('abc'), w.idempotencyKeyFor('abd'));
});
