#!/usr/bin/env bash
# press-night-data-refresh.sh (BRO-6858): pull the latest core shows.json + reviews.json and the checked-out review
# texts in place, for a long-running press-night job (the watchdog re-reads them every tick). Never fails the caller:
# a failed refresh leaves the previous copy and prints a warning.
CORE=/tmp/core-data-checkout
if [ -d "$CORE/.git" ] && timeout 90 git -C "$CORE" fetch -q --depth 1 origin main 2>/dev/null; then
  for f in shows.json reviews.json; do
    if git -C "$CORE" show "FETCH_HEAD:$f" > "/tmp/pn-refresh-$f" 2>/dev/null \
       && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "/tmp/pn-refresh-$f" 2>/dev/null; then
      cp "/tmp/pn-refresh-$f" "data/$f"
    else
      echo "::warning::could not refresh $f from core data"
    fi
  done
else
  echo "::warning::could not fetch core data; keeping the previous shows.json and reviews.json"
fi
if [ -d data/review-texts/.git ]; then
  { timeout 120 git -C data/review-texts fetch -q --depth 1 origin main && git -C data/review-texts reset -q --hard FETCH_HEAD; } 2>/dev/null \
    || echo "::warning::could not refresh review texts"
fi
exit 0
