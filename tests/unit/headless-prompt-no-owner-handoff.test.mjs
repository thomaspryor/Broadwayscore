import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const {
  HEADLESS_PROMPT_FILES,
  findOwnerHandoffViolations,
} = require(path.join(REPO, 'scripts/lib/headless-prompt-guard.js'));

// Regression: 2026-08-02. sunday-review-prompt.md told the Sunday headless run
// to "open a PR rather than committing straight to main" and to "leave the PR
// open and mention it in the summary email so the owner merges". The owner got
// an email asking them to merge PR #518. Unattended runs land their own fixes.
test('headless prompt guard flags the exact 2026-08-02 offending text', () => {
  const offending = [
    'commit, push, and open a PR rather than committing straight to main from',
    'this headless run — do NOT push directly to `main`.',
    '',
    'Do not merge to main yourself in this headless run — leave the PR open and',
    'mention it in the summary email so the owner merges when they look at things.',
  ].join('\n');

  const violations = findOwnerHandoffViolations(offending);
  const matched = violations.map((v) => v.match.toLowerCase());

  assert.ok(violations.length >= 3, `expected >=3 violations, got ${violations.length}`);
  assert.ok(matched.some((m) => m.includes('open a pr')), 'should flag "open a PR"');
  assert.ok(matched.some((m) => m.includes('leave the pr open')), 'should flag "leave the PR open"');
  assert.ok(
    matched.some((m) => m.includes('do not merge to main yourself')),
    'should flag "do not merge to main yourself"'
  );
});

test('example fences are exempt so a prompt can quote the phrasing it bans', () => {
  const withFence = [
    'Never point the owner at code. All of these are banned:',
    '',
    '<!-- prompt-guard:examples-start -->',
    '- "Merge PR #518 when you get a minute."',
    '- "The fix is ready for your review."',
    '<!-- prompt-guard:examples-end -->',
    '',
    'If there was a code fix, it is already on main.',
  ].join('\n');

  assert.deepEqual(findOwnerHandoffViolations(withFence), []);
});

test('an unclosed fence does not silently exempt the rest of the file', () => {
  // Fail-loud sanity: if someone opens a fence and forgets to close it, the
  // guard would go blind. Assert the closing marker count matches on real files
  // (checked in the corpus test below), and that text after a *closed* fence is
  // still scanned.
  const reopened = [
    '<!-- prompt-guard:examples-start -->',
    '- "Merge PR #1."',
    '<!-- prompt-guard:examples-end -->',
    'Then go open a PR for the owner.',
  ].join('\n');

  const violations = findOwnerHandoffViolations(reopened);
  assert.equal(violations.length, 1);
  assert.match(violations[0].match, /open a PR/i);
});

test('every shipped headless prompt is clean', () => {
  const problems = [];

  for (const rel of HEADLESS_PROMPT_FILES) {
    const abs = path.join(REPO, rel);
    assert.ok(fs.existsSync(abs), `${rel} listed in HEADLESS_PROMPT_FILES but missing on disk`);
    const text = fs.readFileSync(abs, 'utf8');

    const opens = (text.match(/<!--\s*prompt-guard:examples-start\s*-->/gi) || []).length;
    const closes = (text.match(/<!--\s*prompt-guard:examples-end\s*-->/gi) || []).length;
    assert.equal(opens, closes, `${rel}: unbalanced prompt-guard example fences (${opens} open, ${closes} close)`);

    for (const v of findOwnerHandoffViolations(text)) {
      problems.push(`${rel}:${v.line} "${v.match}" — ${v.why}`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    `Headless prompts must not hand the owner a code review:\n${problems.join('\n')}`
  );
});
