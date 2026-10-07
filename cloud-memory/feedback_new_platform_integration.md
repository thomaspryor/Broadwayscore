---
name: feedback_new_platform_integration
description: "Platform reconnaissance before integration code; check UI defaults."
type: feedback
archived: true
---

Before integrating any new third-party platform, do platform reconnaissance FIRST — before writing any code or touching any real data:

1. **Spend 10 minutes in the UI as a new user.** Find every setting that could affect real users. Don't assume defaults are safe.
2. **Walk through the end-user experience manually with your own account.** What email do they receive? What does the sender name say? What does the subject say?
3. **Identify what the platform does by default that you might not want.** Double opt-in, welcome emails, sender name, confirmation flows.
4. **Verify what API parameters can and cannot override account-level settings.** Never assume an API flag overrides a UI setting without testing it first.
5. **Test with your own email, read what arrives, confirm all visible details** before any bulk operation involving real users.

**Why:** During the Buttondown migration (2026-03-26), confirmation emails went to ~159 subscribers because account-level double opt-in overrode `double_opt_in: false` in the API. The sender name was "Tom Pryor" instead of "Broadway Scorecard". Neither was caught in planning or code review. All four reviewers focused on API correctness and missed the user-facing defaults entirely.

**How to apply:** Any time a new platform, API, or service is being integrated for the first time — stop before writing code and answer: what does a real user experience when this runs? What are the defaults? What can't the API override?
