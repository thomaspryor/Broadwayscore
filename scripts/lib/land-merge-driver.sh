#!/usr/bin/env bash
# land-merge-driver.sh (BRO-7631) — the `merge=ours` driver land.yml's rebases pass with -c (see land-merge-drivers.js).
#
#   land-merge-driver.sh %O %A %B %P      (in a rebase %A is main's side, %B the branch commit being replayed)
#
# .gitattributes declares merge=ours but a CI runner registers no driver, so git silently text-merged and two
# whole-file regenerations conflicted (validation-baseline.json, needs-human-review.json, deploy-watermark.json,
# cross-show-fingerprint-collisions.json ...: dozens of refused lands in 30 days). This driver keeps main's copy
# WHOLE only for paths marked `autostash=regenerated` (rewritten wholesale by a script on every run, never
# hand-edited, never accumulating: the list push-with-retry.sh already trusts). Every other merge=ours path
# (feature-flags.ts, lane-rehearsal.json, exclusion-daily-totals.json ...) gets the plain three-way text merge
# the undefined driver gave it, conflict markers and a non-zero exit included, so nothing hand-authored is dropped.
base="$1" cur="$2" other="$3" path="${4:-}"
if [ -n "$path" ]; then
  case "$(git check-attr autostash -- "$path" 2>/dev/null)" in
    *": autostash: regenerated")
      echo "::notice::land-merge-driver: kept main's $path (autostash=regenerated; the next run rewrites it; the branch's version was blob $(git hash-object "$other" 2>/dev/null || echo unknown)) (BRO-7631)" >&2
      exit 0
      ;;
  esac
fi
exec git merge-file "$cur" "$base" "$other"
