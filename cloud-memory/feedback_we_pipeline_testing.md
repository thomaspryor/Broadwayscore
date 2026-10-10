---
name: WE pipeline fixes require real verification
description: "Captures 0% despite \"tested\" claims; verify in CI vs real shows."
type: feedback
archived: true
---

WE opening night pipeline has been "implemented and tested" by multiple sessions but captures 0% of real WE reviews (John Proctor: 0/19, Teeth 'n' Smiles: 3/10+). Previous testing was insufficient.

**Why:** Sessions ran `node --check`, checked code locally, or verified syntax but never confirmed the pipeline actually works in CI against real shows. The core issue (TLS fingerprinting blocking `https.get` in GitHub Actions) only manifests in CI, not locally.

**How to apply:**
- Every pipeline fix MUST be tested by triggering the actual workflow in CI against a real show, then checking the logs for successful extraction
- "Works locally" is NOT verification for scraping code — CI has different TLS fingerprints, IP ranges, and network behavior
- After fixing, run the poller for a known show (e.g. john-proctor-is-the-villain-west-end-2026) and verify: (a) the log shows reviews found, (b) review files were actually created, (c) the files contain real WE review data not Broadway contamination
- Compare results against a known ground truth (e.g. the 19 published John Proctor WE reviews we catalogued on 2026-03-28)
- Never claim "pipeline works" without showing the actual review count before and after
