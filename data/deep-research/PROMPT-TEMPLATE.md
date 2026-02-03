# GPT Deep Research Prompt Template

Use this prompt when running GPT Deep Research for Broadway show financial data. Copy the template below, replace `[SHOW_TITLE]` and `[YEAR]`, and paste into GPT's Deep Research mode.

---

## Prompt

Research the Broadway production of **[SHOW_TITLE] ([YEAR])** and find the following financial/commercial data. Be specific — give exact numbers, not ranges, whenever possible. Cite your sources.

### Fields to Research

1. **Capitalization** — Total investment to mount the production (the "nut" before opening). Look for SEC Form D filings, press announcements, NY Times/Variety/Deadline articles, and Reddit r/Broadway discussions.

2. **Recoupment** — Has the show recouped its capitalization? If yes, when (month/year)? How many weeks/performances did it take? Look for official announcements, trade press reports, and Reddit r/Broadway posts.

3. **Weekly Running Cost** — The estimated weekly operating cost to keep the show running. This is different from the gross — it's what the show spends per week (cast salaries, theater rent, royalties, crew, marketing, etc.). **IMPORTANT: Search Reddit r/Broadway for posts titled "GROSSES ANALYSIS" by u/Boring_Waltz_9545.** This user posts weekly and includes estimated operating costs for every currently running Broadway show. These posts are the single best source for weekly running costs. Also check trade press (Deadline, Variety, Broadway Journal).

4. **SVOG Grant** — Did the production receive a Shuttered Venue Operators Grant (federal COVID-era funding, up to $10M)? Only applies to shows that were running or had signed theater leases during 2020-2021. The SBA published a full list of SVOG recipients.

5. **Investor Caveats / Special Deals** — Any unusual financial arrangements:
   - Star profit participation (e.g., Alicia Keys in Hell's Kitchen, Jackson Estate in MJ)
   - Cast profit pools (e.g., Hamilton's ensemble profit sharing)
   - Producer/creator equity stakes (e.g., Idina Menzel co-producing Redwood)
   - NY State musical tax credit ($3M available per qualifying musical)
   - Unusual royalty structures, co-production deals, or corporate backing

### Sources to Check (in priority order)

1. **SEC EDGAR** — Search for Form D filings related to the production company or LLC name (e.g., "Hamilton Broadway LLC"). These contain the official capitalization amount.
2. **Reddit r/Broadway** — Search for:
   - Posts by u/Boring_Waltz_9545 titled "GROSSES ANALYSIS" (weekly operating cost estimates)
   - Recoupment announcement threads
   - Financial discussion threads mentioning the show
3. **Trade press** — Deadline, Variety, Broadway News, Broadway Journal, NY Times theater section, The Wrap
4. **Broadway Journal** — Often has recoupment announcements and insider financial coverage
5. **Playbill / TheaterMania** — Closing announcements, recoupment celebrations
6. **SBA SVOG database** — For SVOG grant verification

### Output Format

Please structure your response with these exact headers:

**Capitalization:** $X million (source)

**Recoupment:** Yes/No. (Details — when, how long it took, context)

**Recoupment Date:** Month Year (or N/A if not recouped)

**Weekly Running Cost:** $X (source — specify if from Reddit Grosses Analysis, trade press, or estimate)

**SVOG Grant:** Yes ($X) / No / Unknown (reasoning)

**Investor Caveats:** Description of any special financial arrangements. (source)

### Raw Quotes

If you find direct quotes from sources (especially Reddit posts, SEC filings, or trade articles), include them verbatim in a "Raw Quotes" section at the end. These are invaluable for verification.

### Sources

List all URLs and source descriptions used.

---

## After Running Deep Research

1. Save the output to `data/deep-research/{show-slug}.md` using the standard header format (see existing files for examples)
2. Apply any corrections to `data/commercial.json`
3. Add/update the `deepResearch` stamp on the show's commercial entry
4. Run `node scripts/validate-data.js` before committing

## Show Slug Convention

Use the show's slug from `shows.json` (e.g., `death-becomes-her`, `the-great-gatsby`, `cats-the-jellicle-ball`). For shows with year suffixes in shows.json, use the base slug without year for the .md filename unless there are multiple productions (e.g., `mamma-mia-2001.md` vs `mamma-mia.md` for the 2025 tour).
