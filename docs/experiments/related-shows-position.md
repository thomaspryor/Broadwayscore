# related-shows-position (BRO-5989)

Pre-registered 2026-10-25, before any arm data exists.

## Question
Do mobile visitors who land on a `/show/*` page from Google view a second page more often when a compact related-shows row sits right after the reviews card?

## Arms (PostHog flag `related-shows-position`, id 992842, 50/50, sticky on)
- `control`: page unchanged.
- `compact-after-reviews`: `RelatedShowsCompactAB` renders up to 5 `MiniShowCard`s right after the Critic Scorecard card (reviews stay above). The bottom "Shows You Might Like" sections stay in both arms.
- Desktop (viewport > 639px) never reads the flag, so it is never exposed. Shows with no reviews yet get no row. Every linked show passes `isShowIndexable`.

## Metric
Primary: among persons exposed on mobile (those with a `related_shows_ab_exposed` event; do NOT filter on the `$feature/related-shows-position` event property, posthog-js stamps it on desktop and unexposed events too), the share whose first exposed session landed on a show page from a search engine and viewed a second page (`$pageview` count >= 2). The analysis unit is the person, matching the randomization unit (distinct_id), first exposed session only. Exposure fires on mount, not on scroll, so most exposed users never see the row; the measured effect is intent-to-treat and diluted accordingly. Secondary: `related_shows_ab_click` per exposed session. Guardrail: Critic Scorecard card visibility and score-badge render unchanged (visual QA), no drop in session pageviews for control.
Exposure events: `$feature_flag_called` and `related_shows_ab_exposed` (props: `flag`, `variant`, `show_id`). Click event: `related_shows_ab_click`.

## Data window
Only events at or after the PostHog proxy cutover, 2026-10-23 02:11Z, and only after the flag is live in production. Earlier data is undercounted by blockers.

## Sample size
Two-sided two-proportion z-test, alpha 0.05, power 0.80, computed by `sampleSizePerArm` in `scripts/lib/related-shows-ab.js`.
- Card spec, absolute 15% to 20% multi-page share: **906 per arm** (1,812 total).
- Traffic: ~8k show-page search landers per 28 days; measured since the cutover (2026-10-23 to 25): 737 landers, 63% mobile, so ~5k eligible mobile landers per 28 days (~180/day). 906 per arm takes about 11 days.
- Measured post-cutover baseline is higher than the card's 15%: 19.0% mobile (88 of 463), 20.1% desktop. Against that baseline a 15% relative lift (19.0% to 21.85%) needs 3,140 per arm (~35 days), a 20% relative lift (to 22.8%) needs 1,797 per arm (~20 days). Fix one stopping n before looking: run to 3,140 per arm (about 35 days) unless the owner picks the smaller 906 design; no peeking at the 906 floor, which is powered only for 15% to 20%.

Known limits: the row mounts after the flag resolves (up to a 5s poll), so a user already scrolled past the reviews card can see content shift; visitors whose PostHog never loads are never exposed (same in both arms).

## Rules
Do not change rollout, stop the flag, or declare a winner without the owner (`memory/feedback_ab_test_guardrails.md`).
