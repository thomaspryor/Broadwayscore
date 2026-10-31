import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolutionForIssue, checkResolution, main } from './ux-walkthrough-resolution.js';
import { cardNotes } from './ux-walkthrough-filing.js';
import { isSafeCheckCommand } from './check-paths.js';

const key = 'a'.repeat(32);
const comment = body => ({ body, createdAt: '2026-10-29T12:00:00Z' });
const issue = (comments = [], description = cardNotes({ summary: 'Button overlaps the title' }, 3, key)) => ({
  identifier: 'BRO-1', title: 'UX audit: Button overlaps the title', description,
  comments: { nodes: comments, pageInfo: { hasNextPage: false } },
});
const reason = 'UX-RESOLUTION: noise: Checked the mobile watchlist; the add-date button opens the date picker.';
const visual = `VISUAL-APPROVAL: patch=${'b'.repeat(40)} verdict=${'c'.repeat(32)} hold=visual-hold/bro-1`;

test('an untouched card fails; only a comment with an actual noise reason passes', () => {
  assert.equal(resolutionForIssue(issue()).ok, false);
  assert.equal(resolutionForIssue(issue([], `${cardNotes({}, 0, key)}\n${reason}`)).ok, false);
  assert.equal(resolutionForIssue(issue([comment(`\`\`\`\n${reason}\n\`\`\``)])).ok, false);
  for (const body of ['All done', 'UX-RESOLUTION: noise:', 'UX-RESOLUTION: noise: done',
    'UX-RESOLUTION: noise: <what you looked at and what you saw>',
    'UX-RESOLUTION: noise: TODO reproduce this on a phone', 'UX-RESOLUTION: fixed: I changed it']) {
    assert.equal(resolutionForIssue(issue([comment(body)])).ok, false, body);
  }
  assert.equal(resolutionForIssue(issue([comment(reason)])).ok, true);
});

test('a fix needs a real visual request and its landing record; pending, rejected and unverified asks fail', () => {
  for (const body of ['Asked the owner to look at this', 'Visual approval ref VQA', 'Visual approval unverified VQU']) {
    assert.equal(resolutionForIssue(issue([comment(body)], visual)).ok, false, body);
  }
  assert.equal(resolutionForIssue(issue([comment('Visual approval landed VQL')])).ok, false);
  assert.equal(resolutionForIssue(issue([comment('Visual approval landed VQL')], visual)).ok, true);
});

test('the newest resolution directive wins even when comments arrive newest first', () => {
  assert.equal(resolutionForIssue(issue([
    { body: 'UX-RESOLUTION: unresolved: It reproduces', createdAt: '2026-10-30T12:00:00Z' }, comment(reason),
  ])).ok, false);
});

test('the filing check is safe, keyed to this filing, and rejects injection and extra flags', () => {
  assert.match(cardNotes({}, 0, key), new RegExp(`UX-FINDING: ${key}`));
  const command = `node scripts/lib/ux-walkthrough-resolution.js --key=${key}`;
  assert.equal(isSafeCheckCommand(command), true);
  for (const suffix of [' --write', '; echo ok', '/../../x']) assert.equal(isSafeCheckCommand(command + suffix), false);
  assert.throws(() => cardNotes({}, 0), /unique/);
  assert.notEqual(cardNotes({}, 0, key), cardNotes({}, 0, 'b'.repeat(32)));
});

test('the read-only probe requires exactly one matching UX card and reads all comment pages', async () => {
  let calls = 0;
  const client = { TEAM_KEY: 'BRO', graphql: async (query, vars) => {
    assert.doesNotMatch(query, /mutation/);
    calls++;
    if (calls === 1) {
      assert.equal(vars.marker, `UX-FINDING: ${key}`);
      const first = issue();
      first.comments.pageInfo = { hasNextPage: true, endCursor: 'p1' };
      return { issues: { nodes: [first], pageInfo: { hasNextPage: false } } };
    }
    assert.equal(vars.after, 'p1');
    return { issue: { comments: { nodes: [comment(reason)], pageInfo: { hasNextPage: false } } } };
  } };
  assert.equal((await checkResolution(key, client)).ok, true);
  assert.equal(calls, 2);
  for (const nodes of [[], [issue(), issue()], [issue([], 'Unrelated card')], [{ ...issue(), title: 'Other task' }]]) {
    assert.equal((await checkResolution(key, { graphql: async () => ({ issues: { nodes } }) })).ok, false);
  }
});

test('API failures, incomplete pagination, invalid arguments and unreviewed cards cannot pass the CLI', async () => {
  const response = nodes => ({ graphql: async () => ({ issues: { nodes } }) });
  assert.equal(await main([`--key=${key}`], response([issue()])), 1);
  assert.equal(await main([`--key=${key}`], response([issue([comment(reason)])])), 0);
  assert.equal(await main(['--key=bad'], response([])), 2);
  assert.equal(await main([`--key=${key}`], { graphql: async () => { throw new Error('offline'); } }), 2);
  const incomplete = issue([comment(reason)]);
  delete incomplete.comments.pageInfo;
  await assert.rejects(checkResolution(key, response([incomplete])), /Incomplete/);
  incomplete.comments.pageInfo = { hasNextPage: true };
  await assert.rejects(checkResolution(key, response([incomplete])), /Incomplete/);
});
