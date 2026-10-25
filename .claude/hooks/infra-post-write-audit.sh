#!/usr/bin/env bash
# infra-post-write-audit.sh — PostToolUse on Bash. Post-hoc backstop for
# infra-plan-review-gate.sh (task #1079 / BRO-2311).
#
# WHY THIS EXISTS
# infra-plan-review-gate.sh's Bash arm parses the COMMAND STRING for
# patch-shaped writes (sed -i, tee, cp, git apply, …). `python3 script.py`,
# where script.py does its own pathlib.Path.write_text() on a gated file, is
# opaque to that parser — the gated path never appears in the command string
# at all. Confirmed in-session (BRO-2311): a hooks/*.sh file was edited this
# way with zero verdict on record and the pre-hoc gate never fired — later in
# the SAME session, an ordinary Edit to the same file WAS blocked, which is
# how the gap was discovered rather than deduced.
#
# This hook closes that class by NOT parsing commands at all. It asks git,
# after every Bash call, "what does the working tree currently say changed"
# in the two repos the critical-tier rules can match — Broadwayscore (the
# session's own SESSION_ROOT, so parallel worktrees never see each other's
# dirt; uncommitted tracked edits + untracked new files only, see
# evaluate_repo — BRO-4070) and ~/.claude (`review-gate.mjs
# --query=changed-files --ref=WORKTREE`, run against $HOME/.claude directly).
# Until BRO-4070 a `[ -d .git ]` check made this hook skip every linked
# worktree, which is every place a code edit is allowed; the test suite's
# worktree cases (11-15) guard that. Zero new state, zero snapshot file, zero
# cold-start seeding window — git's own working-tree diff already answers
# "what changed since the last commit" correctly and instantly, which a
# hash-snapshot mechanism would have had to reinvent badly. (The first draft
# of this hook DID use a sha256 snapshot file; /second-opinion review of the
# BRO-2311 plan flagged cross-session races on a shared snapshot path,
# worktree-root ambiguity, and a cold-start blind spot where a reboot's fresh
# baseline silently absorbs a pending bypass. All three are structurally
# impossible here because there is no snapshot — git IS the snapshot.)
#
# KNOWN, ACCEPTED LIMITATION: ~/.claude is a single machine-wide checkout, not
# per-session like a Broadwayscore worktree — there is no way to scope "what
# THIS session wrote" there. A change any session makes to ~/.claude/hooks may
# get reported by a DIFFERENT session's next Bash call, not the one that made
# it. Accepted: the goal is surfacing an unreviewed change fast, not perfect
# attribution. The deliberate fix for the other half of this mismatch is
# --session-id="" on the ~/.claude-side infra-edit-allowed call below — a
# fleet-shared verdict check (ANY session's fresh plan-review verdict counts,
# since evaluateInfraReviewGate's session match is skipped when the query
# sessionId is falsy) and a fleet-shared repeat-block counter (so the valve
# doesn't reset per session and give each concurrent session its own 2 free
# blocks on the same shared file).
#
# Same preconditions/fail-open philosophy as infra-plan-review-gate.sh: only
# fires when the session's CANONICAL_ROOT carries the Broadwayscore libs
# (classification logic lives there — a session whose cwd never resolves to a
# Broadwayscore checkout is invisible to this hook, exactly like the pre-hoc
# gate already is). Any missing dep, unparsable JSON, or git failure means
# allow. Kill switch: INFRA_POST_AUDIT_DISABLE=1.
#
# This is DETECTION, not PREVENTION — the write already happened by the time
# this fires. A 'block' verdict here means "fix this on your next turn,"
# surfaced via PostToolUse's non-zero-exit-feeds-stderr-to-the-agent
# mechanism. It cannot undo the write, and deliberately does not try to.
#
# Deliberately Bash-only (not Edit|Write|MultiEdit|NotebookEdit): those tools
# already hand file_path straight to the pre-hoc gate, so post-hoc coverage
# there would be pure overhead for a class of write the pre-hoc gate already
# sees in full.

