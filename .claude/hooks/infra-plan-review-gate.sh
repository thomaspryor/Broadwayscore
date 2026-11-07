#!/usr/bin/env bash
# infra-plan-review-gate.sh — PreToolUse on Edit|Write|MultiEdit|NotebookEdit|Bash.
#
# The pre-IMPLEMENTATION half of the review chain (Notion 3b4637c5, task #1079;
# owner mandate task #672: "no review gate fires BEFORE implementation — every
# hook catches sessions at Stop/push, after the code exists").
#
# Owner decision 2026-08-05: sessions changing shared infrastructure ship plans
# that look obviously correct to their author and are not. One plan that day
# carried four defects — a P0 that would have credited spendCircuitBreakerStatus
# completions it did not earn, a "fix" reverting a deliberate ordering decision
# documented at scripts/lib/backlog-drain.js:1-23, a concurrency bump already
# known-blocked by worktree lock contention, and a watcher pointed at a
# gitignored path. All four were caught only because the owner asked for a
# review. This gate asks for it automatically, before the first edit.
#
# ⚠️  EDITING THIS FILE — READ FIRST (learned the hard way, 2026-08-06)
# A SYNTAX error here wedges Edit/Write/MultiEdit/NotebookEdit/Bash for EVERY
# session on this machine, because the harness treats a crashed PreToolUse hook
# as a block. The INFRA_REVIEW_GATE_DISABLE kill switch below does NOT save you:
# bash fails to parse the file before ever reaching that line. The session that
# breaks it cannot repair it — no write path survives — and the owner has to
# intervene from an external terminal. That happened during this file's own
# round-3 edit.
# So: NEVER edit this path directly. Write to a temp file, `bash -n` it there,
# and only then move it into place:
#   cp new.sh /tmp/gate.staged && bash -n /tmp/gate.staged && cp /tmp/gate.staged \
#     ~/.claude/hooks/infra-plan-review-gate.sh
# Owner recovery if it is already wedged, from a normal terminal:
#   printf '#!/usr/bin/env bash\nexit 0\n' > ~/.claude/hooks/infra-plan-review-gate.sh
#
# WHAT IT DOES
#   critical tier (dispatch layer, spend/run-budget guards, concurrency + push
#     primitives, the review gates, merge/deploy-gating CI, hooks) → BLOCK until
#     a pre-implementation review is on record for this session
#   shared tier (wider scripts/lib, other workflows) → WARN only, recorded to
#     the telemetry ledger. The policy's evidence is n=1; the warn tier is how
#     the base rate becomes a measured number before widening the block.
#   everything else → silent
#
# Scope + decision logic: scripts/lib/infra-review-scope.js (pure, tested by
# scripts/tests/infra-review-gate.test.mjs). Ledger read/write:
# scripts/lib/review-gate.mjs --query=infra-edit-allowed / --query=record-plan.
# One ledger, shared with the push-time gate.
#
# SATISFYING THE GATE
#   /plan-review  or  /second-opinion  on the plan, then:
#     node scripts/lib/review-gate.mjs --query=record-plan \
#       --reviewer=plan-review --result=pass --session-id=$CLAUDE_CODE_SESSION_ID
#
# ESCAPES, in order of preference
#   1. run the review (that is the point)
#   2. `NO-PLAN-REVIEW: <reason ≥15 chars>` in the turn — downgrades to a warn
#      and is RECORDED, so habitual bypassing shows up in the audit ledger
#   3. blocked twice on the same file → fails open automatically, so a headless
#      session with no human to answer can never spin
#   4. INFRA_REVIEW_GATE_DISABLE=1 — emergency kill switch (logic paths only;
#      see the syntax-error warning above)
#
# FAIL-OPEN IS ABSOLUTE for every logic path: missing jq/node, unreadable or
# corrupt ledger, bad JSON on stdin, unresolvable repo root, a hung patch read.
# The pre-mortem's primary scenario was a corrupt ledger line hard-blocking the
# fleet; that path is covered and tested.

# Self-skip preamble (project copy only): if the user-level master exists, it is
# the registered one on local CLI — let it fire and exit here.
if [ -f "$HOME/.claude/hooks/infra-plan-review-gate.sh" ] && \
   [ "${BASH_SOURCE[0]}" != "$HOME/.claude/hooks/infra-plan-review-gate.sh" ]; then
  exit 0
fi

[ "${INFRA_REVIEW_GATE_DISABLE:-0}" = "1" ] && exit 0

input=$(cat)

