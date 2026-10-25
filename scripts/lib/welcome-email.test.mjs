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
    'Three ways to start', 'Open My Shows', 'Accounts are brand new, and Broadway Scorecard is a labor of love',
    'reply to this email and tell me. It comes straight to me', 'Ideas are welcome too.',
    'Show Score, Mezzanine or Theatr?', 'Follow Broadway Scorecard']) {
    assert.ok(html.includes(s), `html missing: ${s}`);
  }
  assert.ok(text.includes(`It comes straight to me, and I'll fix it. Ideas are welcome too.`));
  assert.ok(!html.includes('Thomas') && !text.includes('Thomas'), 'sign-off is Tom');
  assert.ok(html.includes(`created a Broadway Scorecard account with ${EMAIL}.`));
  assert.ok(text.includes(`created a Broadway Scorecard account with ${EMAIL}.`));
  assert.ok(text.includes('THREE WAYS TO START'));
  assert.ok(text.includes('\nTom\nBroadway Scorecard\n'));
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

test('kill switch: the committed value is ON since 2026-10-05T01:33:00Z', () => {
  // Turning sending on or off is a deliberate one-line change; a test pins the
  // committed value so it can't flip by accident in an unrelated commit. Update
  // this test in the same commit that changes the switch.
  assert.equal(w.WELCOME_EMAIL_SEND_FROM, '2026-10-05T01:33:00Z');
  const start = w.windowStart({ sendFrom: w.WELCOME_EMAIL_SEND_FROM });
  assert.ok(start instanceof Date, 'a committed ON value must parse');
  assert.ok(start.getTime() >= Date.parse(w.WELCOME_EMAIL_SEND_FROM), 'never reaches back before the switch time');
});

test('kill switch blocks sends (null, empty and malformed all count as off)', async () => {
  for (const sendFrom of [null, undefined, '', 'not-a-date', '1', '2026-10-05', '2026-10-05T09:00:00', '2026-10-05 09:00:00Z', 1759654800000]) {
    let claimed = false; let sent = false;
    const r = await w.sendWelcomeOnce({ id: 'u1', email: EMAIL }, {
      sendFrom,
      claim: async () => { claimed = true; return true; },
      release: async () => {},
      send: async () => { sent = true; return OK; },
    });
    assert.equal(r.status, 'off', `sendFrom=${sendFrom}`);
    assert.equal(claimed, false);
    assert.equal(sent, false);
  }
});

const OK = { statusCode: 200, body: '{"id":"re_123"}' };

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
  const deps = { sendFrom: '2026-10-05T00:00:00Z', ...store, send: async (u) => { sends.push(u.id); return OK; } };
  const user = { id: 'u1', email: EMAIL };
  assert.equal((await w.sendWelcomeOnce(user, deps)).status, 'sent');
  assert.equal((await w.sendWelcomeOnce(user, deps)).status, 'already-sent');
  // Two overlapping runs racing on the same account: only one wins the claim.
  const store2 = fakeStore();
  const sends2 = [];
  const deps2 = { sendFrom: '2026-10-05T00:00:00Z', ...store2, send: async (u) => { sends2.push(u.id); return OK; } };
  const results = await Promise.all([w.sendWelcomeOnce(user, deps2), w.sendWelcomeOnce(user, deps2)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['already-sent', 'sent']);
  assert.deepEqual(sends, ['u1']);
  assert.deepEqual(sends2, ['u1']);
});

test('a retryable failure (5xx, 429, network) releases the claim and throws, so a later run retries', async () => {
  for (const res of [{ statusCode: 500, body: 'oops' }, { statusCode: 429, body: 'slow down' }, { statusCode: 0, body: 'request error: ECONNRESET' }]) {
    const store = fakeStore();
    const user = { id: 'u2', email: EMAIL };
    await assert.rejects(
      w.sendWelcomeOnce(user, { sendFrom: '2026-10-05T00:00:00Z', ...store, send: async () => res }),
      new RegExp(`HTTP ${res.statusCode}`),
    );
    assert.equal(store.claims.has('u2'), false, `claim released after HTTP ${res.statusCode}`);
    const r = await w.sendWelcomeOnce(user, { sendFrom: '2026-10-05T00:00:00Z', ...store, send: async () => OK });
    assert.equal(r.status, 'sent');
  }
});

test('a thrown send (unexpected error) also releases the claim', async () => {
  const store = fakeStore();
  await assert.rejects(
    w.sendWelcomeOnce({ id: 'u3', email: EMAIL }, { sendFrom: '2026-10-05T00:00:00Z', ...store, send: async () => { throw new Error('boom'); } }),
    /boom/,
  );
  assert.equal(store.claims.has('u3'), false);
});

