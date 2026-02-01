# Comprehensive Explicit Score Audit

**Generated:** 2026-02-01T05:15:04.428Z

## Overview

- Total reviews: 1692
- With explicit score: 248
- LLM disagreement mean: -4.6 points
- LLM disagreement std dev: 10.3 points
- 2σ threshold: 25.2 points

## Confidence Tiers

| Tier | Description | Count | Action |
|------|-------------|-------|--------|
| A | No flags, LLM agrees | 115 | Skip review |
| B | Minor issues | 75 | Spot-check sample |
| C | Serious flags | 58 | **Full review required** |

## Flagged Reviews by Priority

### Priority 1: Aggregator Conflict (0)
Reviews where DTLI/BWW/ShowScore excerpt contains a different score.


### Priority 2: High LLM Disagreement (3)
Reviews where LLM score differs by >2σ from the mean disagreement.

- **harmony-2023/nysr--sandy-macdonald.json**: explicit=80, LLM=50, diff=-30
- **stranger-things-2024/timeout--adam-feldman.json**: explicit=60, LLM=29, diff=-31
- **the-cottage-2023/nysr--frank-scheck.json**: explicit=60, LLM=28, diff=-32

### Priority 3: Problematic Source (66)
Scores from unreliable extraction methods.

- text-pattern: 35 reviews
- unknown: 30 reviews
- extracted-unicode-stars: 1 reviews

### Priority 4: Conversion Edge Cases (12)
Scores at grade boundaries (B+/B-, 3.5 stars, etc.).


### Other Flags
- Ambiguous scores: 2
- Missing context: 75

## By Outlet (sorted by count)

| Outlet | Count | Avg LLM Diff | Notes |
|--------|-------|--------------|-------|
| nysr | 120 | -2.9 |  |
| timeout | 50 | -2.4 |  |
| ew | 37 | -8.9 |  |
| nypost | 10 | -13.9 | ⚠️ High bias |
| nydailynews | 5 | -13.0 | ⚠️ High bias |
| culturesauce | 5 | 2.0 |  |
| nytg | 4 | -10.0 |  |
| one-minute-critic | 2 | -15.0 | ⚠️ High bias |
| amny | 2 | -3.0 |  |
| jks-theatre-scene | 1 | -14.0 | ⚠️ High bias |
| the-times | 1 | -16.0 | ⚠️ High bias |
| metro-weekly | 1 | 9.0 |  |
| thewrap | 1 | -2.0 |  |
| guardian | 1 | -4.0 |  |
| mashable | 1 | 0.0 |  |

## By Score Source

| Source | Count | Reliability |
|--------|-------|-------------|
| letter-grade | 45 | ⚠️ Medium |
| live-fetch | 42 | ✅ High |
| og-description | 38 | ✅ High |
| text-pattern | 35 | ⚠️ Medium |
| unknown | 30 | ❌ Low |
| unicode-stars | 26 | ❓ Unknown |
| explicit-after-garbage-invalidation | 14 | ❓ Unknown |
| extracted-grade | 8 | ❓ Unknown |
| numeric-stars | 4 | ❓ Unknown |
| extracted-rating | 2 | ❓ Unknown |
| sentiment-positive | 1 | ❓ Unknown |
| sentiment-strong-positive | 1 | ❓ Unknown |
| extracted-strong-positive | 1 | ❓ Unknown |
| extracted-unicode-stars | 1 | ❌ Low |

## Duplicates with Score Conflicts

None found.

## Tier C Reviews (Require Manual Review)


<details><summary>Click to expand 58 reviews</summary>

### an-enemy-of-the-people-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 78 (diff: -2)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/an-enemy-of-the-people-broadway-review-jeremy-strong-michael-imperioli

### and-juliet-2022/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 64 (diff: 4)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/and-juliet-broadway-musical-review-max-martin

### back-to-the-future-2023/nypost--johnny-oleksinski.json
- **Outlet:** New York Post
- **Critic:** Johnny Oleksinki
- **Original Score:** 2 stars
- **Critic Score:** 50
- **LLM Score:** 25 (diff: -25)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://nypost.com/2023/08/03/back-to-the-future-the-musical-review-watch-the-movie-instead/

### back-to-the-future-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 60
- **Critic Score:** 60
- **LLM Score:** 36 (diff: -24)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/back-to-the-future-the-musical

