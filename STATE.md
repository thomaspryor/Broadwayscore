# BRO-5512 state (2026-10-18 00:10 UTC)

DONE (commit 3d74506ff52 and earlier on job/linear-BRO-5512-mvcz27dv, pushed as land/job/linear-BRO-5512-mvcz27dv):
- scripts/lib/prior-run-url-signal.js, wired into scripts/audit-show-review-gap.js: the census drops same-year
  prior-run (inheritReviews:false) month/venue URLs and Philly Fringe slugs. Test: scripts/audit-show-review-gap.test.mjs (47 pass).
- Guardian Kramer/Fauci piece marked manual-verified non-review in broadway-review-texts (6d56fb0d936, pushed).
- Local audit of kramerfauci-st-anns-off-broadway-2026 shows no gap warning.

REMAINING:
- Land on main: land.yml run 39079122045 failed ONLY on the live test "branches/main/protection has enforce_admins true"
  (test 4225), which also fails other sessions' lands. Not caused by this change.
  Next command once that gate is fixed: the landing script in scripts/ (merge-worktree-to-main.sh) from this worktree.
- After landing and the next hourly gap audit run:
  node scripts/check-alert-condition-absent.js --key-b64 cmV2aWV3LWdhcDpvcGVuaW5nLXdpbmRvdzprcmFtZXJmYXVjaS1zdC1hbm5zLW9mZi1icm9hZHdheS0yMDI2
