# Pre-Reddit Launch Audit (Feb 7, 2026)

## RED ALERT - Fix Before Posting

### 1. CATS: The Jellicle Ball - Garbled Creative Team (LIVE ON SITE)
~30 entries of LLM-hallucinated garbage as the creative team, including "Tony Award" as Director, Wicked's book writer, Lion King's composers, and sentence fragments. Real directors: Zhailon Levingston and Bill Rauch. Choreographer: Omari Wiles.

### 2. CATS: The Jellicle Ball - $432M All-Time Gross
Box office page shows CATS: The Jellicle Ball with $432M all-time gross — original 1982 CATS data misattributed to the revival.

### 3. Wrong Venues (2 shows)
- **Just in Time** → listed at August Wilson Theatre, actually at **Circle in the Square Theatre**
- **Ragtime** → listed at Majestic Theatre, actually at **Vivian Beaumont Theater**

### 4. Plays Misclassified as Musicals (2 shows)
- **Dog Day Afternoon** (Stephen Adly Guirgis play) → listed as "musical"
- **The Fear of 13** (Adrien Brody play) → listed as "musical"

### 5. Fabricated Synopses (4 shows)
- **Dead Outlaw** → describes ghost revenge story. Actually about Elmer McCurdy's mummified corpse
- **Cult of Love** → describes cult entanglement. Actually about dysfunctional family Christmas
- **Swept Away** → generic island survival. Actually 1888 whaling ship with Avett Brothers music
- **Romeo + Juliet** → describes Baz Luhrmann film, not Sam Gold Broadway production

### 6. Tony Awards Data Missing Historic Wins
- **Maybe Happy Ending** → missing Darren Criss Best Actor (first Asian American winner)
- **Sunset Boulevard** → missing Nicole Scherzinger Best Actress
- **Oh, Mary!** → missing Cole Escola Best Actor (first nonbinary winner)
- **Gypsy 2024** → wrong season (2023-24 → 2024-25), missing 4 of 5 nominations

### 7. Death Becomes Her - Wrong Composer
David Krane (orchestrator) listed as Composer. Real: Julia Mattison & Noel Carey. Book: Marco Pennette (not Lesley Headland).

### 8. Stereophonic Missing Playwright
David Adjmi completely absent from creative team.

---

## HIGH PRIORITY

### 9. Stereophonic Pulitzer Data Wrong
Listed as Pulitzer Finalist — was NOT a finalist. Remove field.

### 10. Trip to Bountiful Score Bug
B+ parsed as "D" → score 35 instead of ~87. Only scored review for the show.

### 11. Stereophonic Sara Holdren Vulture Review
Full text present but contentTier="excerpt" → scored 60 instead of 90+. Tier 1 outlet.

### 12. Critic Name Typos Creating Duplicates
- "Ben Branley" vs "Ben Brantley" (Enron)
- "Terry Techout" vs "Terry Teachout" (Hadestown)

### 13. Kinky Boots & Come From Away Wrong Designations
Both "Easy Winner" — should be "Windfall" (6-year and 5-year runs).

### 14. Mamma Mia Duplicate Review Excerpts
Two reviews display identical excerpt text on live site.

### 15. Liberation Venue
"Brooks Atkinson Theatre" → renamed "James Earl Jones Theatre" in 2022.

### 16. Methodology Page Outdated
Still describes old fixed 20% Reddit weight. Actual: proportional volume-based.

### 17. The Outsiders Credits Incomplete
Missing Justin Levine from Book and Music & Lyrics credits.

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