### book-of-mormon-2011/timeout--david-cote.json
- **Outlet:** Time Out New York
- **Critic:** David Cote
- **Original Score:** 100
- **Critic Score:** 100
- **LLM Score:** 94 (diff: -6)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** http://www.timeout.com/newyork/theater/the-book-of-mormon-on-broadway-tickets-reviews-and-video

### bug-2026/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 83 (diff: 3)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/bug-broadway-review-carrie-coon-namir-smallwood-tracy-letts-paranoia

### death-becomes-her-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 84 (diff: 4)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/death-becomes-her-broadway-musical-review

### doubt-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 79 (diff: -1)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/doubt-a-parable-revival-broadway-review-amy-ryan-liev-schreiber

### grey-house-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 60
- **Critic Score:** 60
- **LLM Score:** 57 (diff: -3)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/grey-house

### gutenberg-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 79 (diff: -1)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/gutenberg-the-musical-broadway-review-josh-gad-andrew-rannells

### hadestown-2019/nytg--donna-herman.json
- **Outlet:** New York Theatre Guide
- **Critic:** Donna Herman
- **Original Score:** 4 stars
- **Critic Score:** 100
- **LLM Score:** 86 (diff: -14)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://www.newyorktheatreguide.com/reviews/review-of-hadestown-on-broadway

### hamilton-2015/timeout--david-cote.json
- **Outlet:** Time Out New York
- **Critic:** David Cote
- **Original Score:** 5/5
- **Critic Score:** 100
- **LLM Score:** 95 (diff: -5)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** http://www.timeout.com/newyork/theater/hamilton-1

### harmony-2023/nysr--sandy-macdonald.json
- **Outlet:** New York Stage Review
- **Critic:** Sandy MacDonald
- **Original Score:** 4/5 stars
- **Critic Score:** 80
- **LLM Score:** 50 (diff: -30)
- **Score Source:** unicode-stars
- **Flags:** high_llm_disagreement
- **URL:** https://nystagereview.com/2023/11/13/harmony-superb-singing-marks-barry-manilows-long-delayed-broadway-debut-as-composer/
- **Score Context:** "★★★★☆ A singing sextet in pre-WWII Berlin wows the caba"

### harmony-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 64 (diff: 4)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/harmony-review-broadway-musical-barry-manilow

### hells-kitchen-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 77 (diff: -3)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/hells-kitchen-musical-broadway-review-alicia-keys

### how-to-dance-in-ohio-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 74 (diff: -6)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/how-to-dance-in-ohio-broadway-review-musical-autism

### i-need-that-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 64 (diff: 4)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/i-need-that-broadway-review-danny-devito

### i-need-that-2023/timeout--will-gleason.json
- **Outlet:** Time Out New York
- **Critic:** Will Gleason
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 65 (diff: 5)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/i-need-that-broadway-review-danny-devito

### just-in-time-2025/ew--shania-russell.json
- **Outlet:** Entertainment Weekly
- **Critic:** Shania Russell
- **Original Score:** A-
- **Critic Score:** 92
- **LLM Score:** 64 (diff: -28)
- **Score Source:** letter-grade
- **Flags:** conversion_edge_case, missing_context
- **URL:** https://ew.com/just-in-time-review-jonathan-groff-irresistible-bobby-darin-11721853

### just-in-time-2025/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 88 (diff: 8)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/just-in-time-broadway-review-bobby-darin-jonathan-groff

### liberation-2025/thewrap--emlyn-travis.json
- **Outlet:** TheWrap
- **Critic:** Emlyn Travis
- **Original Score:** B+
- **Critic Score:** 88
- **LLM Score:** 86 (diff: -2)
- **Score Source:** extracted-grade
- **Flags:** conversion_edge_case, missing_context
- **URL:** https://www.thewrap.com/liberation-broadway-review/

### liberation-2025/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 5/5
- **Critic Score:** 100
- **LLM Score:** 77 (diff: -23)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/liberation-broadway-review-bess-wohl-feminism

### mamma-mia-2025/culturesauce--thom-geier.json
- **Outlet:** Culture Sauce
- **Critic:** Thom Geier
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 74 (diff: -6)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://culturesauce.com/2025/08/14/mamma-mia-2025-broadway-review/

### mamma-mia-2025/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 58 (diff: -2)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/mamma-mia-broadway-musical-review-abba

### marjorie-prime-2025/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 82 (diff: 2)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/marjorie-prime-broadway-revival-review-june-squibb-cynthia-nixon-jordan-harrison-danny-burstein-artifical-intelligence-ai

