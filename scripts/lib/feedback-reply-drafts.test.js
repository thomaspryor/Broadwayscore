// BRO-7693: no reader email goes out unless its kind is in FEEDBACK_AUTO_REPLY_KINDS.
const assert = require('assert');
const {
  decideReplyMode, buildReplyText, buildOwnerDraftEmail, sendReplyOrDraft, draftReviewsAddedReplies,
} = require('./feedback-reply-drafts');

const READER = { name: 'Marianne', email: 'marianne@example.com', show: 'Gotta Dance' };
const OWNER = 'owner@example.com';

(async () => {
  // Default is draft for every kind, including the one that may later go auto.
  for (const kind of [undefined, null, '', 'missing-reviews', 'missing-show', 'bug']) {
    assert.strictEqual(decideReplyMode(kind, {}), 'draft', `kind ${kind} must default to draft`);
    assert.strictEqual(decideReplyMode(kind, { FEEDBACK_AUTO_REPLY_KINDS: '' }), 'draft');
    assert.strictEqual(decideReplyMode(kind, { FEEDBACK_AUTO_REPLY_KINDS: '  , ' }), 'draft');
  }
  // Auto only for an explicitly listed kind (case/space tolerant).
  assert.strictEqual(decideReplyMode('missing-reviews', { FEEDBACK_AUTO_REPLY_KINDS: 'Missing-Reviews' }), 'auto');
  assert.strictEqual(decideReplyMode('missing-reviews', { FEEDBACK_AUTO_REPLY_KINDS: 'a, missing-reviews' }), 'auto');
  assert.strictEqual(decideReplyMode('missing-show', { FEEDBACK_AUTO_REPLY_KINDS: 'missing-reviews' }), 'draft');

  // Reply text: no em dashes, greeting and show used, link appended.
  for (const t of ['fixed', 'reviews-added', 'praise', 'content', 'feature', 'acknowledged']) {
    const r = buildReplyText(t, 'Marianne', 'Gotta Dance', { url: 'https://broadwayscorecard.com/show/gotta-dance' });
    assert.ok(!/—|–/.test(r.subject + r.text), `${t}: no dashes`);
    assert.ok(r.text.startsWith('Hi Marianne,'), `${t}: greeting`);
    assert.ok(r.text.endsWith('Tom\nBroadway Scorecard™'), `${t}: signature`);
  }
  assert.ok(buildReplyText('fixed', null, null).text.startsWith('Hi there,'));
  assert.ok(buildReplyText('fixed', 'A', 'S', { url: 'https://x.test/s' }).text.includes('https://x.test/s'));

  // BRO-7693 gap 2: missing-reviews entries going live get ONE owner draft.
  {
    const sent = [];
    const transport = async (p) => { sent.push(p); };
    const store = { s1: { name: 'Marianne', email: 'marianne@example.com', show: 'Gotta Dance', message: 'Where are the reviews?' }, s3: { name: null, email: null } };
    const lookupReader = (id) => store[id] || null;
    const env = { OWNER_EMAIL: OWNER }; // FEEDBACK_AUTO_REPLY_KINDS empty
    const live = [
      { entry: { key: 'k1', kind: 'missing-reviews', submissionId: 's1', title: 'Gotta Dance' }, url: 'https://broadwayscorecard.com/show/gotta-dance' },
      { entry: { key: 'k2', kind: 'missing-show', submissionId: 's1' }, url: 'u' },
      { entry: { key: 'k3', kind: 'missing-reviews', submissionId: 's3' }, url: 'u' },
      { entry: { key: 'k4', kind: 'missing-reviews', submissionId: 's1', replyDraftedAt: '2026-11-17T00:00:00Z' }, url: 'u' },
      { entry: { key: 'k5', kind: 'missing-reviews', submissionId: 'gone' }, url: 'u' },
    ];
    const res = await draftReviewsAddedReplies(live, { lookupReader, transport, env, now: () => 'NOW' });
    assert.deepStrictEqual(res.map((r) => `${r.key}:${r.status}`), ['k1:drafted', 'k3:skipped', 'k4:skipped', 'k5:skipped']);
    assert.strictEqual(sent.length, 1, 'exactly one email');
    assert.deepStrictEqual(sent[0].to, [OWNER], 'draft goes to OWNER_EMAIL only, never the reader');
    assert.strictEqual(sent[0].reply_to, 'marianne@example.com');
    assert.ok(sent[0].text.includes('The reviews are now on the site') && sent[0].text.includes('/show/gotta-dance'));
    assert.ok(sent[0].text.includes('Nothing has been sent to the reader'));
    assert.strictEqual(live[0].entry.replyDraftedAt, 'NOW');
    // Re-run: already drafted, no second email.
    const again = await draftReviewsAddedReplies(live, { lookupReader, transport, env });
    assert.strictEqual(again[0].reason, 'already-drafted');
    assert.strictEqual(sent.length, 1);
    // No owner address: nothing is sent, entry stays undrafted so it retries.
    const l2 = [{ entry: { key: 'k6', kind: 'missing-reviews', submissionId: 's1' }, url: 'u' }];
    const r2 = await draftReviewsAddedReplies(l2, { lookupReader, transport, env: {} });
    assert.strictEqual(r2[0].reason, 'no-owner-email');
    assert.strictEqual(l2[0].entry.replyDraftedAt, undefined);
    assert.strictEqual(sent.length, 1);
    // Transport failure is reported, not thrown, and not marked.
    const l3 = [{ entry: { key: 'k7', kind: 'missing-reviews', submissionId: 's1' }, url: 'u' }];
    const r3 = await draftReviewsAddedReplies(l3, { lookupReader, transport: async () => { throw new Error('boom'); }, env });
    assert.strictEqual(r3[0].status, 'failed');
    assert.strictEqual(l3[0].entry.replyDraftedAt, undefined);
    assert.strictEqual(l3[0].entry.replyDraftRetry, true, 'failed draft is flagged for retry');
    const r4 = await draftReviewsAddedReplies(l3, { lookupReader, transport, env, now: () => 'LATER' });
    assert.strictEqual(r4[0].status, 'drafted');
    assert.strictEqual(l3[0].entry.replyDraftRetry, undefined);
    assert.strictEqual(sent.length, 2);
  }

  // Owner draft carries to/subject/body, the mailto link and the quoted original.
  const reply = buildReplyText('fixed', READER.name, READER.show);
  const d = buildOwnerDraftEmail({ reader: READER, reply, originalMessage: 'The closing date is wrong\nit says Aug' });
  assert.strictEqual(d.subject, 'Draft reply: Marianne (Gotta Dance)');
  assert.ok(d.text.includes('To: marianne@example.com') && d.text.includes(`Subject: ${reply.subject}`));
  assert.ok(d.text.includes('> The closing date is wrong\n> it says Aug'));
  assert.ok(d.mailto.startsWith('mailto:marianne%40example.com?subject=') && d.mailto.includes('&body='));
  assert.ok(d.html.includes('Open as email') && d.html.includes('The closing date is wrong'));
  // HTML-escapes reader-controlled text.
  const evil = buildOwnerDraftEmail({ reader: { ...READER, name: '<b>x</b>' }, reply, originalMessage: '<script>1</script>' });
  assert.ok(!evil.html.includes('<script>') && !evil.html.includes('<b>x</b>'));

  // Default mode: exactly one email, to the owner only, reply_to the reader.
  let sent = [];
  const transport = async (p) => { sent.push(p); };
  let res = await sendReplyOrDraft({ kind: 'missing-reviews', type: 'content', reader: READER, originalMessage: 'hi', env: { OWNER_EMAIL: OWNER }, transport });
  assert.deepStrictEqual(res, { mode: 'draft', sent: true, recipient: 'owner' });
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].to, [OWNER]);
  assert.strictEqual(sent[0].reply_to, READER.email);
  assert.ok(!JSON.stringify(sent[0].to).includes(READER.email));

  // No owner address: send nothing, never fall back to the reader.
  sent = [];
  res = await sendReplyOrDraft({ kind: 'bug', type: 'fixed', reader: READER, env: {}, transport });
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, 'no-owner-email');
  assert.strictEqual(sent.length, 0);

  // No reader email: nothing sent.
  res = await sendReplyOrDraft({ kind: 'bug', type: 'fixed', reader: { name: 'x' }, env: { OWNER_EMAIL: OWNER }, transport });
  assert.strictEqual(res.sent, false);
  assert.strictEqual(sent.length, 0);

  // Auto only via the switch: this is the sole path that addresses the reader.
  res = await sendReplyOrDraft({ kind: 'missing-reviews', type: 'reviews-added', reader: READER, env: { OWNER_EMAIL: OWNER, FEEDBACK_AUTO_REPLY_KINDS: 'missing-reviews' }, transport });
  assert.deepStrictEqual(res, { mode: 'auto', sent: true, recipient: 'reader' });
  assert.deepStrictEqual(sent[0].to, [READER.email]);

  // Guard: the committed config must keep the switch empty.
  const fs = require('fs'); const path = require('path');
  const root = path.join(__dirname, '../..');
  const wfDir = path.join(root, '.github/workflows');
  for (const f of fs.readdirSync(wfDir).filter((n) => n.endsWith('.yml'))) {
    const src = fs.readFileSync(path.join(wfDir, f), 'utf8');
    for (const m of src.matchAll(/FEEDBACK_AUTO_REPLY_KINDS:\s*(.*)/g)) {
      const v = m[1].trim();
      assert.ok(/^\$\{\{\s*vars\.FEEDBACK_AUTO_REPLY_KINDS\s*\}\}$/.test(v) || v === "''" || v === '""',
        `${f}: FEEDBACK_AUTO_REPLY_KINDS must stay empty or come from the repo variable, got ${v}`);
    }
  }
  // Class guard: the old direct-to-reader builder must not come back. Reader
  // replies are built only by feedback-reply-drafts.js, which defaults to draft.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]);
  const offenders = [...walk(path.join(root, 'scripts')), ...walk(wfDir)]
    .filter((f) => !f.endsWith('feedback-reply-drafts.test.js'))
    .filter((f) => /buildFeedbackThankYouEmail/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(offenders, [], 'buildFeedbackThankYouEmail was removed (BRO-7693); use sendReplyOrDraft');
  console.log('feedback-reply-drafts OK');
})().catch((e) => { console.error(e); process.exit(1); });
