# Opening-night watch and morning-after audit (cloud): record only

Unlike the other files here, NO routine reads this file. Both routines below
carry their whole instructions in their own prompt, so editing this file
changes nothing they do. It exists so `config/mac-retired.json` can name a
checkable replacement for the Mac's `com.bwsc.opening-night-monitor`
(retired 2026-10-11, BRO-4638), and so the gap below is written down.

| Routine | Schedule (America/New_York) | What it does |
|---|---|---|
| Opening night live watch (Broadway) | daily 23:17 | For shows opening TODAY: checks the pipeline runs (opening-night-orchestrator.yml, opening-night-poller.yml, opening-night-express.yml, scoring, rebuild, deploy), fixes stuck ones, compares live reviews with the BWW roundup, DTLI and Playbill, repeats passes until 02:00 on a Broadway night. Logs to a Linear "Opening-night watch <date>" card. |
| Opening night morning-after audit (Broadway) | daily 06:47 | For shows that opened YESTERDAY or today: pastes the press-night record (its prompt names `scripts/press-night-audit-summary.js`, which does not exist; BRO-6067 shipped instead as `scripts/lib/press-night-audit-note.js`, which `scripts/linear-brain.js` applies to every "Opening-night audit <date>" card, flagging a FAIL or UNKNOWN record at the top), audits coverage and quality against the same aggregators, fixes through the CI fix route. Logs to a Linear "Opening-night audit <date>" card. |

Both were enabled, and both last ran successfully on 2026-10-25
(checked with the scheduled-task list, BRO-6216).

## Gap against the Mac monitor

The Mac launcher (`scripts/opening-night-monitor-launch.js`) picked shows
more broadly than the orchestrator's gates, on purpose, to catch the shows
those gates skip. The routines pick shows by opening date only
(`scripts/lib/opening-night-selection.js`), so a show the orchestrator skips
for another reason is still seen, but one with a wrong or missing
openingDate is not. Nothing replaced that part.
