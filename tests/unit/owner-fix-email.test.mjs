import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const {
  isReaderFeedbackIssue,
  shouldEmailOwnerOnFix,
  readerFromDiagnosis,
  buildReaderFixOwnerEmail,
  sendReaderFixOwnerEmail,
} = require('../../scripts/lib/owner-fix-email.js');

test('only reader-feedback issue ids count as reader feedback', () => {
  for (const id of ['504', '504-systematic', 504, ' 925 ']) {
    assert.equal(isReaderFeedbackIssue(id), true, String(id));
  }
  for (const id of ['bro-4431', 'bro-4431-f', 'BRO-4216', 'bro-4259-opening', 'ops-12', '', null, undefined, '504-x']) {
    assert.equal(isReaderFeedbackIssue(id), false, String(id));
  }
});

test('owner is emailed for reader-feedback fixes only', () => {
  const base = { ownerEmail: 'owner@example.com', appliedCount: 2 };
  assert.equal(shouldEmailOwnerOnFix({ ...base, issueNumber: '504' }), true);
  assert.equal(shouldEmailOwnerOnFix({ ...base, issueNumber: '504-systematic' }), true);
  assert.equal(shouldEmailOwnerOnFix({ ...base, issueNumber: 'bro-4431-f' }), false);
  assert.equal(shouldEmailOwnerOnFix({ ...base, issueNumber: '504', appliedCount: 0 }), false);
  assert.equal(shouldEmailOwnerOnFix({ ...base, issueNumber: '504', ownerEmail: '' }), false);
});

test('readerFromDiagnosis maps DIAGNOSIS_JSON fields and blanks', () => {
  assert.deepEqual(
    readerFromDiagnosis({ submitterName: ' Jo ', submitterEmail: 'jo@x.com', submitterShow: 'Wicked', originalMessage: 'Wrong date' }),
    { name: 'Jo', email: 'jo@x.com', show: 'Wicked', message: 'Wrong date' },
  );
  assert.deepEqual(
    readerFromDiagnosis({ submitterName: 'Anonymous', submitterEmail: '', submitterShow: null }),
    { name: null, email: null, show: null, message: null },
  );
  assert.deepEqual(readerFromDiagnosis(null), { name: null, email: null, show: null, message: null });
});

test('owner email carries the reader details and their message, escaped', () => {
  const { subject, html } = buildReaderFixOwnerEmail({
    issueNumber: '504',
    reader: { name: 'Jo <b>', email: 'jo+t@x.com', show: 'Wicked', message: 'Line one\n<script>x</script>' },
    summary: 'Closing date was wrong',
    changes: ['shows.json: closingDate = "2026-01-04"'],
    skipped: ['No combined roles found — already fixed'],
  });
  assert.equal(subject, 'Partly fixed: Wicked (reported by Jo <b>)', 'a non-empty "Not changed" list is never headlined "Fixed"');
  assert.match(html, /after the next update/);
  assert.match(html, /Jo &lt;b&gt;/);
  assert.match(html, /href="mailto:jo%2Bt@x\.com">jo\+t@x\.com</);
  assert.match(html, /Line one\n&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /Closing date was wrong/);
  assert.match(html, /closingDate/);
  assert.match(html, /issues\/504"/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(subject + html, /—/, 'no em dashes in owner email copy');
});

test('owner email keeps the reader message verbatim, says when details are missing', () => {
  const { subject, html } = buildReaderFixOwnerEmail({
    issueNumber: '504-systematic', reader: { message: 'Fix it — please' }, changes: ['x'], how: 'systematic', partial: true,
  });
  assert.equal(subject, 'Partly fixed: reader report (reported by A reader)');
  assert.match(html, /Fix it — please/);
  assert.match(html, /not given/);
  assert.match(html, /issues\/504"/);
  const full = buildReaderFixOwnerEmail({ issueNumber: '504', reader: { name: 'Jo', show: 'Wicked' }, changes: ['x'] });
  assert.equal(full.subject, 'Fixed: Wicked (reported by Jo)');
  const sys = buildReaderFixOwnerEmail({ issueNumber: '504-systematic', reader: { name: 'Jo', show: 'Wicked' }, changes: ['x'], how: 'systematic' });
  assert.equal(sys.subject, 'Fixed across shows: Wicked (reported by Jo)');
});

test('send is a no-op for session-authored plans and without credentials', async () => {
  const saved = { o: process.env.OWNER_EMAIL, k: process.env.RESEND_API_KEY };
  try {
    process.env.OWNER_EMAIL = 'owner@example.com';
    delete process.env.RESEND_API_KEY;
    assert.equal(await sendReaderFixOwnerEmail({ issueNumber: 'bro-4431-f', changes: ['x'] }), false);
    assert.equal(await sendReaderFixOwnerEmail({ issueNumber: '504', changes: ['x'] }), false);
    assert.equal(await sendReaderFixOwnerEmail({ issueNumber: '504', changes: [] }), false);
  } finally {
    if (saved.o === undefined) delete process.env.OWNER_EMAIL; else process.env.OWNER_EMAIL = saved.o;
    if (saved.k === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.k;
  }
});

test('both reader-fix paths send the owner email through the helper', () => {
  const exec = fs.readFileSync(new URL('../../scripts/execute-approved-fix.js', import.meta.url), 'utf8');
  assert.match(exec, /if \(shouldEmailOwnerOnFix\(/);
  assert.match(exec, /sendReaderFixOwnerEmail\(\{/);
  assert.doesNotMatch(exec, /Fix Applied: Issue #/);
  const auto = fs.readFileSync(new URL('../../scripts/auto-fix-feedback-bug.js', import.meta.url), 'utf8');
  assert.equal((auto.match(/await sendReaderFixOwnerEmail\(\{/g) || []).length, 2, 'awards path + main success path');
  const yml = fs.readFileSync(new URL('../../.github/workflows/auto-fix-feedback-bug.yml', import.meta.url), 'utf8');
  const step = yml.slice(yml.indexOf('- name: Run auto-fix'), yml.indexOf('run: node scripts/auto-fix-feedback-bug.js'));
  assert.match(step, /RESEND_API_KEY: \$\{\{ secrets\.RESEND_API_KEY \}\}/);
  assert.match(step, /OWNER_EMAIL: \$\{\{ secrets\.OWNER_EMAIL \}\}/);
});
