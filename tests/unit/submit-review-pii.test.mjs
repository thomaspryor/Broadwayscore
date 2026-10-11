/**
 * BRO-4454 — /submit-review used to write the submitter's email in plaintext
 * into an issue on the PUBLIC thomaspryor/Broadwayscore repo. It is now sealed
 * with scripts/lib/submitter-contact.js and only the notify steps of
 * process-review-submission.yml decrypt it.
 *
 * Requires the real helper, the real issue parser and runs the REAL notify
 * step scripts from the workflow file (curl replaced by a recorder on PATH),
 * so a change to any of them is exercised here.
 *
 * The route-level check (the real POST handler) lives in
 * src/app/api/__tests__/submit-review-pii-route.test.mjs (tsx manifest).
 *
 * Run: node --test tests/unit/submit-review-pii.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contact = require(path.join(ROOT, 'scripts/lib/submitter-contact.js'));
// The CLI also refuses a token that decrypts to an address it will not send to
// without claiming a decrypt failure (exit 0, not 3).
const { firstRealEmail } = require(path.join(ROOT, 'scripts/lib/pii-scan.js'));
const yaml = require('js-yaml');

const tmpDirs = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const SECRET = 'test-approval-hmac-secret';
const EMAIL = 'jane.doe+bsc@example.org';
const CLI = path.join(ROOT, 'scripts/lib/submitter-contact-cli.js');

function issueBody(contactLines) {
  return [
    '### Review URL', 'https://www.nytimes.com/2026/10/01/theater/hamilton-review.html', '',
    '### Show Name', 'Hamilton', '',
    '### Outlet Name', 'NYT', '',
    '### Critic Name', '_No response_', '',
    '### Additional Notes', 'Great review.', '',
    ...contactLines, '',
    '---', '_Submitted via broadwayscorecard.com/submit-review_',
  ].join('\n');
}

test('sealed contact section carries no email and round-trips with the right secret only', () => {
  const lines = contact.formatContactSection(EMAIL, SECRET);
  const body = issueBody(lines);
  assert.equal(lines[0], contact.CONTACT_HEADING);
  assert.equal(firstRealEmail(body), null, 'issue body must contain no email address');
  assert.ok(!body.includes('jane.doe'), 'no fragment of the local part either');
  assert.equal(contact.extractSubmitterEmail(body, SECRET), EMAIL);
  assert.equal(contact.extractSubmitterEmail(body, 'some-other-secret'), null);
  assert.equal(contact.extractSubmitterEmail(body, undefined), null);
});

test('encryption is randomized and tampering is rejected', () => {
  const a = contact.encryptContact(EMAIL, SECRET);
  const b = contact.encryptContact(EMAIL, SECRET);
  assert.notEqual(a, b, 'random IV per submission');
  const flipped = a.slice(0, -2) + (a.slice(-2) === 'AA' ? 'BB' : 'AA');
  assert.equal(contact.decryptContact(flipped, SECRET), null);
  assert.equal(contact.decryptContact('v1.', SECRET), null);
  assert.equal(contact.decryptContact('not-a-token', SECRET), null);
});

test('fails closed: no secret means the email is dropped, never written in plaintext', () => {
  const lines = contact.formatContactSection(EMAIL, undefined);
  assert.deepEqual(lines, [contact.CONTACT_HEADING, contact.NOT_STORED]);
  assert.deepEqual(contact.formatContactSection('', SECRET), [contact.CONTACT_HEADING, contact.NO_RESPONSE]);
  assert.equal(contact.extractSubmitterEmail(issueBody(lines), SECRET), null);
});

test('legacy plaintext issues (filed before BRO-4454) still resolve so their outcome emails go out', () => {
  const body = issueBody([contact.LEGACY_EMAIL_HEADING, EMAIL]);
  assert.equal(contact.extractSubmitterEmail(body, SECRET), EMAIL);
  assert.equal(contact.extractSubmitterEmail(issueBody([contact.LEGACY_EMAIL_HEADING, '_No response_']), SECRET), null);
});

test('a contact heading pasted into the notes cannot redirect the outcome email', () => {
  const other = contact.encryptContact('victim@example.com', SECRET);
  const spoof = issueBody(contact.formatContactSection(EMAIL, SECRET))
    .replace('Great review.', `${contact.CONTACT_HEADING}\n${other}`);
  assert.equal(contact.extractSubmitterEmail(spoof, SECRET), EMAIL);
});

test('an address that could break the notify JSON payload is refused', () => {
  for (const bad of ['x@example.com", "bcc": ["evil@example.com', 'a b@example.com', '<x@example.com>', 'x@example', '']) {
    const body = issueBody(contact.formatContactSection(bad, SECRET));
    assert.equal(contact.extractSubmitterEmail(body, SECRET), null, `refused: ${JSON.stringify(bad)}`);
  }
});

test('validate-review-submission parser no longer swallows the contact section into notes', () => {
  const { parseIssueBody } = require(path.join(ROOT, 'scripts/lib/review-submission-issue.js'));
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/validate-review-submission.js'), 'utf8'),
    /const \{ parseIssueBody \} = reviewSubmissionIssue;/, 'validator uses the shared parser');
  const legacy = parseIssueBody(issueBody([contact.LEGACY_EMAIL_HEADING, EMAIL]));
  assert.equal(legacy.additionalNotes, 'Great review.');
  assert.equal(firstRealEmail(JSON.stringify(legacy)), null, 'parsed data is logged publicly; no email allowed');
  const empty = parseIssueBody(issueBody([contact.LEGACY_EMAIL_HEADING, EMAIL]).replace('Great review.', '_No response_'));
  assert.equal(empty.additionalNotes, undefined);
  const multi = parseIssueBody(issueBody([]).replace('Great review.', 'line one\nline two'));
  assert.equal(multi.additionalNotes, 'line one\nline two');
  // Empty notes section must not swallow the next section (hand-edited issues).
  const blank = parseIssueBody(`### Additional Notes\n\n${contact.LEGACY_EMAIL_HEADING}\n${EMAIL}`);
  assert.equal(blank.additionalNotes, undefined);
  const crlf = parseIssueBody(issueBody([contact.LEGACY_EMAIL_HEADING, EMAIL]).replace(/\n/g, '\r\n'));
  assert.equal(crlf.additionalNotes, 'Great review.');
});

test('CLI prints the address only with the right secret and never errors loudly', () => {
  const dir = tmpDir('bro4454-');
  const file = path.join(dir, 'body.txt');
  fs.writeFileSync(file, issueBody(contact.formatContactSection(EMAIL, SECRET)));
  const ok = spawnSync(process.execPath, [CLI, 'extract', file], { env: { ...process.env, APPROVAL_HMAC_SECRET: SECRET }, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, EMAIL);
  const wrong = spawnSync(process.execPath, [CLI, 'extract', file], { env: { ...process.env, APPROVAL_HMAC_SECRET: 'nope' }, encoding: 'utf8' });
  assert.equal(wrong.status, 3, 'sealed but undecryptable is reported by exit code');
  assert.equal(wrong.stdout, '');
  assert.equal(wrong.stderr, '');
  const missing = spawnSync(process.execPath, [CLI, 'extract', path.join(dir, 'absent.txt')], { env: process.env, encoding: 'utf8' });
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout + missing.stderr, '');
  fs.writeFileSync(file, issueBody(contact.formatContactSection('', SECRET)));
  const none = spawnSync(process.execPath, [CLI, 'extract', file], { env: { ...process.env, APPROVAL_HMAC_SECRET: SECRET }, encoding: 'utf8' });
  assert.equal(none.status, 0, 'no email given is not an error');
  assert.equal(none.stdout, '');
  fs.writeFileSync(file, issueBody(contact.formatContactSection('a b@example.com', SECRET)));
  const refused = spawnSync(process.execPath, [CLI, 'extract', file], { env: { ...process.env, APPROVAL_HMAC_SECRET: SECRET }, encoding: 'utf8' });
  assert.equal(refused.status, 0, 'a refused address is not reported as a decrypt failure');
  assert.equal(refused.stdout, '');
});

// Dry run of the real workflow notify steps: curl is a recorder on PATH, so
// nothing is sent; we read back the payload it was given.
const workflow = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/process-review-submission.yml'), 'utf8'));
const steps = Object.values(workflow.jobs).flatMap((j) => j.steps || []);

function runNotifyStep(name, body, secret) {
  const step = steps.find((s) => s.name === name);
  assert.match(step.run, /node scripts\/lib\/submitter-contact-cli\.js extract \.issue-body\.txt/);
  assert.ok(step, `workflow step "${name}" exists`);
  assert.equal(step.env.APPROVAL_HMAC_SECRET, '${{ secrets.APPROVAL_HMAC_SECRET }}');
  const dir = tmpDir('bro4454-wf-');
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, '.issue-body.txt'), body);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const record = path.join(dir, 'curl-args.json');
  fs.writeFileSync(path.join(bin, 'curl'),
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('200');\n`,
    { mode: 0o755 });
  const res = spawnSync('bash', ['-e', '-c', step.run], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, RESEND_API_KEY: 'test-resend', OWNER_EMAIL: 'owner@example.net', APPROVAL_HMAC_SECRET: secret },
  });
  const args = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null;
  return { res, args };
}

for (const name of ['Notify submitter - Approved', 'Notify submitter - Rejected']) {
  test(`${name}: decrypts and sends to the submitter without logging the address`, () => {
    const { res, args } = runNotifyStep(name, issueBody(contact.formatContactSection(EMAIL, SECRET)), SECRET);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(args, 'curl was called');
    const payload = JSON.parse(args[args.indexOf('-d') + 1]);
    assert.deepEqual(payload.to, [EMAIL]);
    assert.equal(payload.reply_to, 'owner@example.net');
    assert.match(payload.text, /hamilton-review\.html/);
    const log = (res.stdout + res.stderr).replace(`::add-mask::${EMAIL}`, '');
    assert.ok(!log.includes(EMAIL), 'address must not appear in the step log outside the mask command');
    assert.ok(!log.includes('::warning::'), 'no failure warning on a 2xx');
  });

  test(`${name}: wrong secret skips the email instead of failing the job`, () => {
    const { res, args } = runNotifyStep(name, issueBody(contact.formatContactSection(EMAIL, SECRET)), 'rotated');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(args, null, 'curl not called');
    assert.match(res.stdout, /::warning::Sealed submitter contact did not decrypt/);
    assert.match(res.stdout, /skipping notification/);
  });
}
