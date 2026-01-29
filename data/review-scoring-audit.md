# Review Scoring Audit Report

Generated: 2026-01-29

## Summary

| Category | Count | Description |
|----------|-------|-------------|
| Low Confidence | 66 | LLM scored but marked as low confidence |
| Needs Review | 113 | LLM scored but flagged for human review |
| Assigned Score | 9 | Manually or algorithmically assigned scores |
| Thumb-Based | 20 | Derived from DTLI/BWW thumbs (no LLM score) |

---

## How Scoring Works

### LLM Ensemble Scoring
- **Claude + GPT-4o-mini** score each review independently
- Final score is the **average** of both models
- Scores are validated against DTLI/BWW thumbs for quality assurance

### Thumb Usage (Important!)
**DTLI/BWW thumbs are used for VALIDATION, not as scoring inputs:**
- After LLM scoring, the system compares the LLM's derived thumb (Up/Flat/Down based on score) against aggregator thumbs
- If they conflict, the review is flagged as "needs review"
- Thumbs are NOT fed into the LLM prompt

### When Thumbs ARE Used as Scores
- Only when a review has **no LLM score at all** (scoring failed or never ran)
- In that case, the rebuild script falls back to thumb-derived scores:
  - Up → 78
  - Flat/Meh → 58
  - Down → 38

---

## Low Confidence Reviews (66)

These reviews were scored but the LLM ensemble had low confidence, typically because:
- The excerpt was very short or incomplete
- The text was ambiguous or didn't contain clear evaluative language
- The models disagreed significantly (>15 points)

**What we did:** We now accept low-confidence scores (marked as `llmScore-lowconf`) rather than skipping them, since a low-confidence score is still better than no score.

