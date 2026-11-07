---
name: test-yml-data-gates-flap-and-shortcircuit
description: "test.yml data-state gates flap on hourly corpus drift and short-circuit each other; some catch real bugs, don't blanket-silence"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 195cd6dd-f7dc-488c-865c-c5faf430e356
---

test.yml's Data Validation job runs ~6 sequential data-state audits (duplicateOf, contamination A-F, content-quality regex FP families, text-quality, mobile-shows). Under `bash -e`, the FIRST to fail skips the rest — so fixing one unmasks the next: duplicateOf → content-quality NAVIGATION FP → review-contamination → content-quality ERROR_PAGE, each surfacing only after the prior was fixed. They also trip as the corpus rebuilds hourly (a clean run can go red an hour later with zero code change).

**Why:** these gates assert against live mutable data state, not code, on every push.

**How to apply:** when one goes green, re-run — another may surface. Triage each, don't blanket-silence:
- Pure-drift thresholds (NAVIGATION nav-chrome keywords creeping over the per-pattern FP allowlist as the corpus grows) → recalibrate the allowlist in audit-regex-patterns.js, but FIRST probe by-outlet per the PATTERN_CALIBRATION playbook (diffuse across outlets = bump+headroom; concentrated in one ACTIVE outlet = scraper chrome leak, fix the strip).
- Real-signal gates (ERROR_PAGE = 404 page scraped as review; contamination = mislabeled outlet/domain) → fix the DATA, never bump. 404-page-as-review: body is site chrome + "Page Not Found", flag isNonReview + contentTier:invalid (the established pattern — most already-excluded 404 files use exactly that pair).
- Verifying "main is green" needs a fresh full test.yml run AFTER any data heal pushed (a run that checked out before the heal's push shows a stale-data failure that is NOT a regression).
See [[feedback_content_quality_regex_fps]], [[feedback_ci_step_short_circuits_colocated_tests]], [[feedback_ci_red_stale_state_and_brittle_assertions]].
