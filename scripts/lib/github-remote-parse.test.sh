#!/usr/bin/env bash
# Tests for github-remote-parse.sh (BRO-2951).
#
# Per CLAUDE.md §15 this SOURCES the real implementation — no logic is copied
# here, so a production edit that breaks the parsing fails this test.
#
# The two cases that matter most:
#   - a non-github.com remote MUST return rc 1, because that is what keeps
#     every REST/diagnostic path from firing inside the push-via-git-api.sh
#     fixture suite, which drives the script against local filesystem remotes
#     with no network and no credentials;
#   - the extraheader decoder MUST recover the token actions/checkout
#     persists, because the workflow step whose failure motivated this card
#     has NO token in its env: block and that header is the only credential
#     it has.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./github-remote-parse.sh
. "$SCRIPT_DIR/github-remote-parse.sh"

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ok — $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  NOT OK — $1"; }

expect_slug() { # <url> <expected>
  local got rc
  got="$(github_repo_slug_from_url "$1")"; rc=$?
  if [ "$rc" -eq 0 ] && [ "$got" = "$2" ]; then
    ok "slug '$1' -> '$2'"
  else
    bad "slug '$1' -> rc=$rc got='$got' expected='$2'"
  fi
}

expect_no_slug() { # <url>
  local got rc
  got="$(github_repo_slug_from_url "$1")"; rc=$?
  if [ "$rc" -ne 0 ] && [ -z "$got" ]; then
    ok "slug rejected: '$1'"
  else
    bad "slug '$1' should have been rejected, rc=$rc got='$got'"
  fi
}

echo "github_repo_slug_from_url:"
expect_slug "https://github.com/thomaspryor/Broadwayscore.git" "thomaspryor/Broadwayscore"
expect_slug "https://github.com/thomaspryor/Broadwayscore"     "thomaspryor/Broadwayscore"
expect_slug "git@github.com:thomaspryor/broadway-review-texts.git" "thomaspryor/broadway-review-texts"
expect_slug "ssh://git@github.com/thomaspryor/broadway-scorecard-data.git" "thomaspryor/broadway-scorecard-data"
expect_slug "https://github.com/thomaspryor/Broadwayscore/" "thomaspryor/Broadwayscore"

# THE test that protects the fixture suite: the bare-repo harness clones from
# a filesystem path, and these must never look like a GitHub repo.
expect_no_slug "/tmp/push-via-git-api-abc123/origin"
expect_no_slug "file:///tmp/push-via-git-api-abc123/origin"
expect_no_slug ""
# Not github.com — a lookalike host must not match.
expect_no_slug "https://github.company.com/owner/repo.git"
expect_no_slug "https://notgithub.com/owner/repo.git"
# Not a repo path.
expect_no_slug "https://github.com/thomaspryor"
expect_no_slug "https://github.com/owner/repo/extra"

expect_token() { # <header> <expected>
  local got rc
  got="$(github_token_from_extraheader "$1")"; rc=$?
  if [ "$rc" -eq 0 ] && [ "$got" = "$2" ]; then
    ok "extraheader -> expected token recovered"
  else
    bad "extraheader -> rc=$rc got='$got' expected='$2'"
  fi
}

expect_no_token() { # <header> <label>
  local got rc
  got="$(github_token_from_extraheader "$1")"; rc=$?
  if [ "$rc" -ne 0 ] && [ -z "$got" ]; then
    ok "extraheader rejected: $2"
  else
    bad "extraheader ($2) should have been rejected, rc=$rc"
  fi
}

echo "github_token_from_extraheader:"
# Exactly the shape actions/checkout writes.
B64="$(printf 'x-access-token:ghs_EXAMPLETOKEN123' | base64 | tr -d '\n')"
expect_token "AUTHORIZATION: basic $B64" "ghs_EXAMPLETOKEN123"
expect_token "authorization: Basic $B64" "ghs_EXAMPLETOKEN123"

# A token containing colons must survive: only the FIRST colon separates
# username from secret. Splitting on the last would silently truncate it.
B64C="$(printf 'x-access-token:tok:with:colons' | base64 | tr -d '\n')"
expect_token "AUTHORIZATION: basic $B64C" "tok:with:colons"

# A different username still yields the secret.
B64U="$(printf 'someuser:ghp_OTHER' | base64 | tr -d '\n')"
expect_token "AUTHORIZATION: basic $B64U" "ghp_OTHER"

expect_no_token "" "empty header"
expect_no_token "AUTHORIZATION: bearer sometoken" "bearer, not basic"
expect_no_token "AUTHORIZATION: basic !!!!not-base64!!!!" "undecodable payload"
B64NOCOLON="$(printf 'nocolonhere' | base64 | tr -d '\n')"
expect_no_token "AUTHORIZATION: basic $B64NOCOLON" "decoded payload has no colon"
B64EMPTY="$(printf 'x-access-token:' | base64 | tr -d '\n')"
expect_no_token "AUTHORIZATION: basic $B64EMPTY" "empty token after the colon"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