| # | Show | Outlet | Critic | Score | Reasoning |
|---|------|--------|--------|-------|-----------|
| 1 | aladdin-2014 | huffpost | Steven Suskin | 48 | Claude: The incomplete review fragment suggests disappointment with direction and design elements falling short of past work, with only lighting recei... |
| 2 | aladdin-2014 | Reflections in the Light | Lauren Yarger | 64 | Claude: While the critic expresses genuine enthusiasm for the production values and performances they saw, they explicitly state this isn't a real rev... |
| 3 | an-enemy-of-the-people-2024 | The New York Times | Jesse Green | 50 | Claude: This appears to be a technical error page rather than an actual review, making it impossible to assess the critic's recommendation. - GPT-4o-m... |
| 4 | an-enemy-of-the-people-2024 | Philadelphia Inquirer | Howard Shapiro | 60 | Claude: This appears to be only the opening paragraph of a longer review, providing context and setup but no clear evaluative judgment or recommendati... |
| 5 | appropriate-2023 | Talkin' Broadway | Matthew Murray | 63 | Claude: This excerpt only praises Paulson's performance while remaining silent on all other aspects of the production, suggesting the performance may ... |
| 6 | back-to-the-future-2023 | unknown | Unknown | 45 | Claude: The provided text appears to be mostly website navigation and show listings rather than an actual review, with only a brief headline and subti... |
| 7 | book-of-mormon-2011 | The Wall Street Journal | Terry Teachout | 58 | Claude: The fragment suggests predictable material described as 'slick and smutty' which reads as faint praise at best, but the review is too incomple... |
| 8 | buena-vista-social-club-2025 | Broadway News | Brittani Samuel | 45 | Claude: The review text appears to be truncated and mostly consists of publication metadata rather than actual critical content, making assessment dif... |
| 9 | bug-2026 | The Wall Street Journal | Charles Isherwood | 65 | Claude: This appears to be an incomplete excerpt focusing primarily on Carrie Coon's bold performance, with limited evaluative content to assess the c... |
| 10 | cabaret-2024 | Broadway News | Brittani Samuel | 55 | Claude: This appears to be an incomplete review excerpt that cuts off mid-analysis, making it impossible to determine the critic's overall recommendat... |
| 11 | cabaret-2024 | Deadline | Greg Evans | 45 | Claude: This is not actually a review of any specific show but rather an introduction to a compendium of Broadway reviews, making it impossible to ass... |
| 12 | chess-2025 | The Washington Post | Naveen Kumar | 64 | Claude: The critic uses 'rousing' and 'outsize ambitions' positively while acknowledging flaws ('unwieldy', 'hot mess'), suggesting a flawed but energ... |
| 13 | chicago-1996 | Time | Unknown | 53 | Claude: This appears to be a general commentary about Broadway revival strategy rather than a specific show review, making it impossible to assess act... |
| 14 | days-of-wine-and-roses-2024 | New York Theatre Guide | Gillian | 69 | Claude: The wine metaphor strongly suggests improvement and maturation since the Off-Broadway run, indicating a positive recommendation despite the ex... |
| 15 | death-becomes-her-2024 | The Wall Street Journal | Charles Isherwood | 63 | Claude: This appears to be an incomplete excerpt that cuts off mid-sentence, making it impossible to determine the critic's overall recommendation or ... |
| 16 | grey-house-2023 | Chicago Tribune | Chris | 61 | Claude: The critic respects the artistic choices and praises both the playwright and director for their uncompromising vision, though acknowledges the... |
| 17 | grey-house-2023 | Observer | David Cote | 58 | Claude: The review's tone suggests the play itself is undeserving of its high-profile production and cast, implying the material doesn't merit the tre... |
| 18 | gutenberg-2023 | Observer | David Cote | 68 | Claude: The excerpt focuses entirely on positive praise for design elements (scenic, costume) with enthusiastic language, but it's clearly incomplete ... |
| 19 | hadestown-2019 | Talkin' Broadway | Nancy Grossman | 68 | Claude: This appears to be a brief description rather than a full review, with positive descriptive language but no clear recommendation or critical a... |
| 20 | hamilton-2015 | Talkin' Broadway | Matthew Murray | 64 | Claude: The critic acknowledges Hamilton's cultural significance and improved performances while finding it dramatically unsatisfying and derivative, ... |
| 21 | harmony-2023 | The New York Sun | Elysa Gardner | 60 | Claude: The excerpt shows praise for Manilow's music and Carlyle's performance but appears to be cut off mid-sentence, making it impossible to assess ... |
| 22 | harry-potter-2021 | The Washington Post | Peter Marks | 63 | Claude: The excerpt describes the show as primarily serving fans rather than offering theatrical merit, with language suggesting it's more spectacle t... |
| 23 | here-lies-love-2023 | Observer | Rex Reed | 73 | Claude: While the review praises production elements and immersive experience, it's too brief and focused only on spectacle without addressing story, ... |
| 24 | here-lies-love-2023 | Rolling Stone | Brittany Spanos | 75 | Claude: This appears to be a descriptive excerpt rather than a critical evaluation, describing innovative staging and immersive elements positively bu... |
| 25 | illinoise-2024 | New York Theater | Jonathan Mandell | 65 | Claude: The excerpt shows mixed signals with praise for choreography and music but describes emotions as an 'overwhelming jumble,' and the text cuts o... |
| 26 | jajas-african-hair-braiding-2023 | Variety | Aramide Timubu | 63 | Claude: This excerpt focuses entirely on production design praise but cuts off mid-sentence, making it impossible to determine the critic's overall re... |
| 27 | liberation-2025 | Variety | Aramide Tinubu | 56 | Claude: This appears to be only the opening paragraphs of a review with mostly plot description and context-setting, lacking clear evaluative language... |
| 28 | mamma-mia-2025 | Entertainment Weekly | Emlyn Travis | 64 | Claude: The critic balances strong criticism of the production's tacky appearance with genuine affection for the overall experience, landing on a qual... |
| 29 | merrily-we-roll-along-2023 | New York Theatre Guide | Joe Dziemianowicz | 63 | Claude: Praises Radcliffe's performance but immediately undercuts the musical highlight with visceral negative imagery, suggesting discomfort with the... |
| 30 | merrily-we-roll-along-2023 | Slash Film | Caroline Cao | 68 | Claude: The excerpt shows appreciation for the production's visual elements and staging but cuts off mid-sentence, making it impossible to determine t... |
| 31 | merrily-we-roll-along-2023 | Variety | Trish Deitch | 69 | Claude: The critic frames the show's complexity as artistic merit rather than a flaw, explicitly calling it 'art' and praising its sophisticated struc... |
| 32 | mj-2022 | New York Daily News | Joe Dziemianowicz | 66 | Claude: The phrase 'at its best when' implies the show has significant weaknesses elsewhere, making this praise for music and performances feel like i... |
| 33 | mother-play-2024 | Entertainment Weekly | Christian Holub | 50 | No reasoning available... |
| 34 | mother-play-2024 | New York Daily News | Chris | 60 | Claude: This excerpt focuses entirely on Jessica Lange's casting and character description without any clear recommendation signal or assessment of th... |
| 35 | mother-play-2024 | Talkin' Broadway | Howard Miller | 55 | Claude: The excerpt criticizes underwritten material while praising Lange's nuanced performance, suggesting strong acting undermined by weak writing, ... |
| 36 | moulin-rouge-2019 | The Daily Beast | Tim Teeman | 50 | Claude: Critics acknowledge the show's spectacular visual appeal and entertainment value while heavily criticizing the thin characterization and weak ... |
| 37 | moulin-rouge-2019 | Deadline | Greg Evans | 38 | Claude: The metaphor about turning off a spigot suggests the show is excessive and overwrought, implying poor creative restraint. - GPT-4o-mini: The r... |
| 38 | moulin-rouge-2019 | The Guardian | Alexis Soloski | 56 | Claude: The 'critic-proof' phrase suggests the show succeeds despite flaws and will likely please audiences, outweighing the character criticism. - GP... |
| 39 | moulin-rouge-2019 | New York Daily News | Joe Dziemianowicz | 54 | Claude: The fragmented excerpts suggest mixed reactions - acknowledging the spectacle while noting emotional shortcomings and loss of the film's impac... |
| 40 | moulin-rouge-2019 | The New York Times | Jesse Green | 51 | Claude: The review offers a qualified, conditional recommendation suggesting the show appeals to a specific niche audience seeking extreme stimulation... |
| 41 | moulin-rouge-2019 | The Telegraph | Diane Snyder | 60 | Claude: The excerpt is incomplete but begins with neutral setup and ends with 'And although it isn't...' suggesting disappointment or criticism is com... |
| 42 | moulin-rouge-2019 | Time Out New York | Adam Feldman | 69 | Claude: Despite some reservations about conventionality and surface-level appeal, the critic clearly praises the visual spectacle, performances, and o... |
| 43 | once-upon-a-one-more-time-2023 | USA Today | David Oliver | 50 | No reasoning available... |
| 44 | operation-mincemeat-2025 | Time Out New York | Adam Feldman | 55 | Claude: While praising one performer and moment, the review implies the rest of the show feels forced and lacks authentic feeling, suggesting signific... |
| 45 | our-town-2024 | The Wrap | Robert Hofler | 38 | Claude: The critic strongly questions the director's decision to cut intermissions from a revered play, implying this is a problematic choice that und... |
| 46 | prayer-for-the-french-republic-2024 | Variety | Aramide Tinubu | 60 | Claude: This appears to be a plot summary rather than an evaluative review, offering descriptive language about themes but no clear critical judgment ... |
| 47 | purlie-victorious-2023 | The Daily Beast | Tim Teeman | 77 | Claude: The excerpt praises the play as both funny and impactful, but lacks explicit recommendation language or evaluation of the production quality t... |
| 48 | purlie-victorious-2023 | Slant Magazine | Dan Rubins | 60 | Claude: The review explicitly states the parts are better than the whole, suggesting fundamental problems with the production despite praising specifi... |
| 49 | queen-versailles-2025 | New York Theatre Guide | Joe Dziemianowicz | 61 | Claude: This excerpt praises Chenoweth's performance skills but suggests she's overcompensating ('works overtime', 'timeshare broker') for material th... |
| 50 | real-women-have-curves-2025 | New York Stage Review | Melissa Rose | 55 | Claude: This appears to be a brief excerpt highlighting only the strongest musical moments of what seems to be an otherwise weak show, suggesting the ... |
| 51 | redwood-2025 | Observer | David Cote | 63 | Claude: This single quote appears to describe a desired emotional outcome rather than an actual review assessment, making it impossible to determine t... |
| 52 | redwood-2025 | The Washington Post | Naveen Kumar | 63 | Claude: The phrase suggests the show delivers a meaningful, life-affirming message that inspires positive action, indicating a positive response despi... |
| 53 | six-2021 | The Wall Street Journal | Charles Isherwood | 75 | Claude: This appears to be a neutral description rather than a review, with descriptive language that could be interpreted as either energetic praise ... |
| 54 | stereophonic-2024 | Associated Press | Mark Kennedy | 64 | Claude: This excerpt provides thematic description without clear evaluative language or recommendation signals, making it impossible to determine the ... |
| 55 | stereophonic-2024 | Entertainment Weekly | Allison Considine | 63 | Claude: This appears to be a severely truncated excerpt that cuts off mid-sentence with technical metadata, making it impossible to determine the actu... |
| 56 | the-lion-king-1997 | columbus-dispatch | Michael Grossberg | 65 | Claude: While 'triumph of theatrical imagination' suggests strong praise for the production, this appears to be only a fragment or headline rather tha... |
| 57 | the-lion-king-1997 | Milwaukee Journal Sentinel | Damien Jaques | 68 | Claude: This fragment shows extremely high praise for direction but provides no information about overall recommendation, other components, or the cri... |
| 58 | the-lion-king-1997 | Vulture | John Simon | 54 | Claude: Despite harsh criticism of the music and story as 'second-rate' and 'simplistic,' the critic's overwhelming praise for the visual spectacle as... |
| 59 | the-lion-king-1997 | The Washington Post | Lloyd Rose | 81 | Claude: Strong praise for visuals and direction but criticism of the story creates a qualified positive recommendation where the spectacle overcomes n... |
| 60 | the-notebook-2024 | New York Theatre Guide | Andy Propst | 67 | Claude: This single sentence excerpt suggests conditional approval - the musical 'works' under specific circumstances, implying it doesn't always work... |
| 61 | the-outsiders-2024 | Variety | Naveen Kumar | 45 | Claude: The headline suggests the musical has emotional content but lacks impact or effectiveness, indicating a disappointing production despite good ... |
| 62 | the-roommate-2024 | The Washington Post | Naveen Kumar | 55 | Claude: The review is incomplete but suggests the star casting creates problems rather than solutions, with mixed signals about whether the production... |
| 63 | the-whos-tommy-2024 | Broadway News | Brittani Samuel | 58 | Claude: This excerpt shows mixed signals - praising the explosive staging while suggesting the opening challenges audience patience, but the fragment ... |
| 64 | the-whos-tommy-2024 | The Wall Street Journal | Charles Isherwood | 53 | Claude: This appears to be only the opening paragraph of a longer review with overwhelmingly positive language, making a confident score impossible fr... |
| 65 | the-wiz-2024 | Variety | Naveen Kumar | 51 | Claude: The critic suggests this revival weakens the show's core strengths through excessive stylistic choices, indicating disappointment despite ackn... |
| 66 | water-for-elephants-2024 | The Wall Street Journal | Charles Isherwood | 31 | Claude: The review appears to criticize the show for lacking authentic circus atmosphere and being too sanitized, but this is only a partial excerpt m... |

