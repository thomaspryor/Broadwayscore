/**
 * Shared acceptance-command grammar and filesystem path resolution.
 * Loading this leaf module performs no filesystem reads or triage setup.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// checkableDone is LLM-authored text that a later sprint EXECUTES as the
// card's verification command. Card notes are untrusted and flow into the
// triage prompt, so this is a prompt-injection → command-execution path
// unless the command shape is locked down at validation time. Only these
// forms are accepted; every file argument must be a relative, traversal-free
// path under tests/, scripts/, src/, or docs//memory/ (for test -f).
// Task #1827: ALLOWLIST (not a denylist) of basenames the generic audit-/
// lint- shape form below actually accepts. Originally this was designed the
// other way — trust the `scripts/(audit|lint)-<name>.js` naming convention
// by default and deny-list the two known bad actors — but a corpus scan
// during ship-check (`grep writeFileSync scripts/audit-*.js scripts/lint-*.js`)
// found the naming convention does NOT imply read-only in this repo: the
// large majority of this repo's ~90 audit-*.js scripts write SOME report
// file, and a same-sample spot check found several of those paths are
// git-TRACKED (not gitignored) — e.g. audit-aggregator-coverage.js →
// data/audit/aggregator-coverage.json, audit-cast-changes.js → the actual
// data/cast-changes.json (not even an audit/ path). A "trust the prefix,
// deny two names" design would have silently admitted checkableDone strings
// for dozens of scripts sharing this exact tracked-file-write hazard the
// moment an LLM (drafting from untrusted card notes — this file's own
// stated threat model) happened to name one. So: allowlist only, and only
// basenames individually confirmed to have ZERO fs.writeFileSync/
// appendFileSync/renameSync/unlinkSync/mkdirSync calls anywhere in the file
// (`audit-worktree-unpushed.js` doesn't exist yet — trivially zero-risk to
// list; it can't execute anything until it's written, at which point it
// needs the same check before this list is trusted again).
//   - audit-review-contamination.js: confirmed zero write calls (task #1827).
//   - lint-resend-calls.js: confirmed zero write calls (task #1827) — greps
//     source files for a banned string, prints only.
//   - audit-worktree-unpushed.js: does not exist on disk yet (confirmed via
//     `git ls-files` / `ls`); shape-only admission, same as every other form
//     — isSafeCheckCommand never checks existence, resolveCheckPaths does
//     that downstream for pathsGroup forms.
// BRO-2718: "nothing here detects a new violator automatically" is no longer
// true, and that is what makes the list below safe to grow from 3 names to 39.
// scripts/audit-safe-form-allowlist.js re-derives the read-only property of
// every basename here on every CI run (unit test:
// scripts/lib/safe-form-allowlist.test.mjs), by scanning for fs mutation APIs,
// child_process spawns, network clients and unreadable dynamic requires — in
// the script's own file (hard gate, never baselined) AND across its transitive
// local require graph (hard gate, with a shrink-only baseline holding exactly
// one grandfathered entry). Add a write to any script named here and CI goes
// red naming it. Every name below was admitted by that scanner, not by hand.
//
// WHY IT HAD TO GROW. With three names, the generic form refused essentially
// every real read-only script a card author could name — including three of
// the crown loop's own cycle gates. Measured on the same 300-card Linear
// sweep (data/audit/card-verifiability-linear.json), `basename` refusals were
// 7 of 187, but the shape they refused was the CORRECT one: a card that
// correctly named `node scripts/audit-push-retry-budgets.js` was told its
// command was unsafe, so the author's only route to an armed card was to
// invent a different command. A gate that refuses the right answer teaches
// people to write wrong ones.
//
// WHAT IS DELIBERATELY STILL ABSENT, and why the scanner is not being widened
// to admit it:
//   - audit-outlet-registry.js  — `--strict` no longer writes (BRO-2747:
//     the git-tracked data/audit/outlet-registry-gaps.json is written in
//     report mode only, with repo-relative paths), but the file still holds
//     --update/--fix/--update-baseline writes, which a static scan cannot
//     tell apart from the gate path. Its unit test
//     (scripts/audit-outlet-registry.test.mjs) pins --strict as no-write.
//   - audit-critic-outlets.js   — same shape: writes data/critic-registry.json
//     and data/audit/critic-outlet-affinity.json on every run.
//   - audit-card-verifiability.js — writes its report, and shells out to
//     notion-brain.js via execFileSync.
//   - audit-sibling-title-misroute.js — keeps its own narrower bare-only entry
//     below; under --fix it MOVES AND DELETES review-text files.
// Give one of those a genuinely read-only mode and the scanner will admit it
// on its own; do not hand-add a name the scanner rejects.
const AUDIT_LINT_GENERIC_FORM_ALLOWED = new Set([
  // Grandfathered from task #1827. Direct-clean; its 64-module require graph
  // reaches scripts/lib/scraper.js and review-write-guard.js, so it is
  // carried in audit-safe-form-allowlist.js's TRANSITIVE_SCAN_BASELINE.
  // Discharge that by severing the graph, never by baselining a second name.
  'audit-review-contamination.js',
  // Does not exist on disk (still true) — shape-only admission, unchanged.
  'audit-worktree-unpushed.js',
  // Everything below: zero fs writes, zero spawns, zero network, no computed
  // require, in the file AND its whole local require graph.
  'audit-audience-buzz-contamination.js',
  'audit-cast-contamination.js',
  'audit-contradicted-flag-basis.js',
  'audit-creative-team-vs-synopsis.js',
  'audit-critic-consensus-contamination.js',
  'audit-cron-health-coverage.js',
  'audit-duplicate-of-floor.js',
  'audit-errexit-unguarded-substitution.js',
  'audit-false-balance.js',
  'audit-gate-corpus-guard-coverage.js',
  'audit-launchd-stale-sync-guard.js',
  'audit-linear-issuecreate-chokepoint.js',
  'audit-nft-excluded-runtime-reads.js',
  'audit-placeholder-venues.js',
  'audit-playwright-count-assertions.js',
  'audit-playwright-evaluate-click.js',
  'audit-push-core-data-audit-gap.js',
  'audit-push-retry-budgets.js',
  'audit-reconcile-coverage.js',
  'audit-review-texts-test-yml-coverage.js',
  'audit-run-budget-coverage.js',
  'audit-show-director-consensus.js',
  'audit-stale-flag-after-url-correction.js',
  'audit-stale-flag-producers.js',
  'audit-test-yml-lib-deps.js',
  'audit-test-yml-manifest-paths.js',
  'audit-tests-vs-derived-data.js',
  'audit-text-quality.js',
  'audit-tony-attribution.js',
  'audit-tony-eligibility.js',
  'audit-unbounded-fetch.js',
  'audit-verifier-wiring.js',
  'audit-workflow-concurrency.js',
  'audit-workflow-secret-gaps.js',
  'lint-design-tokens.js',
  'lint-resend-calls.js',
  'lint-wrongproduction-provenance.js',
]);

// Task #1827 (widened BRO-4151): individually-vetted `bash
// scripts/lib/<name>.test.sh` bash-integration tests — NOT a blanket rule for
// every *.test.sh in the repo. A directory-wide pattern would admit any
// future .test.sh sight unseen; some of this repo's existing suites, e.g.
// push-with-retry.deadline.test.sh:73, deliberately invoke `git remote add
// origin "ext::sh -c '…'"` as a legitimate self-contained sandbox technique —
// safe in THAT file because it never leaves its own `mktemp -d` sandbox, but
// nothing about the .test.sh naming convention itself guarantees the next
// file stays that disciplined. Same allowlist-of-individually-vetted-names
// principle as AUDIT_LINT_GENERIC_FORM_ALLOWED above.
const BASH_INTEGRATION_TEST_SH_ALLOWED = new Set([
  // Confirmed (task #1827): all I/O happens inside its own `mktemp -d`
  // sandbox with a `trap rm -rf … EXIT` cleanup, no writes to the real repo
  // tree.
  'sync-audit-checkout.test.sh',
  // BRO-4151: same standard, confirmed the same way — `TMP=$(mktemp -d)` /
  // `trap 'rm -rf "$TMP"' EXIT` at the top; reads REPO_ROOT paths
  // (push-with-retry.sh, data-health-check.yml) but never writes there. This
  // is what lets a "Unit Tests" red-first card for this exact step arm
  // instead of degrading to owner-judgment (BRO-4149 — the step's own `run:`
  // command was resolvable but previously unrecognized as safe-form).
  'push-with-retry.stranded-commit-cascade.test.sh',
]);

// BRO-2208: `check-workflow-run-status.js` value fragment — a quoted (single
// OR double) run of characters, or a bare token with no whitespace. Needed
// because a workflow's display name ("Deploy to Vercel") contains spaces and
// must be quoted; the SAFE_CHECK_FORMS regex below matches the raw command
// string (quotes and all), while cardCheckArgv's tokenizeCheckCommand
// (autonomous-checks.js) separately dequotes it into argv at execution time —
// the two must agree on what counts as one value, which is why this fragment
// exists as a single source instead of being hand-duplicated into the regex.
// Deliberately excludes backslash from every alternative: the tokenizer has
// NO escape-sequence handling (by design — see its own header comment), so a
// value needing one is rejected here rather than silently mis-tokenized
// downstream (ship-check/Codex finding). Also excludes the OTHER quote
// character from the bare alternative — `[^\s]+` alone would happily match
// an unterminated `"Deploy` as a "bare" token when the quoted alternative
// fails to find a closing quote, which both accepts a malformed command AND
// tokenizes it differently than the regex shape implies (same finding).
const GH_VALUE_RE = `(?:"[^"\\\\]*"|'[^'\\\\]*'|[^\\s'"\\\\]+)`;

const SAFE_CHECK_FORMS = [
  // BRO-6484: read-only, per-filing UX resolution evidence from Linear. One fixed opaque key, no extra flags.
  { re: /^node scripts\/lib\/ux-walkthrough-resolution\.js --key=[a-f0-9]{32}$/ },
  // BRO-5266: read-only world-state acceptance, outside the blocking unit batch.
  // Fixed script and ordered, traversal-free IDs/flags; never arbitrary node scripts.
  { re: /^node scripts\/lib\/verify-data-backfill\.js --show=[a-z0-9]+(?:-[a-z0-9]+)*(?:,[a-z0-9]+(?:-[a-z0-9]+)*)*( --images)?( --reviews=[1-9]\d*)?( --type=(?:musical|play|special|opera))?$/ },
  // .test.mjs/.test.js run via plain `node --test`. A file that imports a TS
  // module via the `@/` path alias (e.g. `@/lib/gate-logic`), or a plain TS
  // module whose OWN internal imports are extensionless (moduleResolution
  // "bundler" in tsconfig.json, no allowImportingTsExtensions), throws
  // ERR_MODULE_NOT_FOUND here — Node's own ESM resolver doesn't do TS-aware
  // extensionless resolution — so such a file needs the `npx tsx --test` form
  // below instead. .test.ts stays out of scope for THIS form specifically
  // (plain `node --test` never gets TS-aware resolution, whatever the
  // extension) — not the tsx form below.
  { re: /^node --test( --test-timeout \d+)?((?: [\w@./-]+\.test\.m?js)+)$/, pathsGroup: 2, pathPrefix: ['tests/', 'scripts/', 'src/'] },
  // BRO-228: `npx tsx --test` is this repo's own existing idiom for a
  // TS-alias-importing test (package.json's test:unit script, test.yml's tsx
  // batch) — reused here rather than inventing a fourth `node --import tsx
  // --test` shape. Injection surface is identical to the `node --test` form
  // above: `npx tsx --test` is a fixed three-token prefix with no capture
  // group, and the same file-path group goes through the same traversal /
  // pathPrefix / MUTATING_SCRIPT_RE checks below.
  // BRO-2218: widened to also accept `.test.ts` (not just `.test.mjs/.js`).
  // A card testing a TS module whose own internal imports are extensionless
  // could previously only be armed with a `node --test <file>.test.mjs`
  // command — which fails ERR_MODULE_NOT_FOUND on exactly that import shape
  // (tsx is a proper TS/ESM loader that resolves it; plain node isn't) — or a
  // `.test.ts` file, which this form refused outright. Both jaws of that trap
  // are gone: the repo already runs `.test.ts` files this exact way in CI
  // (package.json's test:unit script, test.yml's tsx-batch manifest, e.g.
  // tests/unit/show-market.test.ts) — this only lets a card's acceptance
  // command name that same already-idiomatic shape.
  { re: /^npx tsx --test( --test-timeout \d+)?((?: [\w@./-]+\.test\.(?:m?js|ts))+)$/, pathsGroup: 2, pathPrefix: ['tests/', 'scripts/', 'src/'] },
  { re: /^npx tsc --noEmit$/ },
  { re: /^(?:npm run lint|npx eslint src)$/ },
  { re: /^test -f((?: [\w@./-]+)+)$/, pathsGroup: 1, pathPrefix: ['docs/', 'memory/', 'tests/', 'src/', 'scripts/'] },
  // Digest-autofix cards (owner mandate 2026-08-02): read-only row-absence
  // probe against the daily health snapshot. The row name is a single
  // base64url token — no spaces or shell metachars can appear, which both
  // satisfies this injection gate and survives cardCheckArgv's quote-free
  // whitespace split (scripts/lib/autonomous-checks.js).
  // Optional trailing ` --live` (Digest-autofix S5, task #1224): re-runs the
  // core checks live via scripts/lib/health-row-probe.js instead of reading
  // yesterday's snapshot, for same-day fix verification. Fixed literal
  // suffix only — no new capture group, no widening of the row-token
  // charset, so the injection surface is unchanged.
  // BRO-5371: read-only resolution check for the commercial review cards a worker now takes (replaces a bare owner-judgment marker).
  // BRO-5371: the claude-config hook fixture suite (Mac-only; read-only fixtures). Bare form only.
  { re: /^bash ~\/\.claude\/hooks\/tests\/run-all\.sh$/ },
  { re: /^node scripts\/check-review-item-resolved\.js (?:--(?:claim|closure)=[a-z0-9][a-z0-9:_-]{0,120}|--held-empty|--issue-closed=[1-9]\d{0,6})$/ },
  { re: /^node scripts\/check-health-row-absent\.js --row-b64 ([A-Za-z0-9_-]{1,200})( --live)?$/ },
  // BRO-3889: acceptance for every owner-alert-router card with no more
  // specific command — read-only check of the alert ledger
  // (scripts/check-alert-condition-absent.js). Same single base64url token
  // shape and 200-char cap as check-health-row-absent.js above, so the
  // injection surface is identical; no flags.
  { re: /^node scripts\/check-alert-condition-absent\.js --key-b64 ([A-Za-z0-9_-]{1,200})$/ },
  // Coverage Verdict S5 (task #903): read-only acceptance check for the
  // "two consecutive clean weeks" bar — reads a status file the weekly
  // adversarial-probe cron already wrote, no arguments, nothing to inject.
  { re: /^node scripts\/check-coverage-probe-clean\.js$/ },
  // Digest-autofix S6 (task #1225): the daily end-to-end canary's own
  // acceptance command — read-only marker-file existence check. --date is a
  // strict YYYY-MM-DD token (no shell metachars, no path segments), so this
  // cannot reference or mutate anything outside data/audit/canary-*.marker.
  { re: /^node scripts\/check-canary-marker\.js --date=(\d{4}-\d{2}-\d{2})$/ },
  // BRO-4215: acceptance for check-provider-spend.js's attribution-gap cards —
  // read-only check of the latest provider-spend-daily.jsonl row; --provider
  // is locked to the three known names (no path, no shell metachars).
  { re: /^node scripts\/check-attribution-gap-clear\.js --provider=(scrapingbee|scrapingdog|brightdata)$/ },
  // Task #1713: this repo's own standard validation entry points were
  // excluded from every form above, so a card author who correctly named
  // `node scripts/validate-data.js` as the acceptance check got REFUSED
  // anyway (audit-card-verifiability.js "shape 2" — a real command rejected
  // by safe-form). Each entry below is a script vetted read-only w.r.t.
  // shows.json/reviews.json/review-texts (the corpus MUTATING_SCRIPT_RE
  // exists to protect) — never NEVER assumed to be side-effect-free in
  // general. Two of them DO write outside data/audit/: validate-data.js
  // writes/clears a RUNNER_TEMP-or-/tmp push-refusal sentinel (consumed by
  // the push-core-data composite action in the SAME CI job, not read by a
  // standalone re-verification run), and scoring-delta.js writes into its
  // own self-cleaned os.tmpdir() mkdtemp scratch dir to diff HEAD vs the
  // working tree. Neither touches a tracked/shared path (ship-check finding).
  // Bare invocation only, plus flags individually confirmed report/gate-mode
  // (never a --fix/--update-baseline/--force mutation flag) by reading each
  // script before adding it here — this is a curated allowlist, not a
  // `scripts/(audit|check)-*.js` prefix match, because a prefix match would
  // silently admit any FUTURE script sharing the naming convention without
  // the same review.
  { re: /^node scripts\/validate-data\.js( --strict)?$/ },
  // BRO-3907: run-unit-tests.js is the local equivalent of CI's "Unit Tests"
  // job (spawns `node --test`/`npx tsx --test` over the same two committed
  // manifests CI reads) — no fs writes of its own, only spawnSync calls (see
  // its own header). Bare only: it takes no flags at all, so there is nothing
  // to widen.
  { re: /^node scripts\/run-unit-tests\.js$/ },
  // Bare only — no --base= capture. scoring-delta.js interpolates --base
  // straight into `execSync(`git show ${BASE_REF}:...`)` (shell string
  // concatenation, not execFile array-args), so accepting an LLM- or
  // card-author-supplied --base value here would be a genuine shell-injection
  // hole. Bare invocation defaults BASE_REF to HEAD and needs no such value.
  { re: /^node scripts\/scoring-delta\.js$/ },
  { re: /^node scripts\/test-temporal-override-regression\.js$/ },
  // --review-texts-dir= deliberately excluded (arbitrary path arg, no need
  // for it in a re-verification context).
  { re: /^node scripts\/audit-stale-flag-after-url-correction\.js(?: --gate)?(?: --max=\d+)?(?: --json)?$/ },
  { re: /^node scripts\/audit-help-flag-safety\.js$/ }, // bare only — --update-baseline writes BASELINE_PATH
  { re: /^node scripts\/audit-workflow-hygiene\.js$/ },
  { re: /^node scripts\/audit-aggregator-archive-integrity\.js(?: --strict)?$/ },
  { re: /^node scripts\/audit-sibling-title-misroute\.js$/ }, // bare only — NEVER --fix (moves/deletes review-text files)
  { re: /^node scripts\/audit-orphan-tests\.js$/ },
  // Task #1713 round 2 (audit-card-verifiability.js's live "shape 2" refusals
  // after round 1 landed): each entry below was individually read for writes
  // before being added, same standard as the block above.
  // --update-baseline is the ONLY branch that writes (to
  // data/audit/cv-flag-contradiction-baseline.json); --window/--strict only
  // change what's scanned/reported, never write.
  { re: /^node scripts\/audit-cv-flag-contradiction\.js(?: --window=\d+)?(?: --strict)?$/ },
  // fix-shared-ibdb-urls.js mutates data/shows.json via saveShows() UNLESS
  // --dry-run is passed (scripts/fix-shared-ibdb-urls.js:28,43-51) — the flag
  // is required here, not optional, unlike the audit-*.js bare forms above.
  { re: /^node scripts\/fix-shared-ibdb-urls\.js --dry-run$/ },
  // check-sb-credits.js does one https.get() and prints — no fs writes exist
  // anywhere in the file (module.exports + CLI wrapper only), so every flag
  // shape is equally safe; kept bare-only for consistency with the audit-*.js
  // convention above rather than because a flag would be unsafe.
  { re: /^node scripts\/lib\/check-sb-credits\.js$/ },
  // BRO-4151: lint-committed-pii.js's only child_process call is a read-only
  // `git ls-files` (listTrackedAuditFiles()) — no git mutation, no other
  // spawn, no fs writes anywhere in the file (confirmed by reading it whole).
  // It cannot go through the generic audit-/lint- allowlist below: that
  // form's own scanner (scripts/audit-safe-form-allowlist.js) hard-refuses
  // ANY spawn, read-only or not ("a write primitive we cannot statically
  // bound" — SPAWN_RE), so this gets its own individually-vetted entry
  // instead, same treatment as check-sb-credits.js above. Bare only — the
  // script takes no flags. Without this entry, test.yml's "Audit — no
  // submitter PII in committed data/audit files" step (Lint Workflows job)
  // resolves to its own `run:` command but fails safe-form validation and
  // degrades straight to owner-judgment — the BRO-4147 red-first skip.
  { re: /^node scripts\/lint-committed-pii\.js$/ },
  // Task #1827: generic flag-SHAPE rule for individually-vetted audit/lint
  // scripts — NOT a blanket trust of the audit-/lint- naming convention (see
  // AUDIT_LINT_GENERIC_FORM_ALLOWED's comment above for why that was tried
  // and reverted: most of this repo's audit-*.js scripts write to tracked
  // paths). What this form actually widens: adding a NEW vetted script here
  // only needs one Set entry instead of a whole new regex block, and the
  // flag-parsing/traversal/existence machinery is shared instead of
  // reimplemented per entry. Script name is a single path segment (no `.`,
  // no `/`), so it can never escape scripts/ — routed through pathsGroup/
  // pathPrefix like every other file-argument form, which gives it the SAME
  // traversal check and, downstream, the SAME resolveCheckPaths existence/
  // new-artifact check node --test paths get. At most ONE flag from a fixed
  // literal set — no free-form args, no combining flags (audit-cv-flag-
  // contradiction.js above needs BOTH --window= and --strict together,
  // which is exactly why it stays on its own narrower entry instead of
  // relying on this one).
  {
    re: /^node (scripts\/(?:audit|lint)-[A-Za-z0-9_-]+\.js)(?: (?:--strict|--gate|--json|--dry-run|--window=\d+|--max=\d+))?$/,
    pathsGroup: 1,
    pathPrefix: ['scripts/'],
    allowBasenames: AUDIT_LINT_GENERIC_FORM_ALLOWED,
  },
  // Task #1827: `bash <path>.test.sh` — NOT a blanket rule for every *.test.sh
  // in the repo (a ship-check adversarial pass, Codex, correctly called out
  // that a directory-wide pattern would admit any future .test.sh sight
  // unseen — some of this repo's existing suites, e.g.
  // push-with-retry.deadline.test.sh:73, deliberately invoke `git remote add
  // origin "ext::sh -c '…'"` as a legitimate self-contained sandbox
  // technique; safe in THAT file because it never leaves its own `mktemp -d`
  // repo, but nothing about the .test.sh naming convention itself guarantees
  // the next one stays that disciplined). Same allowlist-of-individually-
  // vetted-paths principle as AUDIT_LINT_GENERIC_FORM_ALLOWED above — exact
  // relative path, not a basename or directory pattern — enforced here by
  // restricting the regex to direct children of scripts/lib/ (no
  // subdirectories, no traversal), so a basename match against the allowlist
  // below is also an exact-relative-path match. Adding another .test.sh here
  // needs the same read-the-whole-file verification first.
  {
    re: /^bash (scripts\/lib\/[A-Za-z0-9_.-]+\.test\.sh)$/,
    pathsGroup: 1,
    pathPrefix: ['scripts/lib/'],
    allowBasenames: BASH_INTEGRATION_TEST_SH_ALLOWED,
  },
  // BRO-2208: `node scripts/check-workflow-run-status.js` — a wrapper
  // around `gh run list`, NOT a bare `gh run list [flags]` form (an earlier
  // version of this fix offered that directly; ship-check/Codex caught that
  // `gh run list` exits 0 whenever it can reach the API regardless of what
  // the listed runs' conclusions actually are — `--json`/`--jq` only reshape
  // its stdout, they never touch its exit code — so a bare-form card would
  // rubber-stamp unconditionally, the exact vacuous-check failure mode
  // classifyVacuousCheck already guards against elsewhere in this file's
  // family). The wrapper script asserts the fetched conclusion itself and
  // exits non-zero on any mismatch, so THIS shape's exit code is a real
  // pass/fail signal — see the script's own header for the full reasoning.
  {
    re: new RegExp(
      `^node scripts/check-workflow-run-status\\.js --workflow=${GH_VALUE_RE}`
      + `(?: --branch=${GH_VALUE_RE})? --expect=${GH_VALUE_RE}(?: --branch=${GH_VALUE_RE})?`
      + `(?: --limit=(?:[1-9]|[1-4]\\d|50)(?: --min-match=\\d{1,2})?(?: --max-match=\\d{1,2})?)?$`,
    ),
  },
  // BRO-2208: extract-show-score-reviews.js normally overwrites
  // data/show-score.json + data/audit/show-score-extraction-gaps.json on
  // every run (deliberately excluded from task #1713's widening for exactly
  // that reason). --check (added alongside this form) runs the identical
  // extraction pass read-only — skips both writes — so it is now safe for
  // unattended re-verification the same way the audit-*.js bare forms above
  // are. Required, not optional: bare `node scripts/extract-show-score-reviews.js`
  // still mutates and must stay refused.
  { re: /^node scripts\/extract-show-score-reviews\.js --check$/ },
  // ci-green-rate (2026-09-20): the machine verdict on "is main green" — the
  // only thing allowed to say so (~45 sessions each claimed it fixed after a
  // handful of green runs). Read-only in every admitted shape: the ONLY
  // write in the file is behind `--record` (appends the nightly reading to
  // data/audit/ci-green-rate.jsonl for health-check.js), which this form
  // does not admit — same pattern as audit-cv-flag-contradiction.js's
  // excluded --update-baseline above. Network is a one-shot, page-capped
  // `gh api` GET (no polling), which is exactly why it cannot ride the
  // generic audit-/lint- basename form (its transitive scanner refuses any
  // spawn). Flag shape is fixed, and NARROWER
  // than the CLI's own parseCliArgs ranges on purpose: a card's text is
  // untrusted, and `--min 0` or `--days 1` would let it choose a vacuous
  // threshold or window and collect a PASS (Codex ship-check finding). So
  // the unattended form admits only --days 7-365 (7-9, 10-99, 100-399; the
  // CLI rejects >365 with exit 2), --min 50-100, and a literal --json — no
  // free-form values. Exit 0 ONLY on PASS (rate >= --min AND >= 10 scored
  // runs AND no cancel storm AND a complete window), 1 on FAIL, 2 on fetch
  // error, and an empty window is a FAIL, so the exit code is a real
  // pass/fail signal, never vacuous (contrast the bare `gh run list` shape
  // refused above).
  { re: /^node scripts\/ci-green-rate\.js(?: --days (?:[7-9]|[1-9]\d|[1-3]\d\d))?(?: --min (?:100|[5-9]\d))?(?: --json)?$/ },
];

// Belt-and-braces mutation gate (plan-review pre-mortem root cause): the
// strict forms above already exclude arbitrary `node scripts/x.js`, but any
// future form widening must never let a check command reference the scripts
// that WRITE shared data — a verify re-run against a stale local clone is the
// repo's documented corruption hazard (feedback_local_rebuild_stale_clone_hazard).
// Applied to every path token in every form, present and future.
// fix-/ingest- added (task #1827) as defense-in-depth alongside push-/send-
// — belt-and-braces only; see the generic audit-/lint- form's comment above
// for why this alone doesn't cover every mutating script sharing an
// audit-/lint- prefix.
const MUTATING_SCRIPT_RE = /(^|\/)(rebuild-all-reviews|gather-reviews|collect-review-texts)\.(m|c)?js$|(^|\/)(push|send|fix|ingest)-[^/]*\.(m|c)?js$/i;

// BRO-2546: every caller used to get one bit back ("safe" or "not safe") and
// then had to invent its own explanation for the refusal. enrich-card-
// acceptance.js invented "command is not a safe-form shape", which is simply
// wrong for the most common real refusal: `test -f data/shows.json` is
// PERFECTLY shaped, it just names a directory the `test -f` form's prefix
// allowlist (docs/ memory/ tests/ src/ scripts/) does not cover. A card
// author told "not a safe-form shape" rewrites a well-formed command and gets
// refused again — measured as 7-of-8 enrichment failures on 2026-08-30, with
// two live cards (BRO-2311, BRO-2538) refusing mid-dispatch for exactly this.
//
// So the decision and its REASON are produced together, by one function, and
// isSafeCheckCommand is a thin `.ok` on top of it — there is no second copy of
// the rules that could drift (CLAUDE.md §15).
//
// `kind` is a stable machine-readable tag so callers can BRANCH on the cause
// (the enricher re-prompts differently for 'shape' than for 'path-prefix')
// rather than string-matching a human sentence:
//   'shape'           — no SAFE_CHECK_FORMS regex matched the command at all
//   'path-prefix'     — correct shape, file argument outside the allowed dirs
//   'traversal'       — correct shape, argument contains a `..` segment
//   'mutating-script' — correct shape, argument names a data-mutating script
//   'basename'        — correct shape, script not on the vetted allowlist
// A command matching several forms is safe if ANY form fully accepts it, so
// the failure reported is the first matching form's — the most specific
// diagnosis available, and never a refusal for a command that is in fact ok.
// BRO-5930: plain `node --test x.test.ts` can never run (no TS loader, `@/`
// aliases), so SAFE_CHECK_FORMS refuse it. The refusal stays kind 'shape'
// (consumers branch on it); this names the form that WOULD arm. Only offered
// when the rewritten command itself passes the gate, so the hint is never a
// second refusal.
function suggestTsxRewrite(cmd) {
  const m = /^node --test((?: --test-timeout \d+)?(?: [\w@./-]+\.test\.(?:m?js|ts))+)$/.exec(String(cmd || '').trim());
  if (!m || !/\.test\.ts(?= |$)/.test(m[1])) return null;
  const rewrite = `npx tsx --test${m[1]}`;
  return explainUnsafeCheckCommand(rewrite).ok ? rewrite : null;
}

function explainUnsafeCheckCommand(cmd) {
  const s = String(cmd || '').trim();
  let firstFailure = null;
  for (const form of SAFE_CHECK_FORMS) {
    const m = form.re.exec(s);
    if (!m) continue;
    if (!form.pathsGroup) return { ok: true, kind: null, reason: null, path: null };
    const args = m[form.pathsGroup].trim().split(/\s+/);
    let failure = null;
    for (const a of args) {
      if (a.split('/').includes('..')) {
        failure = { kind: 'traversal', path: a, reason: `path argument contains a '..' traversal segment: ${a}` };
        break;
      }
      // .test.* files are harmless test runs even when their name shares a
      // push-/send- prefix; everything else gets the mutation deny (case-
      // insensitive — APFS is case-insensitive — and covers .mjs/.cjs).
      // .test.ts included explicitly (BRO-2218 ship-check, echoed by two
      // independent reviewers): MUTATING_SCRIPT_RE's own `.(m|c)?js$` suffix
      // never matches `.ts` anyway, so this arm is currently a no-op for that
      // extension — but leaving it unlisted reads as "someone forgot .ts",
      // and silently depends on MUTATING_SCRIPT_RE never being widened to
      // cover `.ts` mutating scripts in the future. Spelling it out here
      // keeps the carve-out's own suffix list in sync with what
      // SAFE_CHECK_FORMS actually allows, independent of that future.
      if (!/\.test\.(?:(?:m|c)?js|ts)$/i.test(a) && MUTATING_SCRIPT_RE.test(a)) {
        failure = { kind: 'mutating-script', path: a, reason: `path argument names a data-mutating script, which a verify command may never run: ${a}` };
        break;
      }
      if (!form.pathPrefix.some(p => a.startsWith(p))) {
        failure = {
          kind: 'path-prefix',
          path: a,
          reason: `command shape is valid but the path '${a}' is not under an allowed directory for this form (allowed prefixes: ${form.pathPrefix.join(', ')})`,
        };
        break;
      }
      // allowBasenames (task #1827's generic audit-/lint- form only): an
      // ALLOWLIST, not a denylist — see AUDIT_LINT_GENERIC_FORM_ALLOWED's
      // comment for why. Case-insensitive comparison, same reasoning as
      // MUTATING_SCRIPT_RE's /i above: APFS resolves `Audit-Review-
      // Contamination.js` to the SAME real file as the lowercase allowlist
      // entry, so a case-sensitive Set.has() would be trivially bypassable
      // in the denylist design this replaced (ship-check finding) — kept
      // case-insensitive here too even though an allowlist fails closed by
      // default, since a case-varied match should still resolve to the one
      // vetted script, not silently refuse a legitimate command.
      if (form.allowBasenames && !form.allowBasenames.has(path.basename(a).toLowerCase())) {
        failure = {
          kind: 'basename',
          path: a,
          reason: `command shape is valid but '${path.basename(a)}' is not on the vetted read-only allowlist for this form (allowed: ${[...form.allowBasenames].join(', ')})`,
        };
        break;
      }
    }
    if (!failure) return { ok: true, kind: null, reason: null, path: null };
    if (!firstFailure) firstFailure = failure;
  }
  if (firstFailure) return { ok: false, ...firstFailure };
  const rewrite = suggestTsxRewrite(s);
  return {
    ok: false,
    kind: 'shape',
    path: null,
    reason: `command matches none of the allowed safe-check forms: ${s.slice(0, 120)}`,
    ...(rewrite ? { hint: `\`${s.slice(0, 120)}\` cannot run under plain node (it cannot resolve this repo's TS imports); use: ${rewrite}` } : {}),
  };
}

function isSafeCheckCommand(cmd) {
  return explainUnsafeCheckCommand(cmd).ok;
}

const SAFE_CHECK_DESCRIPTION = '`node scripts/lib/ux-walkthrough-resolution.js --key=HEX` (read-only UX acceptance: exactly 32 lowercase hex characters identifying this filing; requires a noise-resolution comment or visual approval landing record), `node scripts/lib/verify-data-backfill.js --show=ID[,ID] [--images] [--reviews=N] [--type=TYPE]` (read-only show/image/scored-review/type backfill acceptance, flags in that order), `node --test <*.test.mjs/*.test.js files under tests/, scripts/, or src/>`, `npx tsx --test <*.test.mjs/*.test.js/*.test.ts files under tests/, scripts/, or src/>` (use this instead of `node --test` when the file imports a TS module — via the `@/` alias, or a plain relative TS import whose own internal imports are extensionless; use a `.test.ts` file extension when the test itself is TypeScript), `npx tsc --noEmit`, `npm run lint`, `test -f <docs|memory|tests|src|scripts path>`, `node scripts/check-health-row-absent.js --row-b64 <base64url row name> [--live]` (health-digest rows only; --live verifies same-day instead of against yesterday\'s snapshot), `node scripts/check-alert-condition-absent.js --key-b64 <base64url conditionKey>` (owner-alert-router conditions; exit 0 once the alert ledger shows the condition resolved or quiet), `node scripts/check-review-item-resolved.js --claim=KEY|--closure=SLUG|--held-empty|--issue-closed=N` (commercial review cards; exit 0 once the pending row is gone or the show has a reviewed designation), `bash ~/.claude/hooks/tests/run-all.sh` (bare only; the claude-config hook fixture suite, interactive Mac sessions only: the shell-free automated runners do not expand ~ and will not run it), `node scripts/check-coverage-probe-clean.js` (Coverage Verdict S5 acceptance), `node scripts/check-canary-marker.js --date=YYYY-MM-DD` (Digest-autofix S6 canary acceptance), `node scripts/validate-data.js [--strict]`, `node scripts/run-unit-tests.js` (bare only — local equivalent of the CI "Unit Tests" job), `node scripts/scoring-delta.js` (bare only), `node scripts/test-temporal-override-regression.js`, `node scripts/audit-stale-flag-after-url-correction.js [--gate] [--max=N] [--json]`, `node scripts/audit-help-flag-safety.js`, `node scripts/audit-workflow-hygiene.js`, `node scripts/audit-aggregator-archive-integrity.js [--strict]`, `node scripts/audit-sibling-title-misroute.js` (bare only), `node scripts/audit-orphan-tests.js`, `node scripts/audit-cv-flag-contradiction.js [--window=N] [--strict]` (never --update-baseline), `node scripts/fix-shared-ibdb-urls.js --dry-run` (--dry-run required), `node scripts/lib/check-sb-credits.js`, `node scripts/audit-review-contamination.js [--strict]`, `node scripts/lint-resend-calls.js`, `node scripts/audit-worktree-unpushed.js` (with at most ONE optional flag from --strict/--gate/--json/--dry-run/--window=N/--max=N — no OTHER audit-*.js/lint-*.js script is accepted this way; most of this repo\'s audit scripts write shared repo state on every run), `node scripts/lint-committed-pii.js`, `bash scripts/lib/<name>.test.sh` (only the individually-vetted names sync-audit-checkout.test.sh and push-with-retry.stranded-commit-cascade.test.sh — not every *.test.sh in the repo), `node scripts/check-workflow-run-status.js --workflow=NAME --expect=CONCLUSION [--branch=NAME] [--limit=1-50 [--min-match=K] [--max-match=K]]` (flags in that order; with --limit only the N most recent COMPLETED runs count and fewer than N fails; asserts the most recent matching gh run\'s conclusion, or with --limit how many of the last N concluded it — NOT a bare `gh run list`, which is not a real pass/fail check; quote any value containing spaces, no backslashes), `node scripts/extract-show-score-reviews.js --check` (read-only — --check required, bare form still mutates), or `node scripts/ci-green-rate.js [--days 7-365] [--min 50-100] [--json]` (machine PASS/FAIL verdict on main\'s Test Suite green rate — read-only, one gh api GET; narrower ranges than the CLI itself accepts, so a card cannot pick a vacuous window or threshold)';

// isSafeCheckCommand only validates SHAPE (prompt-injection gate) — it never
// checks the path is real, so an LLM that invents a plausible-but-wrong test
// path (e.g. tests/review-write-guard.test.mjs instead of the real
// tests/unit/review-write-guard.test.mjs) sails through validation, gets
// queued, and burns a full executor run before failing at the check step
// (card #171, 2026-07-14: $1.38 spent on a card that could never pass).
// Extracts the same path tokens isSafeCheckCommand matches on, for a
// downstream existence check.
function extractCheckPaths(cmd) {
  const s = String(cmd || '').trim();
  for (const form of SAFE_CHECK_FORMS) {
    const m = form.re.exec(s);
    if (!m || !form.pathsGroup) continue;
    return m[form.pathsGroup].trim().split(/\s+/);
  }
  return [];
}

const REPO_ROOT = path.join(__dirname, '..', '..');

// String.replace() rewrites only the FIRST occurrence, so a command naming the
// same phantom path twice (`node --test tests/x.test.mjs tests/x.test.mjs`)
// would come back half-corrected and fail at exec time. Token-boundary split
// avoids a regex (the paths contain `.` and `/`) and never touches a substring
// of a longer path.
function replaceAllTokens(cmd, from, to) {
  return cmd.split(' ').map(t => (t === from ? to : t)).join(' ');
}

// Deterministic post-validation guard: runs once, no extra LLM call (a
// missing path is a fact about the filesystem, not a model mistake worth a
// retry). Only meaningful for eligible verdicts — an ineligible card's check
// never executes. tests/unit/<basename> is the one "obvious near-match" this
// repo's layout actually produces (every *.test.mjs lives there) — but only
// within the tests/ family: a missing scripts/*.test.mjs or docs/*.md path
// must NOT be "corrected" against an unrelated tests/unit/ file that merely
// shares a basename (ship-check finding — SAFE_CHECK_FORMS explicitly allows
// scripts/ and docs/|memory/ targets too, so cross-directory guessing risks
// silently validating the wrong file).
//
// NEW-ARTIFACT ALLOWANCE (2026-07-26, card #529): "the path does not exist"
// is NOT by itself evidence of a hallucination — the repo's own convention
// (CLAUDE.md §15) is that a fix ships WITH a new colocated test, and the
// `test -f <path>` safe form is by definition an assertion about a file the
// work is supposed to CREATE. Vetoing every missing path made `test -f`
// structurally impossible to pass triage and killed 3 in-scope cards in the
// 2026-07-26 live run (review-census, watchlist-rate-control,
// opening-night-checklist) purely because their proof command named the test
// they would write. So: after the near-match correction fails, a missing path
// whose PARENT DIRECTORY exists on disk is accepted as a to-be-created
// artifact and reported in `newPaths` (the executor prompt tells the
// implementer it must create them; exec-time check re-validation is
// shape-only, so an uncreated file simply fails the card's own check). A
// missing path whose parent directory does not exist is still a fabricated
// location and fails closed, except for ONE missing level under an existing
// non-root grandparent in src/, scripts/, docs/, memory/ (BRO-2625; see the branch below).
//
// The card #171 protection is UNCHANGED: its phantom
// (tests/review-write-guard.test.mjs) has a real tests/unit/ near-match, and
// the near-match correction runs first — the allowance below is only reached
// when no such file exists anywhere the resolver knows to look. New test
// files named directly under tests/ are additionally canonicalized into
// tests/unit/ so the loop can't scatter them outside the repo's convention.
function resolveCheckPaths(checkableDone, opts = {}) {
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const paths = extractCheckPaths(checkableDone);
  if (paths.length === 0) return { ok: true, checkableDone }; // tsc/lint forms carry no file args
  // isFile, not existsSync: `test -f scripts/lib` and `node --test tests/unit`
  // name real DIRECTORIES, and `test -f <dir>` always exits 1 — treating them
  // as "exists" queued an unpassable card that burned a whole executor
  // envelope (ship-check finding). A directory is neither a satisfied check
  // nor a creatable artifact, so it falls through to the veto below.
  const exists = p => { try { return fs.statSync(path.join(repoRoot, p)).isFile(); } catch { return false; } };
  const dirExists = p => { try { return fs.statSync(path.join(repoRoot, path.dirname(p))).isDirectory(); } catch { return false; } };
  const isDir = p => { try { return fs.statSync(path.join(repoRoot, p)).isDirectory(); } catch { return false; } };
  let corrected = checkableDone;
  let anyCorrection = false;
  const newPaths = [];
  const seen = new Set();
  for (const p of paths) {
    if (seen.has(p)) continue; // `node --test a.test.mjs a.test.mjs` — resolve each token once
    seen.add(p);
    if (exists(p)) continue;
    // An existing DIRECTORY is not a file the check can pass on and not an
    // artifact the implementer can create — fail closed rather than let the
    // new-artifact branch below "create" a path that is already occupied.
    if (isDir(p)) {
      return { ok: false, reason: `checkableDone names a directory, not a file: ${p}` };
    }
    // DIRECT children of tests/ only. `tests/integration/login.test.mjs` names
    // a deliberate, non-unit location — rewriting it to tests/unit/ (which the
    // old startsWith('tests/') test did at any depth) would silently redirect
    // the implementer to the wrong suite, and the ship-check Codex pass called
    // that out as the highest-risk part of this change. A missing path in a
    // real subdirectory now falls through to the new-artifact branch below,
    // which creates it exactly where the card asked.
    const nearMatch = /^tests\/[^/]+$/.test(p) ? `tests/unit/${path.basename(p)}` : null;
    if (nearMatch && nearMatch !== p && exists(nearMatch)) {
      corrected = replaceAllTokens(corrected, p, nearMatch);
      anyCorrection = true;
      continue;
    }
    // Canonicalize a brand-new test named at tests/<name> into tests/unit/.
    const target = nearMatch && nearMatch !== p && dirExists(nearMatch) ? nearMatch : p;
    if (dirExists(target)) {
      if (target !== p) { corrected = replaceAllTokens(corrected, p, target); anyCorrection = true; }
      newPaths.push(target);
      continue;
    }
    // BRO-2625: ONE missing directory level is forgiven under src/, scripts/, docs/ or memory/ when
    // the grandparent exists and is not the repo root (`src/new-feature/index.ts` with `src/`
    // present). tests/ is excluded on purpose: new tests belong in tests/unit/, and an invented
    // tests/<dir>/ is the card #171 phantom. Deeper chains and a missing top-level root stay vetoed.
    const grandparent = path.dirname(path.dirname(p));
    const fileShaped = !/\/\.?$/.test(p) && !p.split('/').includes('..');
    if (fileShaped && /^(src|scripts|docs|memory)\//.test(p) && grandparent !== '.' && isDir(grandparent)) {
      newPaths.push(p);
      continue;
    }
    return { ok: false, reason: `checkableDone references a path in a directory that does not exist on disk: ${p}${nearMatch ? ` (tried near-match ${nearMatch})` : ''}` };
  }
  return { ok: true, checkableDone: corrected, corrected: anyCorrection, newPaths };
}

module.exports = {
  SAFE_CHECK_FORMS,
  AUDIT_LINT_GENERIC_FORM_ALLOWED,
  BASH_INTEGRATION_TEST_SH_ALLOWED,
  SAFE_CHECK_DESCRIPTION,
  isSafeCheckCommand,
  explainUnsafeCheckCommand,
  extractCheckPaths,
  resolveCheckPaths,
};
