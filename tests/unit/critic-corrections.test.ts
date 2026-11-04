/** BRO-6984: correction requests store one row and email only the owner; mocked I/O, no real email. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitCorrection, kindForReason, type CorrectionRow } from '../../src/lib/critic-corrections';

function deps(opts: { insertOk?: boolean } = {}) {
  const rows: CorrectionRow[] = [];
  const emails: { subject: string; html: string; replyTo?: string }[] = [];
  return {
    rows, emails,
    d: {
      slug: 'jordan-ellis',
      criticName: 'Jordan <Ellis>',
      user: { id: 'u1', email: 'jordan@example.com' },
      ownReviews: new Map([['wicked-def', { showTitle: 'Wicked & Co', outlet: 'Daily', reviewScore: 72, url: 'https://example.com/w' }]]),
      insert: async (row: CorrectionRow) => { rows.push(row); return opts.insertOk ?? true; },
      emailOwner: async (subject: string, html: string, replyTo?: string) => { emails.push({ subject, html, replyTo }); return true; },
    },
  };
}

test('a review flag stores one row with the reason and emails the owner once, reply-to the critic', async () => {
  const { rows, emails, d } = deps();
  const r = await submitCorrection({ slug: 'jordan-ellis', reviewKey: 'wicked-def', reason: 'wrong_show', note: 'This is <b>Wicked</b> 2003', score: 100 }, d);
  assert.equal(r.status, 200);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'review_flag');
  assert.equal(rows[0].user_id, 'u1');
  assert.equal(rows[0].payload.reason, 'wrong_show');
  assert.equal(rows[0].payload.score, 72); // the stored score, never the body's
  assert.equal(emails.length, 1);
  assert.equal(emails[0].replyTo, 'jordan@example.com');
  assert.match(emails[0].html, /Wrong show/);
  assert.match(emails[0].html, /&lt;b&gt;Wicked&lt;\/b&gt;/); // note is escaped
  assert.match(emails[0].html, /Jordan &lt;Ellis&gt;/);
  assert.ok(!/<b>Wicked<\/b>/.test(emails[0].html));
});

test('wrong score keeps the original score_flag kind', async () => {
  assert.equal(kindForReason('wrong_score'), 'score_flag');
  assert.equal(kindForReason('not_mine'), 'review_flag');
  const { rows, d } = deps();
  await submitCorrection({ slug: 'jordan-ellis', reviewKey: 'wicked-def', reason: 'wrong_score' }, d);
  assert.equal(rows[0].kind, 'score_flag');
});

test('a missing-review request stores the link and emails the owner', async () => {
  const { rows, emails, d } = deps();
  const r = await submitCorrection({ kind: 'missing', slug: 'jordan-ellis', reviewUrl: 'https://example.com/new', note: 'in print' }, d);
  assert.equal(r.status, 200);
  assert.deepEqual(rows[0], { critic_slug: 'jordan-ellis', user_id: 'u1', kind: 'missing_review', payload: { reviewUrl: 'https://example.com/new', note: 'in print' } });
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /missing/);
});

test('nothing is stored or emailed for a bad request, and no email when storing fails', async () => {
  for (const body of [
    { slug: 'jordan-ellis', reviewKey: 'someone-elses', reason: 'not_mine' },
    { slug: 'other-critic', reviewKey: 'wicked-def', reason: 'not_mine' },
    { slug: 'jordan-ellis', reviewKey: 'wicked-def', reason: 'bogus' },
    { kind: 'missing', slug: 'jordan-ellis', reviewUrl: 'ftp://x' },
    { kind: 'missing', slug: 'other-critic', reviewUrl: 'https://example.com/r' },
  ]) {
    const { rows, emails, d } = deps();
    const r = await submitCorrection(body, d);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(rows.length + emails.length, 0);
  }
  const { emails, d } = deps({ insertOk: false });
  const r = await submitCorrection({ slug: 'jordan-ellis', reviewKey: 'wicked-def', reason: 'not_mine' }, d);
  assert.equal(r.status, 502);
  assert.equal(emails.length, 0);
});