# ── everything below is best-effort; any failure means "allow" ───────────────
verdict_out=""
gate_status=0
verdict_out=$(
  set +e
  command -v jq >/dev/null 2>&1 || exit 0
  command -v node >/dev/null 2>&1 || exit 0

  session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
  transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)

  # Candidate paths. Edit/Write/NotebookEdit/MultiEdit carry file_path; Bash
  # carries a command that may write files without touching an edit tool — the
  # dodge the /plan-review reviewers flagged as the biggest hole.
  paths=$(printf '%s' "$input" | jq -r '
    [ .tool_input.file_path?,
      .tool_input.notebook_path?,
      (.tool_input.edits? // [] | .[]?.file_path?)
    ] | map(select(. != null and . != "")) | .[]' 2>/dev/null)

  command_str=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)

  # Resolve the repo root so worktree paths normalise. Without this, sessions in
  # .claude/worktrees/* are invisible to the classifier and the gate observes
  # nothing while looking enforced.
  SESSION_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  _GIT_COMMON=$(git -C "${SESSION_ROOT:-.}" rev-parse --git-common-dir 2>/dev/null)
  if [ -n "$_GIT_COMMON" ]; then
    case "$_GIT_COMMON" in
      /*) CANONICAL_ROOT=$(dirname "$_GIT_COMMON") ;;
      *)  CANONICAL_ROOT=$(dirname "$SESSION_ROOT/$_GIT_COMMON") ;;
    esac
  else
    CANONICAL_ROOT="$SESSION_ROOT"
  fi
  [ -z "$CANONICAL_ROOT" ] && exit 0

  GATE="$CANONICAL_ROOT/scripts/lib/review-gate.mjs"
  SCOPE="$CANONICAL_ROOT/scripts/lib/infra-review-scope.js"
  SCAN="$CANONICAL_ROOT/scripts/lib/transcript-scan.mjs"
  # Only repos carrying the libs are gated (i.e. Broadwayscore).
  [ -f "$GATE" ] || exit 0
  [ -f "$SCOPE" ] || exit 0

  # Shell write targets for Bash calls, including files named INSIDE an applied
  # patch (`git apply f` writes what the diff names, not f).
  if [ -n "$command_str" ]; then
    # The untrusted value ($command_str is whatever the session typed) is passed
    # ONLY through the environment, never interpolated into a shell string.
    # Round 3 briefly built `timeout 5 bash -c "...command_str='$command_str'..."`;
    # a single quote in the command closed that assignment and executed arbitrary
    # shell inside this hook — proven with a probe that created a file.
    # `node -e "$_NODE_SRC"` is safe: -e takes one argv element, nothing reparses.
    #
    # HARD TIMEOUT because this block touches the disk and a patch path can be a
    # FIFO with no writer or a symlink to /dev/zero — readFileSync on those
    # blocks forever (measured: still blocked after 5s, needed kill -9).
    _NODE_SRC='
      const fs = require("fs"), path = require("path");
      // 1 MB is far beyond any real source patch; larger is a blob or a stall.
      const MAX_PATCH_BYTES = 1024 * 1024;
      try {
        const s = require(process.env.SCOPE_LIB);
        const out = new Set(s.bashWriteTargets(process.env.CMD));
        // Relative patch paths: `cd sub && git apply rel.diff` resolves against
        // the session cwd, not the repo root. Try both, plus the literal path.
        const roots = [process.env.SESSION_CWD, process.env.REPO, ""];
        for (const src of s.bashPatchSources(process.env.CMD)) {
          const cands = path.isAbsolute(src) ? [src] : roots.map((r) => (r ? path.join(r, src) : src));
          for (const p of cands) {
            try {
              // lstat, not stat: a symlink named foo.diff pointing at /dev/zero
              // passes bashPatchSources (only literal /dev/ paths are filtered
              // there) and would read forever.
              const st = fs.lstatSync(p);
              if (!st.isFile() || st.size > MAX_PATCH_BYTES) continue;
              s.patchTargets(fs.readFileSync(p, "utf8")).forEach((t) => out.add(t));
              break;
            } catch { /* try the next candidate root */ }
          }
        }
        process.stdout.write([...out].join("\n"));
      } catch { /* fail open */ }
    '
    if command -v timeout >/dev/null 2>&1; then
      bash_paths=$(SCOPE_LIB="$SCOPE" CMD="$command_str" REPO="$CANONICAL_ROOT" SESSION_CWD="$PWD" \
        timeout 5 node -e "$_NODE_SRC" 2>/dev/null)
    else
      # Stock macOS has no coreutils timeout: run node in the background and let
      # a watchdog kill it. Same env-only argument passing, no shell string.
      bash_paths=$(
        SCOPE_LIB="$SCOPE" CMD="$command_str" REPO="$CANONICAL_ROOT" SESSION_CWD="$PWD" \
          node -e "$_NODE_SRC" 2>/dev/null &
        _np=$!
        ( sleep 5; kill -9 $_np 2>/dev/null ) &
        _wd=$!
        wait $_np 2>/dev/null
        kill $_wd 2>/dev/null
      )
    fi
    [ -n "$bash_paths" ] && paths=$(printf '%s\n%s' "$paths" "$bash_paths")
  fi
  paths=$(printf '%s' "$paths" | sed '/^[[:space:]]*$/d')
  [ -z "$paths" ] && exit 0

  # Repeat-block counter, per session + resolved path list. Fails open after
  # MAX_BLOCKS so a headless session cannot loop the same blocked edit.
  STATE_DIR="${TMPDIR:-/tmp}/bsc-infra-review-gate"
  mkdir -p "$STATE_DIR" 2>/dev/null
  key=$(printf '%s|%s' "$session_id" "$paths" | shasum -a 256 2>/dev/null | cut -c1-16)
  [ -z "$key" ] && key="nokey"
  prior=$(cat "$STATE_DIR/$key" 2>/dev/null || echo 0)
  case "$prior" in (*[!0-9]*) prior=0 ;; esac

  # NO-PLAN-REVIEW bypass: in the in-flight assistant turn, or as a shell
  # comment in the gated command itself (the transcript scan can never see
  # in-flight text — same reason pre-push-review-gate.sh checks both).
  bypass=false
  if printf '%s' "$command_str" | grep -qE '#[[:space:]]*NO-PLAN-REVIEW:[[:space:]]*\S.{14,}'; then
    bypass=true
  elif [ -n "$transcript" ] && [ -f "$transcript" ] && [ -f "$SCAN" ]; then
    if node "$SCAN" --transcript="$transcript" --query=bypass-token --token=NO-PLAN-REVIEW 2>/dev/null | grep -q true; then
      bypass=true
    fi
  fi

  # First line is the counter key, the rest is the verdict JSON. The key MUST be
  # emitted from here rather than recomputed below: it is derived from `$paths`,
  # which for a Bash call includes bashWriteTargets output the outer scope
  # cannot reconstruct from tool_input alone. Recomputing produced a different
  # hash for every Bash block, so the counter incremented under one key while
  # the gate read another — the fail-open-after-N-blocks valve never fired.
  printf '%s\n' "$key"
  node "$GATE" --query=infra-edit-allowed \
    --repo="$CANONICAL_ROOT" \
    --paths="$paths" \
    --session-id="$session_id" \
    --prior-blocks="$prior" \
    --bypass="$bypass" 2>/dev/null
) || gate_status=$?

