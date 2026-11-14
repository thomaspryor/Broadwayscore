#!/usr/bin/env bash
# BRO-7194: give cloud sessions that do NOT have Broadwayscore as their project (app repo
# or data repos only) the stall Stop gates (CHILDSTALL, WAKELESS, WAKEPROMISE, OPENCLAIM...).
# Why: a single-repo cloud session starts with cwd = that repo, so /home/user/.claude/settings.json
# (the home-hook-runner wiring) is never read and the repo's own .claude/settings.json is all
# there is. The app repo had none, so those sessions ended with no gate at all.
#
# Usage (from the app repo's .claude/settings.json):
#   SessionStart: bash .claude/hooks/stall-stop-bootstrap.sh fetch   (clone/refresh; may take ~10s)
#   Stop:         bash .claude/hooks/stall-stop-bootstrap.sh stop    (execs; fetches inline first if the runner is still missing)
# The app repo carries a byte-identical copy of this file (scripts/lib/stall-stop-bootstrap.test.mjs
# checks the committed copy when BSC_APP_REPO points at it).
#
# Finds home-hook-runner.sh in $BSC_HOOKS_HOME/{Broadwayscore,broadwayscore,.bsc-hooks}; the
# fetch step makes a sparse checkout (.claude, scripts, package.json: 107MB, ~6s) into
# .bsc-hooks only when neither full checkout exists, and fast-forwards it when it does.
# Fails open: any problem prints a systemMessage and exits 0.
set -u
mode="${1:-stop}"
HOME_DIR="${BSC_HOOKS_HOME:-/home/user}"
URL="${BSC_HOOKS_REPO_URL:-https://github.com/thomaspryor/Broadwayscore}"
PROMISE_FALLBACK='KEEP OPEN|check(ing)? back|report(ing)? back|I.ll (check|wait|come back|continue|report)|I.m (continuing|waiting)|will (check|report|continue)'
STALL_CODES='CHILDSTALL|CHILDWAIT|CHILDJOBS|CHILDWATCH|OPENCLAIM|WAKELESS|WAKEPROMISE'
msg() { printf '{"systemMessage":"%s"}\n' "$1"; }

find_runner() {
  local d
  for d in "$HOME_DIR/Broadwayscore" "$HOME_DIR/broadwayscore" "$HOME_DIR/.bsc-hooks"; do
    [ -f "$d/.claude/hooks/lib/home-hook-runner.sh" ] && [ -f "$d/.claude/hooks/verify-edits.sh" ] && { printf '%s' "$d/.claude/hooks/lib/home-hook-runner.sh"; return 0; }
  done
  return 1
}

case "$mode" in
  fetch)
    full=""
    for d in "$HOME_DIR/Broadwayscore" "$HOME_DIR/broadwayscore"; do [ -d "$d/.git" ] && full=1; done
    # A full clone that has a runner is enough. One that is still cloning (no runner yet): fall through
    # and sparse-clone into .bsc-hooks anyway (BRO-7194 probe 3), find_runner takes whichever is ready.
    [ -n "$full" ] && find_runner >/dev/null && exit 0
    S="$HOME_DIR/.bsc-hooks"
    command -v git >/dev/null 2>&1 || { msg "BRO-7194: git missing, stall Stop gate NOT installed."; exit 0; }
    if [ -d "$S/.git" ]; then
      git -C "$S" sparse-checkout set --no-cone '/.claude/' '/scripts/' '/package.json' 2>/dev/null; timeout 30 git -C "$S" fetch -q --depth 1 origin main 2>/dev/null && timeout 60 git -C "$S" reset -q --hard FETCH_HEAD 2>/dev/null
    else
      # Clone into a private temp dir, then rename: a concurrent session never sees a half-made
      # checkout and never has it deleted under it. Loser of the rename race just discards its copy.
      T="$S.tmp.$$"; rm -rf "$T"
      err="$( { GIT_TERMINAL_PROMPT=0 timeout 90 git clone -q --depth 1 --filter=blob:none --sparse "$URL" "$T" \
                && git -C "$T" sparse-checkout set --no-cone '/.claude/' '/scripts/' '/package.json'; } 2>&1 )"; rc=$?
      printf '%s rc=%s uid=%s home=%s\n%s\n' "$(date -u +%FT%TZ)" "$rc" "$(id -u 2>/dev/null)" "${HOME:-unset}" "$err" > "$HOME_DIR/.bsc-hooks-fetch.log" 2>/dev/null
      if [ "$rc" = 0 ]; then
        if [ -d "$S" ] && [ ! -d "$S/.git" ]; then rm -rf "$S"; fi
        [ -d "$S" ] && rm -rf "$T" || mv "$T" "$S" 2>/dev/null || rm -rf "$T"
      else
        rm -rf "$T"; why="$(printf '%s' "rc=$rc $err" | tr -d '"\\\r' | tr '\n' ' ' | cut -c1-300)"
        msg "BRO-7194: could not fetch the stall Stop gate from $URL, so this session has NO stall gate (reason: $why). Do not end a turn promising later work with nothing running."; exit 0
      fi
    fi
    find_runner >/dev/null || msg "BRO-7194: hook runner missing after fetch, stall Stop gate NOT installed."
    exit 0 ;;
  stop)
    # Cloud sessions can take their first turn before the SessionStart fetch finishes (BRO-7194 probe 1:
    # a 5s turn ended with no runner). Fetch inline now; the atomic rename makes a race with it harmless.
    in="$(mktemp 2>/dev/null || echo /tmp/bsc-stop.$$)"; cat > "$in"
    if ! find_runner >/dev/null; then
      fout="$(bash "$0" fetch 2>&1)"
    fi
    if r="$(find_runner)"; then
      VE_ONLY_CODES="$STALL_CODES" exec bash "$r" verify-edits.sh < "$in"
    fi
    # No runner after the inline fetch (probe 2: the fetch left nothing and the notice said nothing about why).
    # Fail CLOSED for a closing that promises later work: block once (stop_hook_active lets the retry through).
    why="$(printf '%s' "${fout:-no fetch output}" | sed -n 's/.*"systemMessage":"\(.*\)"}.*/\1/p' | head -1 | sed 's/^BRO-7194: //; s/ Do not end a turn.*//' | cut -c1-320)"
    note="BRO-7194: stall Stop gate not installed in this session (no hook runner under $HOME_DIR; fetch said: ${why:-nothing, see $HOME_DIR/.bsc-hooks-fetch.log})."
    if grep -Eqi "$PROMISE_FALLBACK" "$in" && ! grep -Eq '"stop_hook_active" *: *true' "$in"; then
      echo "BLOCKED: this turn ends by promising later work (KEEP OPEN / check back / report back) and the stall Stop gate could not load, so nothing here can confirm a wake is running. $note Start a background Bash or Monitor that wakes you, or rewrite the closing to say the work is finished; then end the turn again." >&2
      exit 2
    fi
    msg "$note Do not end a turn promising later work with nothing running."; exit 0 ;;
  *) exit 0 ;;
esac