### mary-jane-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 5/5
- **Critic Score:** 100
- **LLM Score:** 84 (diff: -16)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/mary-jane-broadway-play-review-rachel-mcadams-amy-herzog

### maybe-happy-ending-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 5/5
- **Critic Score:** 100
- **LLM Score:** 88 (diff: -12)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/maybe-happy-ending-broadway-musical-review-darren-criss-helen-shen-robots

### merrily-we-roll-along-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 80
- **Critic Score:** 80
- **LLM Score:** 89 (diff: 9)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/merrily-we-roll-along-broadway-review-revival-sondheim-groff-radcliffe-mendez

### mother-play-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 79 (diff: -1)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/mother-play-five-evictions-broadway-review-jessica-lange-paula-vogel

### moulin-rouge-2019/ew--leah-greenblatt.json
- **Outlet:** Entertainment Weekly
- **Critic:** Leah Greenblatt
- **Original Score:** B+
- **Critic Score:** 88
- **LLM Score:** 79 (diff: -9)
- **Score Source:** unknown
- **Flags:** conversion_edge_case, problematic_source, missing_context
- **URL:** https://ew.com/moulin-rouge-broadway-review/

### moulin-rouge-2019/guardian--alexis-soloski.json
- **Outlet:** The Guardian
- **Critic:** Alexis Soloski
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 56 (diff: -4)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://www.theguardian.com/stage/2019/jul/25/moulin-rouge-broadway-review

### moulin-rouge-2019/mashable--erin-strecker.json
- **Outlet:** Mashable
- **Critic:** Erin Strecker
- **Original Score:** Positive
- **Critic Score:** null
- **LLM Score:** 85 (diff: N/A)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://mashable.com/article/moulin-rouge-broadway-review/

### moulin-rouge-2019/nydailynews--chris-jones.json
- **Outlet:** New York Daily News
- **Critic:** Chris Jones
- **Original Score:** Sentiment: Mixed
- **Critic Score:** null
- **LLM Score:** 83 (diff: N/A)
- **Score Source:** unknown
- **Flags:** problematic_source, ambiguous_score, missing_context
- **URL:** https://www.nydailynews.com/entertainment/broadway/ny-chris-jones-review-moulin-rouge-20190726-sorvpzfoyfc7pjxzcl5ema7pku-story.html

### moulin-rouge-2019/observer--david-cote.json
- **Outlet:** Observer
- **Critic:** David Cote
- **Original Score:** Mixed
- **Critic Score:** null
- **LLM Score:** 64 (diff: N/A)
- **Score Source:** unknown
- **Flags:** problematic_source, ambiguous_score
- **URL:** https://observer.com/2019/08/moulin-rouge-the-musical-kitsch-glitz-review-broadway/
- **Score Context:** "ghteen years later, with the property retooled, remixed and relocated to Broadway, how culturally relevan"

### moulin-rouge-2019/telegraph--diane-snyder.json
- **Outlet:** The Telegraph
- **Critic:** Diane Snyder
- **Original Score:** Sentiment: Positive
- **Critic Score:** null
- **LLM Score:** 60 (diff: N/A)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://www.telegraph.co.uk/theatre/what-to-see/moulin-rouge-musical-al-hirschfeld-theatre-new-york-review-exactly/

### moulin-rouge-2019/variety--marilyn-stasio.json
- **Outlet:** Variety
- **Critic:** Marilyn Stasio
- **Original Score:** Positive
- **Critic Score:** null
- **LLM Score:** 82 (diff: N/A)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://variety.com/2019/music/reviews/moulin-rouge-review-broadway-musical-2-1203278036/

### oedipus-2025/culturesauce--thom-geier.json
- **Outlet:** Culture Sauce
- **Critic:** Thom Geier
- **Original Score:** 5/5
- **Critic Score:** 100
- **LLM Score:** 96 (diff: -4)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://culturesauce.com/2025/11/13/oedipus-lesley-manville-mark-strong-broadway-review/

### oh-mary-2024/ew--christian-holub.json
- **Outlet:** Entertainment Weekly
- **Critic:** Christian Holub
- **Original Score:** A-
- **Critic Score:** 92
- **LLM Score:** 88 (diff: -4)
- **Score Source:** explicit-after-garbage-invalidation
- **Flags:** conversion_edge_case, missing_context
- **URL:** https://ew.com/oh-mary-broadway-review-cole-escola/

