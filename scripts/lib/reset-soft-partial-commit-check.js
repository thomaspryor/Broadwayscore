/**
 * Lint check: flags the "phantom-staged-revert" bug class (card #687,
 * generalized from task #677's ship-check finding in record-push-ledger.js,
 * fixed in commit 613c6bd8eeb) — a script that does a bare `reset --soft
 * <ref>` to fast-forward local HEAD to some other ref, then stages ONLY a
 * specific path (a SCOPED `git add <path>`, never `-A`/`.`/`--all`) and
 * commits.
 *
 * Why this is dangerous: --soft moves HEAD but leaves the INDEX frozen at
 * the pre-reset tree. If <ref> had moved past the tree the index was built
 * from (routine under concurrent CI pushes), the index now disagrees with
 * the new HEAD for every file anything else changed in between — and git
 * reports that disagreement as a staged change even though nothing was ever
 * added. The following commit commits the WHOLE index, so those phantom
 * staged reversions ride along with the one path that actually was staged
 * and get pushed, silently reverting concurrent commits' real content back
 * to the stale pre-reset tree. Same class as this repo's own push-core-data
 * stale-copy-back incidents (#51/#52). The fix is `--mixed` (resets the
 * index to match the new HEAD, leaving the working tree untouched) — see
 * fastForwardHeadToOrigin() in scripts/record-push-ledger.js.
 *
 * Deliberately text/regex-based (no AST/parser dependency), matching the
 * style of scripts/lib/alert-ledger-commit-check.js. Comments are stripped
 * first so prose that merely mentions reset/add/commit (this file's own
 * header, or record-push-ledger.js's post-fix explanatory comments) can't
 * trip the detector. What's left is scanned in file order for the event
 * sequence: a --soft reset, then — with no intervening full index resync
 * (--mixed/--hard) — a scoped add followed by a commit.
 *
 * A --soft reset used only to rewind HEAD after a failed attempt, with no
 * scoped-add+commit following it before the next full resync, is NOT
 * flagged — see unwindAttempt() in scripts/record-push-ledger.js's current
 * (fixed) version: a --soft reset immediately followed by an unstage +
 * working-tree restore, never a scoped add+commit.
 *
 * KNOWN LIMITATION: this is a flat, file-order text scan, not real
 * call-graph analysis. It only catches the bug if the --soft reset's
 * literal text appears earlier in the file (in source order) than the
 * add+commit that follows it in execution — true for every script in this
 * repo today (helpers are defined above their callers), but a script that
 * defines a helper BELOW its caller, or splits the git calls across two
 * files, would slip past this check silently.
 */

const COMMENT_BLOCK_RE = /\/\*[\s\S]*?\*\//g;
// Strips a trailing `// ...` from a line unless preceded by `:` (avoids
// truncating a `http://`-style token that happens to precede it).
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/;

function stripComments(source) {
  return source
    .replace(COMMENT_BLOCK_RE, '')
    .split('\n')
    .map(line => line.replace(LINE_COMMENT_RE, '$1'))
    .join('\n');
}

// Matches a git subcommand array-call regardless of wrapper name — the
// local `git(['reset', ...])` helper convention (2 files, bare `git(`
// identifier immediately before the array) AND the more common
// `execFileSync('git', ['reset', ...])` / `spawnSync('git', [...])`
// convention (10+ files, quoted 'git' string within ~80 chars before the
// array). Bounded lazy gap avoids runaway matches across unrelated code.
function gitArrayCallRe(subcommand) {
  return new RegExp(
    `\\bgit\\b(?:\\(|['"\`][^\\n]{0,80}?)\\[\\s*(?:['"\`]-C['"\`]\\s*,\\s*[^,]+,\\s*)?['"\`]${subcommand}['"\`]\\s*,\\s*([^,\\]]+)`,
    'g'
  );
}

// Reset: capture the raw first arg after 'reset' (may be a quoted flag like
// '--soft', a quoted ref like 'HEAD', or a bare identifier/template like
// `origin/${branch}`) so a bare (flagless) reset — a --mixed reset by git's
// own default — can be told apart from an explicit --soft/--mixed/--hard.
const RESET_ARG_RES = [gitArrayCallRe('reset'), /\bgit\s+(?:-C\s+\S+\s+)?reset\s+(\S+)/g];