# Self-skip preamble (project copy only): if the user-level master exists, it
# is the registered one on local CLI — let it fire and exit here.
if [ -f "$HOME/.claude/hooks/infra-post-write-audit.sh" ] && \
   [ "${BASH_SOURCE[0]}" != "$HOME/.claude/hooks/infra-post-write-audit.sh" ]; then
  exit 0
fi

[ "${INFRA_POST_AUDIT_DISABLE:-0}" = "1" ] && exit 0

input=$(cat)

# ── everything below is best-effort; any failure means "allow" ───────────────
audit_out=""
audit_status=0
audit_out=$(
  set +e
  command -v jq >/dev/null 2>&1 || exit 0
  command -v node >/dev/null 2>&1 || exit 0

  session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
  transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
  command_str=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
  tool_name=$(printf '%s' "$input" | jq -r '.tool_name // "Bash"' 2>/dev/null)

  # `git -C <path> …` resolution, same as pre-push-review-gate.sh: the -C
  # target may not match the session's own cwd.
  _GIT_C=$(printf '%s' "$command_str" | grep -oE 'git[[:space:]]+-C[[:space:]]+[^[:space:];&|)]+' | head -1 | awk '{print $3}')
  GIT_C_REPO=""
  if [ -n "$_GIT_C" ]; then
    case "$_GIT_C" in
      \~/*)  _GIT_C="$HOME/${_GIT_C#\~/}" ;;
      \~)    _GIT_C="$HOME" ;;
    esac
    [ -d "$_GIT_C" ] && GIT_C_REPO=$(git -C "$_GIT_C" rev-parse --show-toplevel 2>/dev/null)
  fi

  SESSION_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  [ -z "$SESSION_ROOT" ] && SESSION_ROOT="$GIT_C_REPO"
  [ -z "$SESSION_ROOT" ] && exit 0

  _GIT_COMMON=$(git -C "$SESSION_ROOT" rev-parse --git-common-dir 2>/dev/null)
  if [ -z "$_GIT_COMMON" ]; then
    CANONICAL_ROOT="$SESSION_ROOT"
  else
    case "$_GIT_COMMON" in
      /*) CANONICAL_ROOT=$(dirname "$_GIT_COMMON") ;;
      *)  CANONICAL_ROOT=$(dirname "$SESSION_ROOT/$_GIT_COMMON") ;;
    esac
  fi

  GATE="$CANONICAL_ROOT/scripts/lib/review-gate.mjs"
  SCOPE="$CANONICAL_ROOT/scripts/lib/infra-review-scope.js"
  SCAN="$CANONICAL_ROOT/scripts/lib/transcript-scan.mjs"
  # Only sessions rooted at a checkout carrying the libs are audited (i.e.
  # Broadwayscore) — same convention as infra-plan-review-gate.sh.
  [ -f "$GATE" ] || exit 0
  [ -f "$SCOPE" ] || exit 0

  CLAUDE_DIR="$HOME/.claude"

  # Fast path: a pure-git check for "is there ANY working-tree diff at all,
  # in either repo, relative to its merge-base with origin/main" — the same
  # question diffRangeArgs()'s WORKTREE definition answers inside
  # review-gate.mjs, without paying for a node spawn (measured: ~480ms/call
  # with node vs this — a real cost multiplied across ~20+ concurrent
  # sessions' every Bash call; second-opinion-reviewed for fidelity to
  # resolveBase()/diffRangeArgs()). The overwhelming common case — a
  # read-only or non-mutating command, in a session with nothing critical
  # dirty — exits here. Correctness is preserved by construction: ANY
  # resolution failure or genuine working-tree diff (even a non-critical
  # one — this is intentionally not doing classification, just "is there
  # anything to possibly classify") falls through to the full node-based
  # path below rather than skip it.
  # `-e`, not `-d`: in a linked worktree .git is a FILE ("gitdir: …"), and
  # `-d` silently skipped every worktree — i.e. every place CLAUDE.md allows a
  # code edit (BRO-4070).
  quick_clean() { # quick_clean <repo> -> success (0) only if definitely nothing changed
    repo="$1"
    [ -e "$repo/.git" ] || return 0
    # Session side: only what is uncommitted right now (tracked edits + new
    # untracked files) — see uncommitted_files() below for why.
    if [ "$repo" != "$CLAUDE_DIR" ]; then
      [ -z "$(git -C "$repo" status --porcelain --untracked-files=normal 2>/dev/null)" ]
      return
    fi
    qbase=""
    for b in origin/main main; do
      git -C "$repo" rev-parse --verify --quiet "${b}^{commit}" >/dev/null 2>&1 && { qbase="$b"; break; }
    done
    [ -z "$qbase" ] && return 1
    qmb=$(git -C "$repo" merge-base "$qbase" HEAD 2>/dev/null) || qmb="$qbase"
    git -C "$repo" diff --quiet "$qmb" 2>/dev/null
  }
  if quick_clean "$SESSION_ROOT" && quick_clean "$CLAUDE_DIR"; then
    exit 0
  fi

  STATE_DIR="${TMPDIR:-/tmp}/bsc-infra-review-gate"
  mkdir -p "$STATE_DIR" 2>/dev/null

  # NO-PLAN-REVIEW bypass: same detection as infra-plan-review-gate.sh — an
  # in-command comment, or the in-flight transcript token.
  bypass=false
  if printf '%s' "$command_str" | grep -qE '#[[:space:]]*NO-PLAN-REVIEW:[[:space:]]*\S.{14,}'; then
    bypass=true
  elif [ -n "$transcript" ] && [ -f "$transcript" ] && [ -f "$SCAN" ]; then
    if node "$SCAN" --transcript="$transcript" --query=bypass-token --token=NO-PLAN-REVIEW 2>/dev/null | grep -q true; then
      bypass=true
    fi
  fi

  # Evaluate one repo's working-tree changes against infra-edit-allowed and
  # print a single-line JSON verdict (or nothing if there's no verdict to
  # give, i.e. no critical-tier changes). Args: <repo> <query-session-id>
  # <label-for-error-text>. query-session-id="" means "any session's fresh
  # verdict counts, and the repeat-block counter is fleet-shared" — used only
  # for the CLAUDE_DIR side (see the KNOWN LIMITATION note above).
  evaluate_repo() {
    repo="$1"; qsid="$2"; label="$3"
    [ -e "$repo/.git" ] || return 0

    if [ "$repo" = "$CLAUDE_DIR" ]; then
      files=$(node "$GATE" --query=changed-files --repo="$repo" --ref=WORKTREE --pattern='.*' 2>/dev/null | jq -r '.files[]? // empty' 2>/dev/null)
    else
      # Session side (BRO-4070): uncommitted tracked edits + untracked new
      # files, NOT the branch-vs-merge-base diff. A worktree branch always
      # carries its own already-reviewed commits; re-auditing them on every
      # Bash call false-blocks once the 4h plan verdict expires or a resumed
      # job runs under a new session id. And a plain diff never lists an
      # untracked file, so a script CREATING a new gated workflow was
      # invisible. Accepted gap: a script that writes AND commits in one
      # command leaves nothing uncommitted — pre-push-review-gate covers that
      # at push time.
      files=$( { git -C "$repo" diff --name-only HEAD 2>/dev/null; git -C "$repo" ls-files --others --exclude-standard 2>/dev/null; } | sort -u)
    fi
    [ -z "$files" ] && return 0

    # ~/.claude's own `changed-files` output is repo-relative (e.g.
    # "hooks/foo.sh") with no ".claude/" segment at all — infra-review-scope's
    # 'hooks' rule matches on the LITERAL tail "…/.claude/hooks/…", so a bare
    # repo-relative path from that repo would silently match nothing. Absolute
    # paths carry the segment naturally.
    if [ "$repo" = "$CLAUDE_DIR" ]; then
      files=$(printf '%s\n' "$files" | sed "s#^#$CLAUDE_DIR/#")
    fi

    key=$(printf '%s|%s' "$qsid" "$files" | shasum -a 256 2>/dev/null | cut -c1-16)
    [ -z "$key" ] && key="nokey-$label"
    prior=$(cat "$STATE_DIR/$key" 2>/dev/null || echo 0)
    case "$prior" in (*[!0-9]*) prior=0 ;; esac

    v=$(node "$GATE" --query=infra-edit-allowed \
      --repo="$CANONICAL_ROOT" \
      --paths="$files" \
      --session-id="$qsid" \
      --prior-blocks="$prior" \
      --bypass="$bypass" 2>/dev/null)
    [ -z "$v" ] && return 0

    action=$(printf '%s' "$v" | jq -r '.action // "allow"' 2>/dev/null)
    [ "$action" = "allow" ] && return 0

    if [ "$action" = "block" ]; then
      prior=$((prior + 1))
      echo "$prior" > "$STATE_DIR/$key" 2>/dev/null
    fi
    printf '%s\n' "$(printf '%s' "$v" | jq -c --arg label "$label" '. + {scope:$label}' 2>/dev/null)"
  }

  bsc_verdict=$(evaluate_repo "$SESSION_ROOT" "$session_id" "broadwayscore")
  claude_verdict=$(evaluate_repo "$CLAUDE_DIR" "" "claude-config")

  # ── telemetry: every warn and every block, both repos ───────────────────
  if [ -d "$CANONICAL_ROOT/data" ]; then
    mkdir -p "$CANONICAL_ROOT/data/audit" 2>/dev/null
    for v in "$bsc_verdict" "$claude_verdict"; do
      [ -z "$v" ] && continue
      printf '%s\n' "$(printf '%s' "$v" | jq -c --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg tool "$tool_name" \
        '{ts:$ts, detected_post_hoc:true, tool:$tool} + .' 2>/dev/null)" \
        >> "$CANONICAL_ROOT/data/audit/infra-review-gate.jsonl" 2>/dev/null
    done
  fi

  block=""
  for v in "$bsc_verdict" "$claude_verdict"; do
    [ -z "$v" ] && continue
    a=$(printf '%s' "$v" | jq -r '.action // "allow"' 2>/dev/null)
    [ "$a" = "block" ] && block="${block}${v}"$'\n'
  done
  [ -n "$block" ] && printf '%s' "$block"
) || audit_status=$?

[ -n "$audit_out" ] || exit 0
[ "$audit_status" -eq 0 ] || exit 0

# ── block ────────────────────────────────────────────────────────────────────
cat >&2 <<'HEADER'
[automation note — owner can ignore] 🛑 INFRA POST-WRITE AUDIT: shared infrastructure changed with no review on record (already written; this detects, it can't prevent).
HEADER

printf '%s\n' "$audit_out" | while IFS= read -r v; do
  [ -z "$v" ] && continue
  scope=$(printf '%s' "$v" | jq -r '.scope // "?"' 2>/dev/null)
  files=$(printf '%s' "$v" | jq -r '[.matched[].path] | join(", ")' 2>/dev/null)
  label=$(printf '%s' "$v" | jq -r '.matched[0].label // "shared infrastructure"' 2>/dev/null)
  echo "" >&2
  echo "  Scope:   $scope" >&2
  echo "  Editing: $files" >&2
  echo "  Class:   $label" >&2
done

cat >&2 <<'EOF'
Fix: if you made this change, run /second-opinion (or /plan-review), then
  node scripts/lib/review-gate.mjs --query=record-plan --reviewer=second-opinion --result=pass --session-id=$CLAUDE_CODE_SESSION_ID
If it is another session's WIP or already reviewed, say so and record NO-PLAN-REVIEW: <reason, at least 15 characters>
Full rules: ~/.claude/hooks/GATES.md
EOF
exit 2