---

## Needs Review Reviews (113)

These reviews were scored but flagged for human review, typically because:
- Claude and GPT-4o-mini scores differed by >15 points
- The LLM-derived thumb conflicts with the aggregator thumb

**What we did:** We now accept these scores (marked as `llmScore-review`) since the ensemble average is still a reasonable estimate.

### Breakdown by Reason
- **Thumb conflict:** 111 reviews
- **Model disagreement:** 2 reviews

| # | Show | Outlet | Score | Claude | GPT | Delta | Thumb Match | Reason |
|---|------|--------|-------|--------|-----|-------|-------------|--------|
| 1 | back-to-the-future-2023 | chelsea-community-news | 66 | 62 | 70 | 8 | ✗ | Score (66 → Flat) conflicts with aggregator thumbs (Up) |
| 2 | back-to-the-future-2023 | New York Post | 25 | 25 | 25 | 0 | ✗ | Score (25 → Down) conflicts with aggregator thumbs (Flat) |
| 3 | back-to-the-future-2023 | New York Stage Review | 75 | null | 75 | 0 | ✗ | Score (75 → Up) conflicts with aggregator thumbs (Down) |
| 4 | back-to-the-future-2023 | New York Theater | 49 | null | 0 | 0 | ✗ | Score (0 → Down) conflicts with aggregator thumbs (Up) |
| 5 | back-to-the-future-2023 | The New York Times | 47 | 48 | 45 | 3 | ✗ | Score (47 → Down) conflicts with aggregator thumbs (Flat) |
| 6 | back-to-the-future-2023 | The Wrap | 40 | 40 | 40 | 0 | ✗ | Score (40 → Down) conflicts with aggregator thumbs (Flat) |
| 7 | back-to-the-future-2023 | Variety | 48 | 48 | 48 | 0 | ✗ | Score (48 → Down) conflicts with aggregator thumbs (Flat) |
| 8 | back-to-the-future-2023 | Vulture | 49 | 42 | 55 | 13 | ✗ | Score (49 → Down) conflicts with aggregator thumbs (Flat) |
| 9 | boop-2025 | New York Stage Review | 65 | 65 | 65 | 0 | ✗ | Score (65 → Flat) conflicts with aggregator thumbs (Up) |
| 10 | boop-2025 | New York Theater | 64 | 62 | 65 | 3 | ✗ | Score (64 → Flat) conflicts with aggregator thumbs (Up) |
| 11 | boop-2025 | The New York Times | 34 | 38 | 30 | 8 | ✗ | Score (34 → Down) conflicts with aggregator thumbs (Flat) |
| 12 | boop-2025 | The New York Times | 44 | 42 | 45 | 3 | ✗ | Score (44 → Down) conflicts with aggregator thumbs (Flat) |
| 13 | boop-2025 | Variety | 38 | 40 | 35 | 5 | ✗ | Score (38 → Down) conflicts with aggregator thumbs (Flat) |
| 14 | bug-2026 | 4columns | 64 | 62 | 65 | 3 | ✗ | Score (64 → Flat) conflicts with aggregator thumbs (Up) |
| 15 | bug-2026 | amNewYork | 68 | 68 | 68 | 0 | ✗ | Score (68 → Flat) conflicts with aggregator thumbs (Up) |
| 16 | bug-2026 | The Daily Beast | 67 | 68 | 65 | 3 | ✗ | Score (67 → Flat) conflicts with aggregator thumbs (Up) |
| 17 | bug-2026 | New York Stage Review | 65 | 65 | 65 | 0 | ✗ | Score (65 → Flat) conflicts with aggregator thumbs (Up) |
| 18 | bug-2026 | Vulture | 65 | 68 | 62 | 6 | ✗ | Score (65 → Flat) conflicts with aggregator thumbs (Up) |
| 19 | cabaret-2024 | The New York Times | 77 | 78 | 75 | 3 | ✗ | Score (77 → Up) conflicts with aggregator thumbs (Flat) |
| 20 | cabaret-2024 | The New York Times | 70 | 65 | 75 | 10 | ✗ | Score (70 → Up) conflicts with aggregator thumbs (Flat) |
| 21 | cabaret-2024 | The Wrap | 39 | 38 | 40 | 2 | ✗ | Score (39 → Down) conflicts with aggregator thumbs (Flat) |
| 22 | cabaret-2024 | Variety | 78 | 78 | 78 | 0 | ✗ | Score (78 → Up) conflicts with aggregator thumbs (Flat) |
| 23 | cabaret-2024 | Vulture | 54 | 52 | 55 | 3 | ✗ | Score (54 → Flat) conflicts with aggregator thumbs (Down) |
| 24 | cabaret-2024 | The Wall Street Journal | 74 | 72 | 75 | 3 | ✗ | Score (74 → Up) conflicts with aggregator thumbs (Flat) |
| 25 | chicago-1996 | The New York Times | 50 | null | 50 | 0 | N/A | Models disagree by 50 points (Claude: 0, OpenAI: 50) |
| 26 | days-of-wine-and-roses-2024 | amNewYork | 62 | 62 | 62 | 0 | ✗ | Score (62 → Flat) conflicts with aggregator thumbs (Up) |
| 27 | days-of-wine-and-roses-2024 | New York Daily News | 78 | 76 | 80 | 4 | ✗ | Score (78 → Up) conflicts with aggregator thumbs (Flat) |
| 28 | death-becomes-her-2024 | New York Stage Review | 40 | 35 | 45 | 10 | N/A | Models disagree by 17 points (Claude: 28, OpenAI: 45) |
| 29 | doubt-2024 | Cititour | 69 | 72 | 65 | 7 | ✗ | Score (69 → Flat) conflicts with aggregator thumbs (Up) |
| 30 | doubt-2024 | New York Theater | 65 | 65 | 65 | 0 | ✗ | Score (65 → Flat) conflicts with aggregator thumbs (Up) |
| 31 | doubt-2024 | Variety | 68 | 68 | 68 | 0 | ✗ | Score (68 → Flat) conflicts with aggregator thumbs (Up) |
| 32 | doubt-2024 | Vulture | 65 | 65 | 65 | 0 | ✗ | Score (65 → Flat) conflicts with aggregator thumbs (Up) |
| 33 | grey-house-2023 | New York Daily News | 71 | 72 | 70 | 2 | ✗ | Score (71 → Up) conflicts with aggregator thumbs (Flat) |
| 34 | grey-house-2023 | New York Stage Review | 79 | 78 | 80 | 2 | ✗ | Score (79 → Up) conflicts with aggregator thumbs (Flat) |
| 35 | grey-house-2023 | Theatrely | 71 | 72 | 70 | 2 | ✗ | Score (71 → Up) conflicts with aggregator thumbs (Flat) |
| 36 | grey-house-2023 | Vulture | 67 | 68 | 65 | 3 | ✗ | Score (64 → Flat) conflicts with aggregator thumbs (Up) |
| 37 | grey-house-2023 | The Washington Post | 41 | 42 | 40 | 2 | ✗ | Score (41 → Down) conflicts with aggregator thumbs (Flat) |
| 38 | gutenberg-2023 | amNewYork | 37 | 38 | 35 | 3 | ✗ | Score (37 → Down) conflicts with aggregator thumbs (Flat) |
| 39 | gutenberg-2023 | New York Stage Review | 49 | 48 | 50 | 2 | ✗ | Score (49 → Down) conflicts with aggregator thumbs (Up) |
| 40 | gutenberg-2023 | Variety | 67 | 68 | 65 | 3 | ✗ | Score (67 → Flat) conflicts with aggregator thumbs (Up) |
| 41 | harmony-2023 | amNewYork | 61 | 62 | 60 | 2 | ✗ | Score (61 → Flat) conflicts with aggregator thumbs (Up) |
| 42 | harmony-2023 | New York Stage Review | 50 | null | 50 | 0 | ✗ | Score (50 → Flat) conflicts with aggregator thumbs (Up) |
| 43 | harmony-2023 | The New York Times | 46 | 42 | 50 | 8 | ✗ | Score (46 → Down) conflicts with aggregator thumbs (Flat) |
| 44 | harmony-2023 | The Wall Street Journal | 50 | 50 | 50 | 0 | ✗ | Score (50 → Flat) conflicts with aggregator thumbs (Down) |
| 45 | hells-kitchen-2024 | New York Stage Review | 79 | 78 | 80 | 2 | ✗ | Score (79 → Up) conflicts with aggregator thumbs (Flat) |
| 46 | hells-kitchen-2024 | Showbiz411 | 74 | 72 | 75 | 3 | ✗ | Score (74 → Up) conflicts with aggregator thumbs (Flat) |
| 47 | hells-kitchen-2024 | The New York Sun | 79 | 78 | 80 | 2 | ✗ | Score (79 → Up) conflicts with aggregator thumbs (Flat) |
| 48 | how-to-dance-in-ohio-2023 | Entertainment Weekly | 67 | 68 | 65 | 3 | ✗ | Score (67 → Flat) conflicts with aggregator thumbs (Up) |
| 49 | just-in-time-2025 | Entertainment Weekly | 64 | 62 | 65 | 3 | ✗ | Score (64 → Flat) conflicts with aggregator thumbs (Up) |
| 50 | just-in-time-2025 | The Guardian | 74 | 72 | 75 | 3 | ✗ | Score (74 → Up) conflicts with aggregator thumbs (Flat) |

