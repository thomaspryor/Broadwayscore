# BRO-5204 state
Done (on main, ff03a8dcd4): push-with-retry.sh additions-only reconcile for alert-ledger.json + guard-escalation-state.json.
In flight: land run 38625515791 (land/job/linear-BRO-5204-mv8g3bm2) = rowMatchKey trim-after-clamp fix (+health-row-probe cousin) + ledger restore of 9 conditions dropped by de49618478c.
Next: `bash scripts/lib/wait-for-run.sh 38625515791 30`, then on fresh main:
`node scripts/check-alert-condition-absent.js --key-b64 dGltZS1ib21iLXRlc3RzOnVuaXQtdHN4OnRlc3RzL3VuaXQvYm94LW9mZmljZS12Mi1kaXNwbGF5LnRlc3QudHM6OnJlYWwgZGF0YTogY29zdCBjb3ZlcmFnZSBwdXRzIGV2ZXJ5IHJ1bm5pbmcgQnJvYWR3YXkg` (expect PASS, exit 0), then linear-session.js report --status=done.
