# shellcheck shell=bash
# github-remote-parse — pure string parsers shared by push-via-git-api.sh
# (BRO-2951).
#
# WHY THESE LIVE IN THEIR OWN SOURCEABLE FILE (CLAUDE.md §15): both are
# decision functions whose bugs are silent. A slug parser that mis-parses an
# SSH remote sends a REST call to the wrong repo path; an extraheader decoder
# that mis-splits hands back a truncated secret and every authenticated call
# 401s for a reason nobody can see. Neither can be tested inside
# push-via-git-api.sh itself — that script runs top-to-bottom under
# `set -euo pipefail` and requires <branch> <base_sha>, so sourcing it to
# reach a function would run the whole push. Splitting the pure part out
# means the test `source`s the REAL implementation instead of copying it, so
# a production edit that breaks the parsing fails the test.
#
# Both take their input as an ARGUMENT rather than reading git config, which
# is what makes them pure. push-via-git-api.sh supplies the I/O.

# github_repo_slug_from_url <remote-url> -> prints "owner/repo", rc 1 if the
# URL is not a github.com remote.
#
# Returning rc 1 for anything non-GitHub is load-bearing, not defensive: the
# push-via-git-api.sh fixture suite drives the script against LOCAL
# FILESYSTEM remotes (/tmp/...), and this returning empty is what guarantees
# no diagnostic or REST path can ever fire inside a test that has no network
# and no credentials.
github_repo_slug_from_url() {
  local url="${1:-}" slug
  case "$url" in
    https://github.com/*|http://github.com/*|git@github.com:*|ssh://git@github.com/*) ;;
    *) return 1 ;;
  esac
  slug="${url#*github.com}"
  slug="${slug#:}"
  slug="${slug#/}"
  slug="${slug%.git}"
  slug="${slug%/}"
  # Exactly two non-empty path segments. A bare "github.com/owner" or a
  # deeper path is not a repo and must not be interpolated into a REST URL.
  case "$slug" in
    */*/*) return 1 ;;
    */*)   [ -n "${slug%%/*}" ] && [ -n "${slug#*/}" ] || return 1
           printf '%s' "$slug"; return 0 ;;
  esac
  return 1
}

# github_token_from_extraheader <header-value> -> prints the token, rc 1 if
# the header is not a decodable basic credential.
#
# actions/checkout persists its credential as
#   http.https://github.com/.extraheader = AUTHORIZATION: basic <base64>
# where the decoded payload is `x-access-token:<token>`. Some setups use a
# different username, so any `user:token` shape is accepted and everything
# after the FIRST colon is the token (a token may itself contain colons).
#
# NEVER log the return value of this function.
github_token_from_extraheader() {
  local hdr="${1:-}" b64 decoded
  [ -n "$hdr" ] || return 1
  case "$hdr" in
    *[Bb][Aa][Ss][Ii][Cc]\ *) ;;
    *) return 1 ;;
  esac
  b64="$(printf '%s' "$hdr" | sed -E 's/^.*[Bb][Aa][Ss][Ii][Cc][[:space:]]+//')"
  [ -n "$b64" ] || return 1
  decoded="$(printf '%s' "$b64" | base64 -d 2>/dev/null || true)"
  case "$decoded" in
    *:*) ;;
    *) return 1 ;;
  esac
  decoded="${decoded#*:}"
  [ -n "$decoded" ] || return 1
  printf '%s' "$decoded"
  return 0
}
