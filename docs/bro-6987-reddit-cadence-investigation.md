# BRO-6987: Rope Reddit draft investigation

The observed failure is a scheduling gap. The hourly workflow existed before
Rope opened, but only three scheduled runs were created between
2026-11-04T08:00Z and 2026-11-05T01:30Z. Their due decisions matched their
checked-out inputs. Both update emails succeeded. The cap did not block Rope.
This change adds diagnostics; it does not repair GitHub's scheduling cadence.

## Run history, checked 2026-11-05

The Actions runs collection was queried with
`created=2026-11-04T08:00:00Z..2026-11-05T01:30:00Z&per_page=100` for
`reddit-engagement-digest.yml`; `total_count` was **3**. All three were
`event=schedule`, completed successfully, and ran the hourly `due` job.
Job lists and decoded job logs were read through the GitHub connector.

| UTC hour on Nov 4 (Nov 5 for 00/01) | Run created | Due decision | Email step |
| --- | --- | --- | --- |
| 08 | none | did not run | did not run |
| 09 | none | did not run | did not run |
| 10 | none | did not run | did not run |
| 11 | 11:32:32 | false at 11:33:33 | drafter job skipped |
| 12 | none | did not run | did not run |
| 13 | none | did not run | did not run |
| 14 | none | did not run | did not run |
| 15 | none | did not run | did not run |
| 16 | none | did not run | did not run |
| 17 | none | did not run | did not run |
| 18 | 18:51:41 | true, including Rope, at 18:52:33 | succeeded, Rope 63/10 at 18:59:48 |
| 19 | none | did not run | did not run |
| 20 | none | did not run | did not run |
| 21 | none | did not run | did not run |
| 22 | none | did not run | did not run |
| 23 | none | did not run | did not run |
| 00 | 00:31:23 | true, including Rope, at 00:32:05 | succeeded, Rope 58/11 at 01:02:14 |
| 01, through 01:30 | none | did not run | 00:31 run finished sending |

These are creation hours, not an attribution to particular nominal :41 slots.
The API does not establish whether absent slots were delayed or dropped.

Sources:

- [11:32 run](https://github.com/thomaspryor/Broadwayscore/actions/runs/41821724535): due job `126546251979`; log: `No Reddit draft due`, `No Reddit email due`.
- [18:51 run](https://github.com/thomaspryor/Broadwayscore/actions/runs/41891272613): due job `126789002487`; drafter/sender job `126789526063`; log: Rope selected, then `Sent: Updated Reddit post: Rope (63/100)`.
- [00:31 run](https://github.com/thomaspryor/Broadwayscore/actions/runs/41941944836): due job `126964674427`; drafter/sender job `126964976616`; log: Rope selected, then `Sent: Updated Reddit post: Rope (58/100)`.

## Input and writer trace

`reddit-engagement-digest.yml` calls `scripts/reddit-opening-posts-due.js`.
It and `draft-reddit-opening-posts.js` read `public/data/shows/{id}.json`,
not `reviews.json`. Both call the real `selectCandidates()` in
`scripts/lib/reddit-opening-post.js`. The sender calls `dueEmails()` and
`stampsFor()` in `scripts/lib/reddit-post-email.js`, then writes email stamps
to `data/audit/reddit-post-drafts.json`. No downstream display fix was made.

Historical show JSON and draft records were fetched at the actual checkout
SHAs printed in each due job's logs:

| Checkout SHA | Per-show cs / rc | Last emailed score / reviews | Rope updateCount |
| --- | --- | --- | --- |
| `e4567d4b55af0399853045813f009937cf4f8c73` | 58.11 / 8 | 58 / 8, 08:13:47 | unset (0) |
| `69561d693502492e7cc5deedb0c0be5c30216a0c` | 62.83 / 10 | 58 / 8, 08:13:47 | unset (0) |
| `a5968e82fef958dca7d74342ce5a633280c9147d` | 58.43 / 11 | 63 / 10, 18:59:48 | 1 |

Replaying these real records through origin/main's `dueShows()` and the
extracted function gave identical decisions: false, true, true. The new
report adds warnings to the latter two cases. No LLM or sending was invoked.

The public show's revision at `b67191fe6f3f69eb5c7501840fef3d8fe40669b1`
(19:57:15) still had 62.83/10; `0dcdd2363aa3441f3dd00b3f623b0a0e8e69d141`
(20:15:02) had 59.48/11; `7665d0e2f1008ae9b842b1ee23f27b2cad128d5e`
(20:19:44) had 58.43/11. No scheduled Reddit run was created during those
changes until 00:31. The latter run spent about 24 minutes in the pre-send
review check before sending Rope's update. No failed Rope send appears.

The reviewer's literal "63/10 stale for 7+ hours" is not established by this
window: 63/10 was emailed at 18:59:48 and replaced at 01:02:14, about 6h02m
later. The repo first showed 58/11 at 20:19:44, about 4h42m before that send.
`press-night-digest.js` carries first-seen time by `email:reddit:stale`, not by
the particular score/count pair. A settled miss alone cannot date that pair.
The original filing snapshot and historical CDN deployment times were not
reconstructed. Current raw `reviews.json` has 11 Rope records, per-show `rc`
is 11, and `getCriticScore()` returns 58. Historical private reviews were not
reconstructed; the gate does not consume that file.

## Scope and verification

- Before editing, the card's grade already passed: `PASS 3, STALE 0, FAIL 0`.
  The due job wrote no `GITHUB_STEP_SUMMARY` despite that variable being set.
  `git log -S 'worthAnHourlyRun' --oneline -5 -- scripts/reddit-opening-posts-due.js`
  found baseline commit `ef44ccbd1`. Its existing gate was unchanged from
  origin/main before this edit, so no selection/cap change was justified.
- The CLI now calls `buildDueReport()` in `scripts/lib/reddit-opening-posts-due.js`.
  It logs and appends emailed/current repo numbers, last-send age and gate/hold
  decisions to the run summary. Mismatches with an email at least two hours
  old produce Actions warning annotations once the update cap allows sending.
  This is email age, not a claim about how long the mismatch has existed.
- At fixed time 2026-11-05T21:00Z, all nine active real drafts retained the
  same selection. Nine diagnostic rows and two mismatch warnings were added.
  Rope stayed 58/11, Tosca (ENO) 65/16, and The Lives of Others 77/29, all
  matching their emails. No data or email state changed.
- Targeted tests: 66/66 gate/opening-post tests and 61/61 related tests passed.
  The grade, digest snapshot check and press-night record check all passed.
  `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`
  printed `lint-workflows: all gates green`, exit 0. `actionlint` was absent.
- Additional runtime cost: zero paid fetches, zero LLM calls, zero API calls.
  The report runs in the existing hourly due job. Its boolean/ids are unchanged.

## Remaining

A reliable scheduling fallback or independent watchdog needs workflow or
external-scheduler changes, which this worker is explicitly forbidden to make.
Warnings cannot run while GitHub does not start the job, and Actions warnings
are not an independently delivered owner alert. Diagnose delayed versus dropped
slots and add a fallback before treating the scheduling acceptance criterion as
complete. Preserve these findings with the card through the runner's report;
this worker has not written to Linear or changed workflows.
