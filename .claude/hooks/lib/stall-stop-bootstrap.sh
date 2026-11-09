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
    [ -n "$full" ] && { find_runner >/dev/null && exit 0; msg "BRO-7194: Broadwayscore is cloned but has no hook runner yet (clone still running?). The stall Stop gate will load once it finishes."; exit 0; }
    S="$HOME_DIR/.bsc-hooks"
    command -v git >/dev/null 2>&1 || { msg "BRO-7194: git missing, stall Stop gate NOT installed."; exit 0; }
    if [ -d "$S/.git" ]; then
      git -C "$S" sparse-checkout set --no-cone '/.claude/' '/scripts/' '/package.json' 2>/dev/null; timeout 30 git -C "$S" fetch -q --depth 1 origin main 2>/dev/null && timeout 60 git -C "$S" reset -q --hard FETCH_HEAD 2>/dev/null
    else
      # Clone into a private temp dir, then rename: a concurrent session never sees a half-made
      # checkout and never has it deleted under it. Loser of the rename race just discards its copy.
      T="$S.tmp.$$"; rm -rf "$T"
      if timeout 90 git clone -q --depth 1 --filter=blob:none --sparse "$URL" "$T" 2>/dev/null \
         && git -C "$T" sparse-checkout set --no-cone '/.claude/' '/scripts/' '/package.json' 2>/dev/null; then
        if [ -d "$S" ] && [ ! -d "$S/.git" ]; then rm -rf "$S"; fi
        [ -d "$S" ] && rm -rf "$T" || mv "$T" "$S" 2>/dev/null || rm -rf "$T"
      else
        rm -rf "$T"; msg "BRO-7194: could not fetch the stall Stop gate from $URL, so this session has NO stall gate. Do not end a turn promising later work with nothing running."; exit 0
      fi
    fi
    find_runner >/dev/null || msg "BRO-7194: hook runner missing after fetch, stall Stop gate NOT installed."
    exit 0 ;;
  stop)
    # Cloud sessions can take their first turn before the SessionStart fetch finishes (BRO-7194 probe:
    # a 5s turn ended with no runner). Fetch inline now; the atomic rename makes a race with it harmless.
    find_runner >/dev/null || bash "$0" fetch >/dev/null 2>&1
    r="$(find_runner)" || { msg "BRO-7194: stall Stop gate not installed in this session (no hook runner under $HOME_DIR). Do not end a turn promising later work with nothing running."; exit 0; }
    VE_ONLY_CODES="$STALL_CODES" exec bash "$r" verify-edits.sh ;;
  *) exit 0 ;;
esac
