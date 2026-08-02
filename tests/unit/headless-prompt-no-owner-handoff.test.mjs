import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  findOwnerHandoffViolations,
  discoverHeadlessPromptFiles,
  promptPathsReferencedByLaunchers,
} = require(path.join(REPO, 'scripts/lib/headless-prompt-guard.js'));

const FIXTURE = path.join(REPO, 'tests/fixtures/sunday-review-prompt-2026-08-02-offending.md');

// Regression: 2026-08-02. sunday-review-prompt.md told the Sunday headless run
// to "open a PR rather than committing straight to main" and to "leave the PR
// open and mention it in the summary email so the owner merges". The owner got
// an email asking them to merge PR #518. Unattended runs land their own fixes.
test('flags the real pre-fix prompt text, verbatim from the fixture', () => {
  const offending = fs.readFileSync(FIXTURE, 'utf8');
  const violations = findOwnerHandoffViolations(offending);
  const matched = violations.map((v) => v.match.toLowerCase());

  assert.ok(violations.length >= 3, `expected >=3 violations, got ${violations.length}`);
  assert.ok(matched.some((m) => m.includes('open a pr')), 'should flag "open a PR"');
  assert.ok(matched.some((m) => m.includes('leave the pr open')), 'should flag "leave the PR open"');
  assert.ok(matched.some((m) => m.includes('do not merge')), 'should flag "Do not merge ..."');
});

// The first version of this guard matched only ~6 literal phrasings. A future
// prompt could say the same thing 10 other ways and sail through, which is
// exactly the failure mode the guard exists to prevent (second-opinion D1).
test('catches semantically equivalent handoff phrasings, not just the original wording', () => {
  const equivalents = [
    'Raise a PR and note it in the email.',
    'Create a pull request for this fix.',
    'File a PR against main.',
    'Submit a pull request instead.',
    'Push the branch and let the owner merge it.',
    'Leave the branch open for the owner.',
    'Park the PR open until Monday.',
    'Hand the fix off to the owner.',
    'The fix is ready for your review.',
    'Wait for owner approval before merging.',
    'Run gh pr create with the summary.',
    'Email the owner and ask them to merge the branch.',
    'Ask Tom to review the diff before landing.',
    'Request a review from the owner.',
    'The change needs owner sign-off before it lands.',
    'Do not merge to main. Tell the owner the branch name.',
    'Stop before merging and report the branch name in the email.',
    'Let the user approve the change first.',
  ];
  const missed = equivalents.filter((s) => findOwnerHandoffViolations(s).length === 0);
  assert.deepEqual(missed, [], `these handoff phrasings slipped through:\n${missed.join('\n')}`);
});

// The flip side: over-broad patterns push prompt authors to fence legitimate
// prose, and a fence is the one thing that can blind the scanner. Every string
// here is plausible in this prompt family and must NOT trip the guard.
test('does not flag legitimate editorial prose', () => {
  const legitimate = [
    'If the owner reviews the newsletter early, skip the run.',
    'Check whether the owner approves the lede wording.',
    'Ask the owner which show the lede should name.',
    'The critic score is ready for review by the LLM ensemble.',
    'Do not merge if the tests fail.',
    'Land it: scripts/merge-worktree-to-main.sh.',
  ];
  const falsePositives = legitimate
    .map((s) => [s, findOwnerHandoffViolations(s)])
    .filter(([, v]) => v.length)
    .map(([s, v]) => `${s} -> ${v.map((x) => x.match).join('|')}`);
  assert.deepEqual(falsePositives, [], `false positives on legitimate prose:\n${falsePositives.join('\n')}`);
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

test('text after a CLOSED fence is still scanned', () => {
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

// The three ways a fence could blind the scanner while still looking balanced
// to a naive open/close tally. Each must produce its own violation — silence
// here is a one-line, CI-passing exemption of an entire prompt file.
test('an unclosed fence is a violation, not a silent blindfold', () => {
  const unclosed = [
    '<!-- prompt-guard:examples-start -->',
    '- "Merge PR #1."',
    'Then go open a PR for the owner.',
  ].join('\n');

  const whys = findOwnerHandoffViolations(unclosed).map((v) => v.why);
  assert.ok(whys.some((w) => /never closed/.test(w)), `expected unclosed-fence violation, got: ${whys.join(' | ')}`);
});

test('both fence markers on one line is a violation', () => {
  const inline = [
    '<!-- prompt-guard:examples-start --> x <!-- prompt-guard:examples-end -->',
    'Then go open a PR for the owner.',
  ].join('\n');

  const violations = findOwnerHandoffViolations(inline);
  const whys = violations.map((v) => v.why);
  assert.ok(whys.some((w) => /one line/.test(w)), `expected malformed-fence violation, got: ${whys.join(' | ')}`);
  // and the line after it is still scanned
  assert.ok(violations.some((v) => /open a PR/i.test(v.match)), 'text after a malformed fence must still be scanned');
});

test('a stray closing marker is a violation', () => {
  const stray = ['<!-- prompt-guard:examples-end -->', 'Then go open a PR for the owner.'].join('\n');
  const whys = findOwnerHandoffViolations(stray).map((v) => v.why);
  assert.ok(whys.some((w) => /without being opened/.test(w)), `expected stray-end violation, got: ${whys.join(' | ')}`);
});

test('every shipped headless prompt is clean', () => {
  const files = discoverHeadlessPromptFiles(REPO);
  assert.ok(files.length >= 5, `discovery found only ${files.length} prompt files — glob likely broken`);

  const problems = [];
  for (const rel of files) {
    const abs = path.join(REPO, rel);
    assert.ok(fs.existsSync(abs), `${rel} discovered but missing on disk`);
    for (const v of findOwnerHandoffViolations(fs.readFileSync(abs, 'utf8'))) {
      problems.push(`${rel}:${v.line} "${v.match}" — ${v.why}`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    `Headless prompts must not hand the owner a code review:\n${problems.join('\n')}`
  );
});

// Coverage inversion (the tests/unit/no-reset-rsync-push-pattern.test.mjs
// pattern): derive what the launchers actually feed to `claude -p` and assert
// the globs reach all of it, so a prompt in a NEW directory can't ship unscanned.
test('no launcher feeds claude a prompt path the globs do not cover', () => {
  const scanned = discoverHeadlessPromptFiles(REPO).map((p) => path.posix.dirname(p));
  const referenced = promptPathsReferencedByLaunchers(REPO);

  // Normalize a launcher's prompt reference to a repo-relative directory:
  // drop every path segment that is (or contains) a shell variable, since those
  // are either the repo root ($REPO_DIR) or an indirection whose target was
  // captured as its own ref ($PROMPT_DIR/phase${PHASE}.md -> $PROMPT_DIR).
  const toDir = (ref) => {
    const dir = /\.md$/.test(ref) ? path.posix.dirname(ref) : ref;
    return dir.split('/').filter((seg) => seg && !seg.includes('$') && seg !== '.').join('/');
  };

  const uncovered = referenced.filter((ref) => {
    if (ref.includes('mktemp') || ref.startsWith('/tmp')) return false; // inline, scanned as source
    const rel = toDir(ref);
    if (!rel) return false; // pure variable indirection — its target is its own ref
    return !scanned.some((s) => s === rel || s.endsWith(`/${rel}`) || rel.endsWith(`/${s}`));
  });

  assert.deepEqual(
    uncovered,
    [],
    `these launcher prompt paths are outside PROMPT_GLOBS — add a glob:\n${uncovered.join('\n')}`
  );
});