[ -n "$verdict_out" ] || exit 0
[ "$gate_status" -eq 0 ] || exit 0

COUNTER_KEY=$(printf '%s' "$verdict_out" | head -1)
verdict_out=$(printf '%s' "$verdict_out" | tail -n +2)
# Key alone with no verdict = the node call produced nothing. Fail open.
[ -n "$verdict_out" ] || exit 0

action=$(printf '%s' "$verdict_out" | jq -r '.action // "allow"' 2>/dev/null)
[ -z "$action" ] && exit 0
[ "$action" = "allow" ] && exit 0

# ── telemetry ────────────────────────────────────────────────────────────────
# Every warn and every block is recorded. Without this the policy is
# unobservable: a successful review and a rubber-stamped bypass look identical
# from the owner's side, and the base rate stays n=1.
SESSION_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
_GIT_COMMON=$(git -C "${SESSION_ROOT:-.}" rev-parse --git-common-dir 2>/dev/null)
if [ -n "$_GIT_COMMON" ]; then
  case "$_GIT_COMMON" in
    /*) LEDGER_ROOT=$(dirname "$_GIT_COMMON") ;;
    *)  LEDGER_ROOT=$(dirname "$SESSION_ROOT/$_GIT_COMMON") ;;
  esac
else
  LEDGER_ROOT="$SESSION_ROOT"
fi
if [ -n "$LEDGER_ROOT" ] && [ -d "$LEDGER_ROOT/data" ]; then
  mkdir -p "$LEDGER_ROOT/data/audit" 2>/dev/null
  printf '%s\n' "$(printf '%s' "$verdict_out" | jq -c --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{ts:$ts} + .' 2>/dev/null)" \
    >> "$LEDGER_ROOT/data/audit/infra-review-gate.jsonl" 2>/dev/null
fi

[ "$action" != "block" ] && exit 0

# ── block ────────────────────────────────────────────────────────────────────
# Increment the SAME key the subshell read from, so the fail-open-after-N-blocks
# valve actually observes its own increments.
STATE_DIR="${TMPDIR:-/tmp}/bsc-infra-review-gate"
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
if [ -n "$COUNTER_KEY" ]; then
  prior=$(cat "$STATE_DIR/$COUNTER_KEY" 2>/dev/null || echo 0)
  case "$prior" in (*[!0-9]*) prior=0 ;; esac
  echo $((prior + 1)) > "$STATE_DIR/$COUNTER_KEY" 2>/dev/null
fi

label=$(printf '%s' "$verdict_out" | jq -r '.matched[0].label // "shared infrastructure"' 2>/dev/null)
why=$(printf '%s' "$verdict_out" | jq -r '.matched[0].why // ""' 2>/dev/null)
files=$(printf '%s' "$verdict_out" | jq -r '[.matched[].path] | join(", ")' 2>/dev/null)

cat >&2 <<EOF
[automation note — owner can ignore] 🛑 INFRA PLAN REVIEW GATE: shared-infrastructure edit needs a review first ($label: $files). Why: $why
1. Run /second-opinion (or /plan-review if structural). If the reviewer says no, the reviewer wins.
2. node scripts/lib/review-gate.mjs --query=record-plan --reviewer=second-opinion --result=pass --session-id=$session_id
3. Retry this edit. Genuine exception (audited): NO-PLAN-REVIEW: <reason, at least 15 characters>
Full rules: ~/.claude/hooks/GATES.md
EOF
exit 2