test('409 invalid_idempotent_request means it already went out: counted as sent, claim kept', async () => {
  const store = fakeStore();
  const recorded = [];
  const r = await w.sendWelcomeOnce({ id: 'u4', email: EMAIL }, {
    sendFrom: '2026-10-05T00:00:00Z', ...store,
    send: async () => ({ statusCode: 409, body: '{"name":"invalid_idempotent_request"}' }),
    recordSent: async (id, rid) => recorded.push([id, rid]),
  });
  assert.equal(r.status, 'sent');
  assert.equal(store.claims.has('u4'), true);
  assert.deepEqual(recorded, [['u4', null]]);
});

test('409 concurrent_idempotent_requests is retried later (claim released, key protects)', async () => {
  const store = fakeStore();
  await assert.rejects(w.sendWelcomeOnce({ id: 'u5', email: EMAIL }, {
    sendFrom: '2026-10-05T00:00:00Z', ...store,
    send: async () => ({ statusCode: 409, body: '{"name":"concurrent_idempotent_requests"}' }),
  }), /HTTP 409/);
  assert.equal(store.claims.has('u5'), false);
});

test('setup errors (403 domain, 422 on from/reply_to, 401 key) halt the run and release the claim', async () => {
  for (const res of [
    { statusCode: 403, body: '{"name":"validation_error","message":"The broadwayscorecard.com domain is not verified."}' },
    { statusCode: 422, body: '{"name":"validation_error","message":"Invalid `reply_to` field."}' },
    { statusCode: 422, body: '{"name":"validation_error","message":"Invalid `from` field."}' },
    { statusCode: 401, body: '{"name":"missing_api_key"}' },
  ]) {
    const store = fakeStore();
    const rejectedCalls = [];
    const r = await w.sendWelcomeOnce({ id: 'u8', email: EMAIL }, {
      sendFrom: '2026-10-05T00:00:00Z', ...store, send: async () => res,
      recordRejected: async (id) => rejectedCalls.push(id),
    });
    assert.equal(r.status, 'halt', res.body);
    assert.equal(store.claims.has('u8'), false, 'claim released so the account is retried once setup is fixed');
    assert.deepEqual(rejectedCalls, []);
  }
});

test('a permanent rejection (422) keeps the claim, records a redacted reason, never retries', async () => {
  const store = fakeStore();
  const reasons = [];
  const r = await w.sendWelcomeOnce({ id: 'u6', email: EMAIL }, {
    sendFrom: '2026-10-05T00:00:00Z', ...store,
    send: async () => ({ statusCode: 422, body: `{"message":"Invalid \`to\` field: ${EMAIL}"}` }),
    recordRejected: async (id, reason) => reasons.push(reason),
  });
  assert.equal(r.status, 'rejected');
  assert.equal(store.claims.has('u6'), true);
  assert.equal(reasons.length, 1);
  assert.ok(!reasons[0].includes(EMAIL), 'reason must not carry the address');
  assert.ok(reasons[0].includes('[email]'));
  const again = await w.sendWelcomeOnce({ id: 'u6', email: EMAIL }, { sendFrom: '2026-10-05T00:00:00Z', ...store, send: async () => OK });
  assert.equal(again.status, 'already-sent');
});

test('a successful send records the Resend id', async () => {
  const store = fakeStore();
  const recorded = [];
  await w.sendWelcomeOnce({ id: 'u7', email: EMAIL }, {
    sendFrom: '2026-10-05T00:00:00Z', ...store, send: async () => OK,
    recordSent: async (id, rid) => recorded.push([id, rid]),
  });
  assert.deepEqual(recorded, [['u7', 're_123']]);
});

test('redactEmails strips addresses, including Apple relay ones', () => {
  assert.equal(w.redactEmails('to abc.def@privaterelay.appleid.com failed'), 'to [email] failed');
  assert.equal(w.redactEmails('<x+y@example.co.uk>'), '<[email]>');
  assert.equal(w.redactEmails('no address here'), 'no address here');
});

test('windowStart: later of the switch time and the max-age cutoff', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  // Switch flipped long ago: max-age window wins.
  assert.equal(w.windowStart({ sendFrom: '2026-01-01T00:00:00Z', now, maxAgeHours: 20 }).toISOString(), '2026-10-09T04:00:00.000Z');
  // Switch flipped recently: accounts before the switch are excluded.
  assert.equal(w.windowStart({ sendFrom: '2026-10-09T12:00:00Z', now, maxAgeHours: 20 }).toISOString(), '2026-10-09T12:00:00.000Z');
});

test('retry window stays inside Resend\'s 24h idempotency window', () => {
  assert.ok(w.MAX_ACCOUNT_AGE_HOURS < 24);
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

test('footer tells new account holders they also get the opening night emails (BRO-4893)', () => {
  const { text, html } = w.buildWelcomeEmail({ displayName: 'Ann Lee', email: 'ann@example.com' });
  assert.match(text, /also gets our opening night emails/);
  assert.match(html, /also gets our opening night emails/);
});