*...and 63 more*

---

## Manually Assigned Scores (9)

These reviews have no LLM score and were assigned scores through:
- Manual review of excerpts
- Algorithmic extraction from original ratings/grades
- Sentiment analysis of excerpt text

| # | Show | Outlet | Critic | Score | Source | Excerpt |
|---|------|--------|--------|-------|--------|---------|
| 1 | book-of-mormon-2011 | latimes | Charles McNulty | 35 | extracted-strong-negative | By Charles McNultyTheater Critic Follow March 24, 2011 4:05 PM PT Share via Close extra sharing opti... |
| 2 | gutenberg-2023 | The Wrap | Steve Pond | 78 | manual-excerpt-positive | The show is silly and sweet and completely ridiculous, and Gad and Rannells throw themselves into it... |
| 3 | hadestown-2019 | reviews-off-broadway | Scott Mitchell | 68 | manual-excerpt-mixed | Cast is amazing...darkness descends once more.... |
| 4 | illinoise-2024 | The Washington Post | Gloria Oladipo | 75 | manual-excerpt-positive | "Drury and Peck have crafted something cinematic"... |
| 5 | jajas-african-hair-braiding-2023 | Variety | Maya Phillips | 80 | manual-excerpt-positive | Jocelyn Bioh's play is a warm, observant comedy that finds profound meaning in the everyday rhythms ... |
| 6 | just-for-us-2023 | The Hollywood Reporter | Angie Han | 78 | manual-excerpt-positive | Bliss's gift is his ability to find the funny in the uncomfortable, the relatable in the particular,... |
| 7 | prayer-for-the-french-republic-2024 | TheaterMania | Jesse Green | 78 | manual-excerpt-positive | Joshua Harmon's sprawling family drama about Jewish identity and assimilation in modern France is bo... |
| 8 | prayer-for-the-french-republic-2024 | Variety | Jesse Green | 72 | manual-excerpt-mixed-positive | Joshua Harmon's ambitious family drama about French Jewish identity spans decades and generations, b... |
| 9 | suffs-2024 | Observer | Rex Reed | 82 | manual-excerpt-positive | We noticed you're using an ad blocker. 			We get it: you like to have control of your own internet e... |