// Captures the raw first arg after 'add' (path literal OR bare
// identifier/expression) so a variable like `LEDGER_REL_PATH` still counts
// as a scoped add — only a literal `-A`/`.`/`--all`/`-a` is "broad".
const ADD_ARG_RES = [gitArrayCallRe('add'), /\bgit\s+add\s+(\S+)/g];

const COMMIT_RES = [
  /\bgit\b(?:\(|['"`][^\n]{0,80}?)\[\s*(?:['"`]-C['"`]\s*,\s*[^,]+,\s*)?['"`]commit['"`]/g,
  /\bgit\s+(?:-C\s+\S+\s+)?commit\b/g,
];

const BROAD_ADD_ARGS = new Set(['-A', '--all', '-a', '.']);

// Strips wrapping quotes (', ", or `) so a value works the same whether it
// came from a quoted literal or a bare identifier/template capture.
function stripQuotes(rawArg) {
  return rawArg.trim().replace(/^['"`]|['"`]$/g, '');
}

function isBroadAddArg(rawArg) {
  return BROAD_ADD_ARGS.has(stripQuotes(rawArg));
}

// Classifies a captured reset argument: an explicit '--soft' is the risky
// case; '--mixed'/'--hard' (or a BARE ref with no '--' flag at all — `git
// reset <ref>` defaults to --mixed) fully resync the index and neutralize
// prior risk; any other flag (e.g. '--quiet') is neither and is ignored.
function classifyResetArg(rawArg) {
  const value = stripQuotes(rawArg);
  if (value === '--soft') return 'soft';
  if (value === '--mixed' || value === '--hard') return 'full_sync';
  if (value.startsWith('--')) return null;
  return 'full_sync';
}

function collectEvents(source, regexes, classify) {
  const events = [];
  for (const re of regexes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      const event = classify(m);
      if (event) events.push({ index: m.index, ...event });
    }
  }
  return events;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * findResetSoftPartialCommitIssues(scriptSource) -> string[]
 *
 * Returns one human-readable violation string per --soft reset that is
 * followed — before any full index resync (--mixed/--hard) — by a scoped
 * `git add` and a `git commit`. Empty array = clean.
 */
function findResetSoftPartialCommitIssues(scriptSource) {
  const source = stripComments(scriptSource);

  const resetEvents = collectEvents(source, RESET_ARG_RES, m => {
    const type = classifyResetArg(m[1]);
    return type ? { type } : null;
  });

  const addEvents = collectEvents(source, ADD_ARG_RES, m => {
    if (!m[1] || isBroadAddArg(m[1])) return null;
    return { type: 'add' };
  });

  const commitEvents = collectEvents(source, COMMIT_RES, () => ({ type: 'commit' }));

  const events = [...resetEvents, ...addEvents, ...commitEvents].sort((a, b) => a.index - b.index);

  const violations = [];
  let softPending = false;
  let softLine = null;
  let sawScopedAdd = false;

  for (const event of events) {
    if (event.type === 'soft') {
      softPending = true;
      softLine = lineOf(source, event.index);
      sawScopedAdd = false;
    } else if (event.type === 'full_sync') {
      softPending = false;
      sawScopedAdd = false;
    } else if (event.type === 'add' && softPending) {
      sawScopedAdd = true;
    } else if (event.type === 'commit' && softPending && sawScopedAdd) {
      const commitLine = lineOf(source, event.index);
      violations.push(
        `reset --soft at line ${softLine} is followed by a scoped git-add + git-commit at line ${commitLine} with no intervening --mixed/--hard resync — phantom-staged-revert risk (#687): --soft leaves the index frozen at the pre-reset tree, so if the reset ref moved past that point, the whole stale index gets committed, silently reverting concurrent changes to files this script never touched. Fix: use --mixed instead of --soft (see fastForwardHeadToOrigin() in scripts/record-push-ledger.js).`
      );
      softPending = false;
      sawScopedAdd = false;
    }
  }

  return violations;
}

module.exports = { findResetSoftPartialCommitIssues };
