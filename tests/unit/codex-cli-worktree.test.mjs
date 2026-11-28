// BRO-170: Codex CLI reviews from a worktree session were silently downgrading
// to the OpenAI API fallback. Root cause: `codex exec` follows this repo's own
// CLAUDE.md session-start convention and runs `npm run data:check` as its own
// preflight before reviewing. That script tries to update the SHARED
// `~/broadway-scorecard-data` clone at a fixed path outside any worktree — a
// path other concurrent worktree sessions can be mutating at the same moment.
// When that update fails ("ERROR: Failed to update existing
// /Users/tompryor/broadway-scorecard-data — delete it and re-run" — the exact
// transcript reproduced in review-output-guard.test.mjs's task #1320 fixture),
// Codex refuses to review at all, and /ship-check + /plan-review fall back to
// gpt-5.4-mini via the OpenAI API.
//
// review-output-guard.js already *detects* that refusal and reports it in the
// coverage banner (task #1081/#1320) — that machinery was working. What was
// missing was the actual prevention: nothing told Codex not to run the
// preflight in the first place, so every worktree review paid the refusal +
// fallback tax. The fix is one directive line in each Codex prompt. This test
// is the regression guard for that line — it must survive edits to either
// command file, and both the repo-tracked copy (what worktree sessions load)
// and the global `~/.claude/commands/` copy (what a bare Claude Code session
// loads) must carry it, or the bug silently comes back for whichever copy a
// given session resolves to.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const NO_PREFLIGHT_RE = /do not run[^.\n]*`?npm run data:check`?/i;

const COMMAND_FILES = [
  {
    name: 'ship-check.md',
    repoPath: join(REPO, '.claude', 'commands', 'ship-check.md'),
    globalPath: join(homedir(), '.claude', 'commands', 'ship-check.md'),
  },
  {
    name: 'plan-review.md',
    repoPath: join(REPO, '.claude', 'commands', 'plan-review.md'),
    globalPath: join(homedir(), '.claude', 'commands', 'plan-review.md'),
  },
];

describe('Codex CLI worktree data-preflight guard (BRO-170)', () => {
  for (const { name, repoPath, globalPath } of COMMAND_FILES) {
    test(`${name}: still invokes codex exec (guard would be vacuous otherwise)`, () => {
      const src = readFileSync(repoPath, 'utf8');
      assert.match(src, /codex exec --sandbox read-only/, `${name} no longer calls codex exec — update this test if the invocation moved`);
    });

    test(`${name}: Codex prompt explicitly forbids the data:check preflight`, () => {
      const src = readFileSync(repoPath, 'utf8');
      assert.match(
        src,
        NO_PREFLIGHT_RE,
        `${name}'s Codex prompt must tell Codex not to run 'npm run data:check' — ` +
        'without this, Codex runs its own preflight against the shared ~/broadway-scorecard-data ' +
        'clone, which fails under worktree/concurrent-session contention and causes Codex to refuse ' +
        'the review, silently downgrading /ship-check and /plan-review to the OpenAI API fallback.',
      );
    });

    test(`${name}: the no-preflight directive is inside the PROMPT_HEAD heredoc, not just present somewhere in the file`, () => {
      const src = readFileSync(repoPath, 'utf8');
      const headStart = src.indexOf("cat <<'PROMPT_HEAD'");
      assert.notEqual(headStart, -1, `${name} must define a PROMPT_HEAD heredoc for the Codex prompt`);
      // The closing delimiter is indented to match the surrounding markdown
      // code fence (e.g. "     PROMPT_HEAD"), not flush with column 0.
      const closeMatch = /\n[ \t]*PROMPT_HEAD[ \t]*\n/.exec(src.slice(headStart + 1));
      assert.ok(closeMatch, `${name}'s PROMPT_HEAD heredoc has no matching closing delimiter`);
      const headEnd = headStart + 1 + closeMatch.index;
      const promptBody = src.slice(headStart, headEnd);
      assert.match(
        promptBody,
        NO_PREFLIGHT_RE,
        `${name}'s no-preflight directive must be inside the text actually piped to codex exec (PROMPT_HEAD), ` +
        'not merely present elsewhere in the command file (e.g. in surrounding prose that Codex never sees).',
      );
    });

    test(`${name}: global ~/.claude/commands copy carries the same guard (bare sessions load this copy, not the repo one)`, () => {
      // This reads real developer-machine state, not repo-tracked source, so
      // it can't be a hard CI assertion — a stale or absent global copy for
      // reasons unrelated to this fix (a from-scratch checkout, a machine
      // that never installed the global commands, drift from an unrelated
      // edit) would fail this test on every run on that machine, not just
      // when the actual fix regresses. The repo-file test above is the
      // binding, hermetic contract; this one is a best-effort warning so
      // drift doesn't go completely unnoticed on machines where it matters.
      if (!existsSync(globalPath)) return;
      const globalSrc = readFileSync(globalPath, 'utf8');
      if (!NO_PREFLIGHT_RE.test(globalSrc)) {
        console.warn(
          `⚠️  ~/.claude/commands/${name} is missing the no-preflight directive that .claude/commands/${name} has — ` +
          'a non-worktree session on this machine will still hit the shared-repo data-clone refusal until it is synced.',
        );
      }
    });
  }
});