---

## Thumb-Based Scores (20)

These reviews have no LLM score and fall back to DTLI/BWW thumb-derived scores:
- **Up** → 78 points
- **Flat/Meh** → 58 points  
- **Down** → 38 points

| # | Show | Outlet | Critic | DTLI Thumb | BWW Thumb | Derived Score | Excerpt |
|---|------|--------|--------|------------|-----------|---------------|---------|
| 1 | an-enemy-of-the-people-2024 | The Wall Street Journal | Charles Isherwood | Up | - | 78 | https://www.wsj.com/articles/an-enemy-of-the-people-review-jeremy-strong-broadwa... |
| 2 | back-to-the-future-2023 | Observer | David Cote | - | Down | 38 | gifted cast with thankless roles and abysmal score; the car is the star... |
| 3 | back-to-the-future-2023 | Time Out New York | Adam Feldman | - | Down | 38 | The show is an efficient crowd-pleaser that hits its marks without transcending ... |
| 4 | doubt-2024 | The Wall Street Journal | Charles Isherwood | Up | Up | 78 | The excellent Broadway revival, directed by Scott Ellis for the Roundabout Theat... |
| 5 | gutenberg-2023 | The Wall Street Journal | Charles Isherwood | Meh | Up | 58 | https://www.wsj.com/articles/gutenberg-the-musical-review-broadway-andrew-rannel... |
| 6 | here-lies-love-2023 | The Wall Street Journal | Charles Isherwood | Up | - | 78 | https://www.wsj.com/articles/here-lies-love-review-david-byrnes-dictator-disco-p... |
| 7 | i-need-that-2023 | Time Out New York | Adam Feldman | Meh | - | 58 | Thanks for subscribing! Look out for your first newsletter in your inbox soon!  ... |
| 8 | i-need-that-2023 | The Wall Street Journal | Charles Isherwood | Up | Up | 78 | https://www.wsj.com/articles/i-need-that-review-danny-devito-theresa-rebeck-lucy... |
| 9 | oedipus-2025 | latimes | Charles McNulty | Up | Up | 78 | By Charles McNultyTheater Critic Follow Nov. 13, 2025 8:59 PM PT 7 min Click her... |
| 10 | oedipus-2025 | The New York Times | Alexis Soloski | Up | - | 78 | Icke’s change in timeline trades catastrophe for suspense, ontological disaster ... |
| 11 | oh-mary-2024 | The Guardian | Adrian Horton | Up | Up | 78 | "This moment, among many others, brought the house down. Oh, Mary! is an uproari... |
| 12 | once-upon-a-one-more-time-2023 | The Wall Street Journal | Charles Isherwood | Meh | - | 58 | The show finds its groove when it stops trying so hard to be clever and lets the... |
| 13 | patriots-2024 | Deadline | Greg Evans | Meh | - | 58 | April on Broadway, to mangle a phrase from a showtune classic, is bustin&#8217; ... |
| 14 | patriots-2024 | The Wall Street Journal | Charles Isherwood | Up | - | 78 | https://www.wsj.com/articles/patriots-review-on-broadway-putin-peter-morgan-russ... |
| 15 | six-2021 | Vulture | Helen Shaw | Up | - | 78 | There is nothing I enjoy more than discovering a show and then going back to see... |
| 16 | stranger-things-2024 | The Stage | Dave Fargnoli | - | Up | 78 | The production has a strikingly cinematic aesthetic that seamlessly integrates v... |
| 17 | the-great-gatsby-2024 | The Guardian | Gloria Oladipo | - | Down | 38 | e production feels too spic and span by the time it ends: Missing is a mess left... |
| 18 | the-notebook-2024 | The Wall Street Journal | Charles Isherwood | Meh | Meh | 58 | This may put me in the minority, given the story’s proven success in other mediu... |
| 19 | the-notebook-2024 | The Wall Street Journal | Charles | MEH | Meh | 58 | This may put me in the minority, given the story’s proven success in other mediu... |
| 20 | the-wiz-2024 | The Stage | Lane Williamson | - | Up | 78 | Now, they’re playing on Broadway for the first time since its original productio... |

---

## Recommendations

1. **Low Confidence (66 reviews):** Consider running these through a more thorough manual review or re-scoring with full text if available.

2. **Needs Review (113 reviews):** These are good candidates for spot-checking, especially where thumb conflicts indicate potential scoring errors.

3. **Manually Assigned (9 reviews):** These are the most reliable non-LLM scores since they were manually verified.

4. **Thumb-Based (20 reviews):** Low fidelity scores. Try to get LLM scores for these if excerpts exist.
