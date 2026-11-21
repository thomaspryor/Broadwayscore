# BRO-6491: Exeunt text-verification investigation

Checked the runner's private-data snapshot on 2026-11-02. This report contains
metadata and findings only, with no article text.

## Existing outlet alert fix

HEAD and origin/main were both `20c37b8ca91259ff7fd9c4a504968b41942f95cb`.
`node --test scripts/audit-outlet-text-status.test.mjs` passed all seven tests
before editing anything. `git log -S 'byLastFailure' --oneline -5 --
scripts/audit-outlet-text-status.js` identifies `f68b380dd` as the existing
change. The silent-majority rule needs no further code change.

`node scripts/audit-outlet-text-status.js --zero-char-hosts` exited 1 and
reported 17 hosts in this newer snapshot. Two hosts named in the original
card now have additional silent records: theepochtimes.com has 10 silent
records out of 13 and womanaroundtown.com has 9 out of 12. Their current
alerts meet the intended rule; suppressing them by name would hide real gaps.

The current `.github/workflows/data-health-check.yml` has a daily schedule
and checks out review texts, but contains no `--zero-char-hosts` invocation.
The repository-wide workflow search also found none. This disagrees with the
2026-10-30 card comment. The worker's workflow-edit prohibition leaves
scheduling for an authorized follow-up.

## Five stored articles inspected in full

The outlet audit reports 392 records: 252 full-text, 53 no-full-text and 87
excluded for other reasons. Exactly 28 non-excluded records are complete
but rejected by content verification.

| Show folder | Critic filename suffix | Stored characters | Finding |
| --- | --- | ---: | --- |
| a-bright-new-boise-off-broadway-2023 | lane-williamson | 5735 | Complete review and ending. The supposedly missing quotation starts at character offset 4655 and is absent from the current classifier sample. The other issues concern absent byline and outlet branding. |
| ghosts-off-broadway-2025 | nicole-serratore | 6801 | Complete critical review with the expected excerpt and a concluding assessment. The issues only cite missing byline and outlet branding. The reasoning mistakes omitted sample passages for missing source content. |
| tartuffe-off-broadway-2025 | lane-williamson | 4054 | Complete review of the expected production, with a concluding performance assessment. The issues only cite missing byline and outlet branding; the reasoning treats the sample omission marker as incompleteness. |
| the-wanderers-off-broadway-2023 | cameron-kelsall | 4952 | Complete review of the expected production, ending with the known excerpt. The rejection depends on missing byline and outlet branding and a sampled middle section. |
| a-dolls-house-2023 | lane-williamson | 5244 | The stored article continues beyond the internal cutoff described in the old verdict and has a complete ending. The supposedly absent quotation starts at offset 5076 and is visible in the current sample. |

All five stored content hashes match the current verifier's hash of the
article head. None of the five source texts contains the bracketed omission
marker. These checks support sample/metadata false rejections, rather than
genuine truncation of the supplied stored articles. A matching head hash does
not establish that an old verifier saw the current ending or sample layout.

Other rejections among the 28 cite production, venue, film or article-type
objections. The five-case finding does not justify clearing the entire group.

## Change and validation

The collector calls `verifyContent()` in `scripts/lib/content-verifier.js`
and persists its result in `scripts/collect-review-texts.js`. The fix changes
the prompt built at that source: absent bylines/outlet branding are neutral;
an excerpt missing from a sample is inconclusive; truncation must concern
the actual article ending. Explicit conflicting attribution and substantive
content problems remain grounds for rejection.

No deterministic issue-string filter or validity override was added. This
avoids the earlier rejected approach's risk of deleting a mixed objection
that also describes a different critic, truncated text or a roundup.

Before the change, all 28 real-data prompts lacked the new attribution and
excerpt guidance. Afterwards, all 28 prompts changed. Offline replay through
`verifyContent()` using each record's stored LLM response changed zero
validity verdicts and zero wrongArticle/wrongProduction/isFilmTv flags.
For example, Boise, Ghosts and Tartuffe receive the new guidance but remain
invalid on that stored-response replay. Replay checks postprocessing safety;
it does not measure the model's response to the new prompt.

The new prompt regression test failed before the fix (45 passed, 1 failed).
After the fix, the targeted command covering the outlet acceptance test and
all 15 test files found by `rg -l 'content-verifier' tests scripts --glob
'*.test.*'` passed 262 tests. It includes three offline adversarial responses
combining absent attribution with a different article, real truncation or a
roundup; all retain their rejection and issue strings.

No Gemini, OpenAI or Anthropic provider keys were configured. No live LLM
comparison or private-data re-verification was performed. Existing stored
verdicts are unchanged. A credentialed follow-up must compare model responses
on these five and negative controls before backfilling the remaining records.
No public fix plan was generated: the permitted field-edit allowlist does not
include contentVerification, and no private review text should enter a plan.

Added paid fetches, API calls and LLM calls per run: zero. The existing
collector/verifier callers use the longer prompt on future runs, including
scheduled collection, without adding a call or changing provider selection.

## Commands

- `git rev-parse HEAD origin/main`: both refs matched the SHA above.
- `git log -S 'byLastFailure' --oneline -5 -- scripts/audit-outlet-text-status.js`: existing change `f68b380dd`.
- `git log -S 'Missing attribution is neutral' --oneline -5 -- scripts/lib/content-verifier.js`: no prior match.
- `rg -n 'zero-char-hosts|audit-outlet-text-status' .github/workflows`: only the test.yml path trigger, no scheduled invocation.
- `node scripts/audit-outlet-text-status.js --outlet=exeunt-magazine --list=40`: exit 0, coverage counts above.
- `node scripts/audit-outlet-text-status.js --zero-char-hosts`: exit 1, 17 current silent-host alerts.
- `node --test scripts/audit-outlet-text-status.test.mjs`: 7 passed, both before and after.
- `node --test --test-timeout 300000 scripts/lib/content-verifier.test.mjs`: before fix, 45 passed and 1 failed; after fix, 46 passed.
- `rg -n 'verifyContent\(|buildVerificationPrompt\(' scripts/collect-review-texts.js scripts/lib/content-verifier.js`: confirms collector -> verifier -> prompt wiring.
- Inline Node checks requiring the real `buildVerificationPrompt`, `contentHash` and `verifyContent`: 28 before/after prompt comparisons and stored-response replays, with results above; no provider network calls.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`: exit 0, `lint-workflows: all gates green`; read the generated lint-workflows.log. actionlint was not installed and was skipped as permitted.
- `git diff --check`: pass. Final status contains only the verifier, its test and this investigation report. Temporary logs and snapshots were deleted; no unrelated tracked files needed restoration.

The full targeted test command passed 262 tests, zero failures:

```sh
node --test --test-timeout 300000 scripts/audit-outlet-text-status.test.mjs scripts/lib/content-verifier.test.mjs tests/unit/cross-show-url-cv-authority.test.mjs tests/unit/cv-ordinal-date-hints.test.mjs tests/unit/in-window-slug-veto.test.mjs scripts/rebuild-all-reviews.test.mjs tests/unit/content-verifier.test.mjs scripts/lib/classifier-partial-text.test.mjs tests/unit/venue-aliases.test.mjs tests/unit/sibling-matchers-diacritics.test.mjs tests/unit/should-defer-cv-wrong-show.test.mjs tests/unit/url-year-conflict-hint.test.mjs tests/unit/isNonReview-opening-night.test.mjs tests/unit/cv-promoted-nonreview-backlog.test.mjs scripts/lib/cv-stale-nonreview-label.test.mjs scripts/lib/tour-stop-carveout.test.mjs
```
