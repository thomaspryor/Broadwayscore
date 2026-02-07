# Pre-Reddit Launch Audit (Feb 7, 2026)

## RED ALERT - Fix Before Posting (ALL FIXED)

### 1. CATS: The Jellicle Ball - Garbled Creative Team ✅ FIXED
~30 entries of LLM-hallucinated garbage as the creative team. Fixed: correct directors (Zhailon Levingston, Bill Rauch), choreographer (Omari Wiles).

### 2. CATS: The Jellicle Ball - $432M All-Time Gross ✅ FIXED
Original 1982 CATS data misattributed to revival. Fixed with separate grosses tracking.

### 3. Wrong Venues (2 shows) ✅ FIXED
Just in Time → Circle in the Square, Ragtime → Vivian Beaumont.

### 4. Plays Misclassified as Musicals ✅ FIXED
Dog Day Afternoon and The Fear of 13 reclassified as plays.

### 5. Fabricated Synopses (4 shows) ✅ FIXED
Dead Outlaw, Cult of Love, Swept Away, Romeo + Juliet all replaced with correct synopses.

### 6. Tony Awards Data ✅ FIXED
All missing wins added. Gypsy season corrected.

### 7. Death Becomes Her - Wrong Composer ✅ FIXED
Corrected to Julia Mattison & Noel Carey.

### 8. Stereophonic Missing Playwright ✅ FIXED
David Adjmi added via playwright backfill.

---

## HIGH PRIORITY (ALL FIXED)

### 9. Stereophonic Pulitzer Data Wrong ✅ FIXED
Removed incorrect Pulitzer Finalist field.

### 10. Trip to Bountiful Score Bug ✅ FIXED
Added humanReviewScore: 78 (B-) based on BWW excerpt evidence. Brantley praised Tyson but criticized production.

### 11. Stereophonic Sara Holdren Vulture Review ✅ FIXED
contentTier corrected excerpt→complete, humanReviewScore: 95. Was one of 42 database-wide contentTier mismatches, all fixed.

### 12. Critic Name Typos Creating Duplicates ✅ FIXED (DATABASE-WIDE)
Found and fixed 217 critic name typo duplicates across the entire database (not just the 2 originally flagged). 177 merges + 40 renames. Major patterns:
- Melissa Rose Bernardo / Rose Bernardo at NYSR (~70 shows)
- Ben Brantley typos (5 variants across 6 shows)
- Elisabeth Vincentelli typos (6 variants across 10 shows)
- Joe Dziemianowicz typos (5 variants across 8 shows)
- Thom Geier, Terry Teachout, Johnny Oleksinski, Matt Windman, etc.
**Root cause fix:** Added 50+ new critic name aliases to review-normalization.js.

### 13. Kinky Boots & Come From Away Wrong Designations ✅ FIXED
Both changed from "Easy Winner" to "Windfall" (6-year and 5-year runs with tours).

### 14. Mamma Mia Duplicate Review Excerpts ✅ FIXED
Caused by elisabeth/elizabeth Vincentelli typo creating two files. Merged into one.

### 15. Liberation Venue ✅ FIXED
Updated to James Earl Jones Theatre.

### 16. Methodology Page Outdated ✅ FIXED
Updated from "fixed 20% Reddit weight" to proportional volume-based weighting with 80% ceiling.

### 17. The Outsiders Credits Incomplete ✅ FIXED
Split "Jamestown Revival and Justin Levine" into separate Music & Lyrics entries.

---

## BONUS: Database-Wide Cleanup (Feb 7, 2026)

### ContentTier Mismatches ✅ FIXED
42 review files had contentTier="excerpt" but contained full review text (500+ chars). All reclassified using classifyContentTier(). Affected outlets: Guardian (5), Observer (5), Lighting & Sound America (6), EW (4), and others.

### Root Cause Prevention ✅ SHIPPED
- 50+ new critic name aliases in review-normalization.js
- collect-review-texts.js already reclassifies contentTier after text collection (verified)
- discover-new-shows.js already preserves IBDB creative teams (verified)

---

## DEBATE POINTS (Design Decisions, Not Bugs)

### 18. "Stay Away" / "Skippable" Labels
78 shows "Skippable," 29 "Stay Away." Harsh for shows with passionate fanbases.

### 19. Beloved Shows Just Miss "Must-See"
Stereophonic (84.9), Book of Mormon (83.2), Oh Mary! (83.2), Merrily (84.2)

### 20. 99.9% of Scores Are AI-Generated
LLM ensemble assigns virtually all scores.

### 21. NYT Critics' Pick +3 Bonus + Score Floor of 70
Codifies NYT privilege.

### 22. Plays Dominate Top Rankings
Plays avg 70.9 vs musicals 68.9. Top 20: 14 plays, 6 musicals.
