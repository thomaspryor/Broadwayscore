'use strict';
/**
 * branch-ruleset-paths.js — the restricted-file-path glob list for the
 * "code changes require a PR" ruleset on `main` (BRO-264 Phase 2).
 *
 * WHY EXTENSION-SCOPED, NOT DIRECTORY-SCOPED. A plan-review of this ticket
 * (six parallel reviewers) originally proposed blocking an entire scripts
 * directory tree and an entire dot-github directory tree from direct push.
 * Codex's review grepped every workflow's "git add" lines and found the
 * regenerate-tier-configs workflow (line 73) commits
 * scripts/config/domain-tier-order.json and
 * scripts/config/domain-tier-skip.json directly to main every Sunday --
 * generated DATA, sitting under the scripts directory. A blanket directory
 * restriction would have silently broken that workflow the following
 * Sunday, exactly the "silent failure surfaces days later" pattern this
 * project has been burned by before. A follow-up audit of every "git add"
 * line across all workflow and composite-action YAML files (2026-08-26)
 * confirmed zero workflows stage any code file (.js, .mjs, .sh, .ts), any
 * path under the dot-github directory, any path under src, or any top-level
 * config file -- so scoping the restriction to CODE FILE EXTENSIONS (not
 * directories) is empirically exact for the current fleet and safe by
 * construction for any future workflow that writes generated JSON under
 * scripts (it isn't blocked) while still catching a human or agent trying
 * to hand-edit actual logic.
 *
 * GitHub ruleset rule type: file_path_restriction. Confirmed via GitHub docs
 * (fetched live 2026-08-26): this rule type evaluates DIRECT PUSHES ONLY —
 * it does not evaluate pull request merges. So once active, a direct
 * `git push` touching any of these globs is rejected (forcing a PR), while
 * a PR merge that touches the same paths lands normally, and any push that
 * touches none of these globs (every data-committing workflow today) is
 * completely unaffected.
 *
 * Pure data + pure functions only — no fs, no gh/git exec — so this is
 * require()'d directly by both apply-branch-ruleset.js and its test
 * (CLAUDE.md rule 15).
 */

const RESTRICTED_FILE_PATHS = [
  'src/**',
  'scripts/**/*.js',
  'scripts/**/*.mjs',
  'scripts/**/*.sh',
  'scripts/**/*.ts',
  '.github/workflows/**',
  '.github/actions/**',
  'next.config.js',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
  'supabase/**',
  'CLAUDE.md',
];

const RULESET_NAME = 'require-pr-for-code-paths';

/**
 * Build the GitHub ruleset payload for `POST /repos/{owner}/{repo}/rulesets`
 * (or PUT .../rulesets/{id} to update). `enforcement` is 'evaluate' (dry-run,
 * logs would-be violations, blocks nothing) or 'active' (blocking).
 *
 * @param {{enforcement?: 'evaluate'|'active'}} opts
 */
function buildRulesetPayload({ enforcement = 'evaluate' } = {}) {
  if (enforcement !== 'evaluate' && enforcement !== 'active') {
    throw new Error(`buildRulesetPayload: enforcement must be 'evaluate' or 'active', got ${JSON.stringify(enforcement)}`);
  }
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement,
    conditions: {
      ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
    },
    rules: [
      {
        type: 'file_path_restriction',
        parameters: { restricted_file_paths: RESTRICTED_FILE_PATHS },
      },
    ],
    // No bypass_actors: enforcement applies to everyone, including repo
    // admins — satisfies BRO-264's "include-administrators ON" requirement.
    bypass_actors: [],
  };
}

/**
 * Does `filePath` (repo-relative, forward-slash) match any restricted glob?
 * Pure-JS glob match (no dependency). Used by the audit test to prove the
 * glob list matches exactly the files it's designed to catch/exempt.
 *
 * @param {string} filePath
 * @param {string[]} [globs] defaults to RESTRICTED_FILE_PATHS
 */
function matchesRestrictedPath(filePath, globs = RESTRICTED_FILE_PATHS) {
  const path = String(filePath || '').replace(/^\/+/, '');
  return globs.some((glob) => globToRegExp(glob).test(path));
}

// Placeholders used while converting a glob to a RegExp source string. Both
// contain characters ('*') that must not be touched by the later single-'*'
// substitution step, so they're swapped in as literal marker words and only
// expanded to their real (star-bearing) regex fragments as the final step.
const RECURSIVE_PREFIX_MARKER = '@@RECURSIVE_PREFIX@@';
const ANYTHING_MARKER = '@@ANYTHING@@';

function globToRegExp(glob) {
  // A "**/" segment must match ZERO or more directories (standard globstar
  // semantics, e.g. minimatch) so "scripts/**/*.js" also matches the direct
  // child "scripts/foo.js", not just files nested another level down.
  let re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  re = re.split('**/').join(RECURSIVE_PREFIX_MARKER);
  re = re.split('**').join(ANYTHING_MARKER);
  re = re.replace(/\*/g, '[^/]*');
  re = re.split(RECURSIVE_PREFIX_MARKER).join('(?:.*/)?');
  re = re.split(ANYTHING_MARKER).join('.*');
  return new RegExp(`^${re}$`);
}

module.exports = {
  RESTRICTED_FILE_PATHS,
  RULESET_NAME,
  buildRulesetPayload,
  matchesRestrictedPath,
};
