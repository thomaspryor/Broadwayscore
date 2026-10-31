#!/usr/bin/env bash
# merge-keep-run.sh — the `merge=ours` driver push-with-retry.sh passes on its
# own rebase / rebase --continue / merge / cherry-pick calls (BRO-5551). It is
# never written to any git config: a human's merge and land.yml keep
# setup-local-data.sh's `true`.
#
#   merge-keep-run.sh <A|B> %O %A %B %P
#     B = rebase / cherry-pick: %B is the commit being replayed (this run)
#     A = merge -X ours:        %A is our HEAD (this run)
#
# Why: `-X theirs` / `-X ours` only decide OVERLAPPING hunks. Two complete
# regenerations of one snapshot that touch different lines merge cleanly, so
# the push landed a blend of both runs: valid JSON, wrong content
# (data/audit/unknown-aggregator-outlets.json in eef37304d6d carried a
# duplicate aol.co.uk row and the wrong count). merge=ours did nothing on CI:
# merge.ours.driver is undefined there and git silently text-merges.
#
# A path marked `autostash=regenerated` in .gitattributes (rewritten wholesale
# every run, never accumulating; see the rules beside that list) keeps this
# run's file WHOLE, the side push-with-retry.sh's resolve_conflicts already
# keeps for data/audit when they do conflict. Every other merge=ours path
# (accumulating checkpoints, append-per-key files, feature-flags.ts) gets the
# same text merge the strategy option gave it before, so it is unchanged.
side="$1" base="$2" cur="$3" other="$4" path="${5:-}"
if [ -n "$path" ]; then
  case "$(git check-attr autostash -- "$path" 2>/dev/null)" in
    *": autostash: regenerated")
      if [ "$side" = "B" ]; then cp "$other" "$cur" || exit 1; fi
      exit 0
      ;;
  esac
fi
if [ "$side" = "B" ]; then fav=--theirs; else fav=--ours; fi
git merge-file "$fav" "$cur" "$base" "$other"