### oh-mary-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 5/5
- **Critic Score:** 100
- **LLM Score:** 94 (diff: -6)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/oh-mary-broadway-review-cole-escola

### once-upon-a-one-more-time-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 65 (diff: 5)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/once-upon-a-one-more-time-broadway-musical-review-britney-spears

### our-town-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 78 (diff: -2)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/our-town-broadway-review-thornton-wilder-jim-parsons

### patriots-2024/timeout--raven-snook.json
- **Outlet:** Time Out New York
- **Critic:** Raven Snook
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 63 (diff: 3)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/patriots-review-broadway-play-michael-stuhlbarg-russia-putin

### prayer-for-the-french-republic-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 59 (diff: -1)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/prayer-for-the-french-republic-broadway-review

### purlie-victorious-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 79 (diff: -1)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/purlie-victorious-broadway-review-ossie-davis-leslie-odom-kara-young

### queen-versailles-2025/culturesauce--thom-geier.json
- **Outlet:** Culture Sauce
- **Critic:** Thom Geier
- **Original Score:** 1/5
- **Critic Score:** 20
- **LLM Score:** 39 (diff: 19)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://culturesauce.com/2025/11/09/kristin-chenoweth-queen-of-versailles-broadway-review/

### ragtime-2025/culturesauce--thom-geier.json
- **Outlet:** Culture Sauce
- **Critic:** Thom Geier
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 84 (diff: 4)
- **Score Source:** unknown
- **Flags:** problematic_source, missing_context
- **URL:** https://culturesauce.com/2025/10/16/ragtime-musical-broadway-review/

### ragtime-2025/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 93 (diff: 13)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/ragtime-broadway-revival-review-lincoln-center-doctorow-joshua-henry

### real-women-have-curves-2025/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 81 (diff: 1)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/real-women-have-curves-the-musical-broadway-review

### spamalot-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 82 (diff: 2)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/spamalot-review-broadway-musical-revival-monty-python

### stereophonic-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 5/5
- **Critic Score:** 100
- **LLM Score:** 89 (diff: -11)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/stereophonic-broadway-play-review-david-adjmi-will-butler

### stranger-things-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 29 (diff: -31)
- **Score Source:** text-pattern
- **Flags:** high_llm_disagreement, problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/stranger-things-the-first-shadow-broadway-review-prequel-louis-mccartney

### suffs-2024/timeout--regina-robbins.json
- **Outlet:** Time Out New York
- **Critic:** Regina Robbins
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 70 (diff: -10)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/suffs-broadway-musical-review-shaina-taub

### the-cottage-2023/nysr--frank-scheck.json
- **Outlet:** New York Stage Review
- **Critic:** Frank Scheck
- **Original Score:** 3/5 stars
- **Critic Score:** 60
- **LLM Score:** 28 (diff: -32)
- **Score Source:** og-description
- **Flags:** high_llm_disagreement
- **URL:** https://nystagereview.com/2023/07/24/the-cottage-a-new-sex-farce-that-already-feels-dated/
- **Score Context:** "★★★☆☆ Listen, I enjoy the plays of Noel Coward as much"

### the-great-gatsby-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 65 (diff: 5)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/the-great-gatsby-musical-broadway-review-jeremy-jordan-eva-noblezada

### the-roommate-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 85 (diff: 5)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/the-roommate-broadway-review-mia-farrow-patti-lupone

### the-shark-is-broken-2023/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 3/5
- **Critic Score:** 60
- **LLM Score:** 66 (diff: 6)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/the-shark-is-broken-broadway-review-jaws-play

### the-whos-tommy-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 59 (diff: -21)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/the-whos-tommy-broadway-musical-review-revival-pete-townshend

### water-for-elephants-2024/timeout--adam-feldman.json
- **Outlet:** Time Out New York
- **Critic:** Adam Feldman
- **Original Score:** 4/5
- **Critic Score:** 80
- **LLM Score:** 79 (diff: -1)
- **Score Source:** text-pattern
- **Flags:** problematic_source, missing_context
- **URL:** https://www.timeout.com/newyork/theater/water-for-elephants-broadway-musical-review-circus

</details>


## Recommended Actions

1. **Manually verify all 58 Tier C reviews** - these have serious flags
2. **Spot-check 20 random Tier B reviews** - verify the 'minor issues' are truly minor
3. **Investigate outlets with high LLM bias** - systematic errors may indicate extraction bugs
4. **Remove or fix reviews with aggregator conflicts** - clear evidence of wrong score