---
name: visual-qa
version: "1.0.0"
description: "MANDATORY for any UI change before push. Sweeps localhost at 5 widths (360-1440), takes element-cropped legibility shots (full pixel resolution — NOT thumbnail), runs structural overflow probe (scrollWidth > clientWidth), and (optionally) runs two-model LLM diff review against reference designs. Writes verdict.json with contentHash. ALWAYS run + Read every element crop at full size + share manifest with user BEFORE pushing UI changes. The pre-push hook blocks deploys until the user gives a plain affirmative (yes/ship it/looks good) in their most recent message — never ask them to copy a hash."
allowed-tools: Bash, Read, Write
user-invocable: true
---

# /visual-qa — Local visual sweep + two-model review + user-approval gate

## When this is mandatory

ALWAYS run before pushing any change touching:
- `src/**/*.{tsx,jsx,css,scss,module.css}`
- `tailwind.config.*`, `postcss.config.*`
- `src/app/**` (anything rendering HTML — including server components)

No exceptions for "obvious" or "small" changes. Perf refactors, prop renames, and code moves all change rendering surface. If it can change a pixel, run this. The pre-push gate enforces.

## The flow (do not skip steps)

### 1. Start the dev server

```bash
nohup npm run dev > /tmp/dev.log 2>&1 &
# Wait for "Ready in" in the log before continuing
```

### 2. Run the skill

```bash
node scripts/visual-qa.mjs \
  --url http://localhost:3000 \
  --paths "/,/affected-route" \
  --elements ".tony-card,.score-badge,.featured-spot" \
  --refs /path/to/design-ref.png
```

**Flag notes:**
- `--url` — **must be `http://localhost:*`**. Production URLs are rejected — gate is "local preview before push."
- `--paths` — comma-separated routes you touched. Defaults to `/`.
- `--elements` — comma-separated CSS selectors. **PASS THIS.** Without it, the runner only takes full-page screenshots, which render as thumbnails when you Read them and silently hide clipping/overflow ("HISTORICAL ACCURA" class of bug). Element crops are tight, viewport-sized images per breakpoint that you can actually legibility-check at full pixel resolution.
- `--refs` — comma-separated paths to reference design images the user provided. When set, both GPT-4o and Gemini 2.5 Pro diff the implementation against the reference. Both must PASS for `overallPass=true`. If the user did NOT supply a reference, omit; the runner still captures + runs overflow probe.
- `--ref-roles` — per-reference role aligned with `--refs`. Values: `goal` (default; impl MUST match this reference) or `before` (impl MUST differ from this reference; the diff IS the user's requested change). **If the user attaches a screenshot and asks for a change away from it (e.g. "move Choreography from A tier to B tier"), the attached image is a `before` reference. ASK the user once if the role is not obvious from context; passing the wrong role will mark the requested change as a regression.**

### 3. Read every element crop at FULL RESOLUTION

The runner prints `Read <path>` instructions. Run them. The Read tool surfaces the PNG inline at full pixel resolution — that's the only way to catch clipping, glow intensity, copy mismatches.

**Do not skip this.** Reading the full-page screenshot at thumbnail size is the documented root cause of the FeaturedSpot incident — agent said "Live on production" with `HISTORICAL ACCURA` clipped because the thumb made the gold pill look fine.

### 4. Paste the manifest into your reply to the user

Format:

```
Visual QA — branch <branch>, URL <url>

Element crops (full resolution):
  - <path-1> @ 360px  [reads the image]
  - <path-1> @ 768px  [reads the image]
  - <path-1> @ 1440px [reads the image]

Overflow findings: <N>
[if non-empty, list 3-5 with selector + dims + text preview]

LLM review (if --refs):
  - OpenAI: PASS|FAIL — <specific issues>
  - Gemini: PASS|FAIL — <specific issues>

Look good? Reply "yes" / "ship it" / "looks good" to push, or tell me what to fix.
```

**DO NOT ask the user to type or copy a hash.** The gate accepts any plain affirmative in their most recent message — bare ship/push/send/deploy verbs in any phrasing all count: "ship it", "ship all four", "ship them", "push it", "send everything", "yes", "lgtm", "looks good", "go ahead", "good to go", "approved". The human glance after seeing the visual IS the safety, the hash never was. Asking a non-technical user to transcribe a 16-char hex string is exactly the friction that was removed; reintroducing it in your phrasing is a regression. Keep the verdict hash out of your reply entirely.

### 5. STOP. Wait for the user's plain affirmative (or change request).

The pre-push hook blocks `git push` / `gh pr merge` / wrapped push scripts until the LAST user message is a clean approval. A plain affirmative is enough; the gate fails safe on negation or conditionals ("looks good but fix X", "yes, wait") so those do NOT unlock.

## What the user can say to unlock

- Any plain affirmative — `yes`, `ship it`, `ship all four`, `ship them`, `push it`, `send everything`, `looks good`, `lgtm`, `go ahead`, `good to go`, `approved` — in their most recent message. This is the normal path. (`APPROVED: <hash>` still works for back-compat and is honored strictly per-hash, but never *ask* for it.) Approval is recorded in the local ledger (`.claude/visual-qa/approvals.jsonl`) so a later merge of this commit into main is auto-allowed.
- `ship immediately for: <reason>` — one-shot override. Use when user wants to skip preview entirely (hotfix, etc.). Consumed after one push; subsequent pushes require fresh approval.

Otherwise the gate is firm. If you genuinely cannot run /visual-qa (cloud sandbox with no Playwright, dev server can't boot due to data issue, etc.), put `NO-VERIFY: <specific reason>` in **the same assistant message** as the `git push` Bash call — the pre-push hook scans the in-flight turn (the message containing the gated tool_use), not the prior turn. **Expect the user to ask why.** Stale NO-VERIFY from earlier turns no longer bypasses the push gate.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | overallPass=true (either no refs supplied, or both models PASS) |
| 1 | bad args (missing --url, missing ref file, etc.) |
| 2 | dev server unreachable, localhost-only violation, OR LLM review returned FAIL |

## See also

- `scripts/visual-qa.mjs` — the runner. Anti-hallucination prompt + element-crop preference + structural overflow probe inline.
- `.claude/hooks/pre-push-visual-gate.sh` — PreToolUse Bash hook that blocks pushes without APPROVED.
- `.claude/hooks/verify-edits.sh` — Stop hook with `is_ui_edit` branch.
- `memory/feedback_local_preview_before_push.md` — why this gate exists (FeaturedSpot post-mortem).
- `memory/feedback_two_model_ui_review.md` — original two-model rationale.
