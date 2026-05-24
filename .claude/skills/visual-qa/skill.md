---
name: visual-qa
version: "1.0.0"
description: "MANDATORY for any UI change before push. Sweeps localhost at 5 widths (360-1440), takes element-cropped legibility shots (full pixel resolution — NOT thumbnail), runs structural overflow probe (scrollWidth > clientWidth), and (optionally) runs two-model LLM diff review against reference designs. Writes verdict.json with verdictHash. ALWAYS run + Read every element crop at full size + share manifest with user BEFORE pushing UI changes. The pre-push hook blocks deploys without APPROVED: <verdictHash> from the user in the most recent message."
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

### 3. Read every element crop at FULL RESOLUTION

The runner prints `Read <path>` instructions. Run them. The Read tool surfaces the PNG inline at full pixel resolution — that's the only way to catch clipping, glow intensity, copy mismatches.

**Do not skip this.** Reading the full-page screenshot at thumbnail size is the documented root cause of the FeaturedSpot incident — agent said "Live on production" with `HISTORICAL ACCURA` clipped because the thumb made the gold pill look fine.

### 4. Paste the manifest into your reply to the user

Format:

```
Visual QA — branch <branch>, URL <url>
Verdict hash: <hash>

Element crops (full resolution):
  - <path-1> @ 360px  [reads the image]
  - <path-1> @ 768px  [reads the image]
  - <path-1> @ 1440px [reads the image]

Overflow findings: <N>
[if non-empty, list 3-5 with selector + dims + text preview]

LLM review (if --refs):
  - OpenAI: PASS|FAIL — <specific issues>
  - Gemini: PASS|FAIL — <specific issues>

Awaiting your approval. Reply with `APPROVED: <hash>` to push,
or describe what to fix.
```

### 5. STOP. Wait for the user's explicit `APPROVED: <hash>` reply.

The pre-push hook will block `git push` / `gh pr merge` / wrapped push scripts until the LAST user message contains the literal string `APPROVED: <hash>` matching the current verdict.

## What the user can say to unlock

- `APPROVED: <hash>` — match the verdictHash exactly, lower-case hex, no extra characters. Pre-push hook unlocks for this verdict.
- `ship immediately for: <reason>` — one-shot override. Use when user wants to skip preview entirely (hotfix, etc.). Consumed after one push; subsequent pushes require fresh approval.

Otherwise the gate is firm. If you genuinely cannot run /visual-qa (cloud sandbox with no Playwright, dev server can't boot due to data issue, etc.), put `NO-VERIFY: <specific reason>` in your final message text — the Stop hook will pass. **Expect the user to ask why.**

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
