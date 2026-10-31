# BRO-6268 state (2026-10-27 ~16:45Z)

## Findings
- Seasons already promoted by earlier cards: 2012-13..2015-16. Owners: BRO-6396 (2015-16, 2014-15 gather/score/SEASON PASS), BRO-6428 (2013-14, 2012-13). Nobody has 2011-12 / 2010-11 yet (0 promoted).
- 2015-16 audit: only FAIL is displayable 0.68 (15/22 shows with >=5 reviews, need 16).
- Landed (land run 40535678633 green): heuristicClassify no longer flags WOS "Photo Gallery NNN" widget as a gallery page. 3 real WOS reviews had been wrongly flagged (hangmen-west-end-2015, pigeon-english-west-end-2016, stepping-out-west-end-2017); flags cleared in broadway-review-texts (d36f17bb555). Rebuild dispatched: run 40539539237.
- End of Longing's Daily Mail/Metro files are correctly rejected as not_a_review; not a gap.
- Wayback CDX timed out locally, so build-we-olt-season.js for 2011-12 failed; retry via cloud-run-script.js.
- Spend this session: ~0 (one tiny scoring dispatch that scored nothing). OCR path not built; TR 2015-16 is digital-text, pre-2015 scanned (scripts/probe-tr-scanned.js, we-historical-tr-ocr-probe.yml).

## Next
1. After run 40539539237: `git pull; node scripts/audit-we-historical-season.js --season=2015-2016` (expect Hangmen 5 scored -> 16/22 -> displayable PASS). Also needs fact-check sample.
2. `node scripts/cloud-run-script.js scripts/build-we-olt-season.js --season=2011-2012 --print-pages` then --pages-from, for 2011-12 and 2010-11.
3. Build TR OCR path for pre-2015 issues (cost-measure on 5 shows first).
