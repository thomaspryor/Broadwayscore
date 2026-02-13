# Broadway Scorecard — Soft Launch Playbook

Everything below is copy-paste ready. No coding, no terminal commands. Just copy, paste, post/send.

---

## BEFORE YOU START: The Warm-Up (Weeks 1-3)

**Why:** A brand-new Reddit account posting data analyses with links gets auto-flagged as spam. You need a comment history first.

**What to do:** For 3 weeks before your first post, spend ~10 minutes a day on r/Broadway:
- Reply to "what should I see?" threads with genuine opinions
- React to Tony news, show closings, casting announcements
- Upvote and comment on other people's posts
- **Never** mention broadwayscorecard.com during this period

**While you warm up,** I'll handle Phase 1 (backlinks) by submitting to directories and sending the university emails.

---

## PHASE 1: QUIET BACKLINKS (Weeks 1-3, While Warming Up Reddit)

These go out before any Reddit posts. I can send many of these for you via GitHub Actions or you can copy-paste from your phone.

### Email 1: NYU Tisch School of the Arts

**To:** Find the contact on https://tisch.nyu.edu/drama — usually an admin or department coordinator

**Subject:** Free Broadway review database for student research

**Body:**
```
Hi there,

I maintain Broadway Scorecard (broadwayscorecard.com), a free research database
covering 11,400 professional Broadway reviews across 685 shows and 20 seasons.

It includes data that's hard to find elsewhere:
- Critic reviews from 490 outlets with transparent scoring methodology
- Commercial/recoupment tracking for 120+ shows
- Weekly box office and audience sentiment data

I thought it might be a useful resource for your drama students, particularly
those studying Broadway economics or criticism. Would you consider adding it
to your department's resource page?

Happy to answer any questions.

Best,
Tom Pryor
broadwayscorecard.com
```

### Email 2: Columbia University School of the Arts

*(Same body as above, change greeting to target their theater department)*

### Email 3: Yale School of Drama

*(Same body, target their dramaturgy program)*

### Email 4: Broadway.org

**To:** Contact form or info@ address on Broadway.org

**Subject:** Resource submission — Broadway review aggregator

**Body:**
```
Hi,

I'd like to suggest broadwayscorecard.com for your resources section.
It's a free, independent review aggregator tracking 11,400 critic reviews
across 657 Broadway shows from the last 20 seasons, with transparent
scoring methodology.

The site also includes weekly box office data, audience sentiment, and
commercial performance tracking.

Let me know if you need any additional information.

Best,
Tom Pryor
```

---

## PHASE 2: REDDIT POSTS (Weeks 4-12)

Post one every 5-7 days. Each post below is complete — just copy the title and body into Reddit.

**Important rules:**
- Use the "Discussion" flair
- Reply to every comment (especially disagreements — that's engagement)
- If a post gets removed by mods, repost without the link. Put the link in a reply comment instead.
- Best posting times: Sunday 6-8 PM EST or Monday 8-10 AM EST

---

### POST 1: Season Rankings

**Title:** `I analyzed 11,400 Broadway reviews from the last 20 seasons. Here's how each season stacks up.`

**Body:**
```
I've been building a database of professional Broadway reviews — currently
11,400+ reviews across 685 shows from 490 outlets and 924 critics (NYT,
Vulture, Variety, Post, TheaterMania, Hollywood Reporter, and hundreds more).

I scored each review on a 0-100 scale using a mix of explicit critic ratings
(star ratings, letter grades) and AI-assisted interpretation of review text
when no explicit rating was given. Then I averaged by season.

Here's what the data shows:

| Season | Shows | Reviews | Avg Score |
|--------|-------|---------|-----------|
| 2019-2020 | 17 | 279 | 73.4 |
| 2016-2017 | 39 | 938 | 72.9 |
| 2022-2023 | 39 | 982 | 72.7 |
| 2017-2018 | 31 | 741 | 72.6 |
| 2024-2025 | 42 | 961 | 71.7 |
| 2021-2022 | 36 | 691 | 71.5 |
| 2018-2019 | 34 | 876 | 71.4 |
| 2015-2016 | 36 | 966 | 71.4 |
| 2023-2024 | 37 | 1,019 | 71.2 |
| 2013-2014 | 41 | 580 | 70.7 |
| 2014-2015 | 35 | 645 | 70.0 |
| 2007-2008 | 30 | 183 | 69.4 |
| 2009-2010 | 37 | 360 | 69.0 |
| 2010-2011 | 38 | 472 | 67.0 |
| 2008-2009 | 33 | 243 | 66.4 |
| 2005-2006 | 31 | 74 | 66.1 |
| 2012-2013 | 39 | 430 | 65.2 |
| 2011-2012 | 37 | 411 | 64.7 |

**The best-reviewed season: 2019-2020** (73.4 avg) — and it was cut
short by COVID. Only 17 shows had time to open, but they were strong:
The Inheritance, A Soldier's Play, The Sound Inside, Jagged Little Pill,
and the Moulin Rouge! opening.

**The worst: 2011-2012** (64.7). Relatively Speaking, Lysistrata Jones,
Ghost the Musical, Leap of Faith, and Magic/Bird all opened that season.
2012-2013 is close behind at 65.2.

The current season (2024-2025) is sitting at 71.7 with 42 shows —
comfortably in the top third.

Some interesting patterns:
- The late 2010s were genuinely a golden stretch: 2016-2017 through
  2019-2020 are the top 4 seasons
- 2019-2020 being #1 is partly COVID survivor bias — the weaker spring
  shows never had a chance to open and drag the average down
- There's a clear quality cliff around 2010-2013: four of the five
  worst seasons are consecutive
- 2022-2023 at #3 surprised me — that's the season of Leopoldstadt,
  Sweeney Todd revival, and Kimberly Akimbo

Methodology note: scores are aggregated from published reviews. Where
critics gave explicit ratings (stars, letter grades), those are used
directly. For reviews without explicit ratings, scores are derived from
review text using an AI scoring model.
Full methodology at broadwayscorecard.com/methodology

What surprises you? Does the ranking match your gut feeling about
which seasons were strongest?
```

---

### POST 2: Outlet Rankings (Toughest vs Most Generous)

**Title:** `Which Broadway outlets are the toughest graders? I looked at 11,400 reviews to find out.`

**Body:**
```
Using the same database of 11,400+ Broadway reviews from 490 outlets, I
looked at which outlets consistently grade shows the highest and lowest.

(Important caveat: this doesn't mean "best" or "worst" — harsh outlets
might just have higher standards, and generous outlets might focus on
shows their audience will enjoy.)

**The toughest outlets** (50+ reviews minimum):

| Outlet | Reviews | Avg Score |
|--------|---------|-----------|
| Bloomberg | 62 | 64.0 |
| amNewYork | 182 | 64.1 |
| TheWrap | 310 | 65.2 |
| Lighting & Sound America | 109 | 66.3 |
| New York Post | 437 | 66.9 |
| Time Out New York | 439 | 67.3 |
| Vulture | 371 | 67.6 |

**The most generous outlets:**

| Outlet | Reviews | Avg Score |
|--------|---------|-----------|
| TheaterMania | 319 | 74.6 |
| New York Stage Review | 438 | 74.1 |
| Deadline | 274 | 73.9 |
| USA Today | 190 | 73.3 |
| Variety | 617 | 72.3 |

**The papers of record cluster in between:**

| Outlet | Reviews | Avg Score |
|--------|---------|-----------|
| The Wall Street Journal | 328 | 68.2 |
| The New York Times | 568 | 69.4 |
| The Guardian | 210 | 70.3 |
| The Washington Post | 252 | 70.7 |
| The Hollywood Reporter | 391 | 70.9 |

Some things that jumped out:
- The NYT and NY Post are both on the tough end — the two biggest NYC
  papers are also the hardest to please
- There's a 10.6-point gap between Bloomberg (64.0) and TheaterMania
  (74.6). That might not sound like much, but it's the difference
  between a B- and a C.
- NYC-based publications (Post, amNewYork, Time Out, Vulture) cluster
  toughest. Theater specialty outlets (TheaterMania, NYSR, BWW) are
  the most generous. The big nationals (NYT, WSJ, WaPo) land between.
- The New Yorker (69.1, 116 reviews) is in the tough camp too — not
  surprising.
- Variety (72.3, 617 reviews) is the most generous of the "big name"
  outlets — and the most prolific.

Methodology: same as my previous post — mix of explicit critic ratings
and AI-assisted scoring from review text.
broadwayscorecard.com/methodology for the full breakdown.

Does this match your experience reading these outlets?
```

---

### POST 3: Most Polarizing Shows

**Title:** `The most polarizing Broadway shows of the last 20 years — where critics were most split`

**Body:**
```
Some shows get universal acclaim. Others divide critics completely.
I measured "polarization" as the spread between the highest and lowest
review score for each show (minimum 10 reviews).

**The most divisive shows:**

| Show | Spread | Low | High | Reviews | Avg |
|------|--------|-----|------|---------|-----|
| Just in Time | 95 pts | 0 | 95 | 27 | 75.3 |
| Gary: A Sequel to Titus Andronicus | 88 pts | 12 | 100 | 46 | 66.4 |
| Almost Famous | 82 pts | 18 | 100 | 40 | 61.4 |
| Water for Elephants | 82 pts | 12 | 94 | 21 | 70.3 |
| Moulin Rouge! | 81 pts | 19 | 100 | 37 | 72.0 |
| The Lion King | 80 pts | 20 | 100 | 21 | 79.0 |
| Be More Chill | 79 pts | 14 | 93 | 47 | 66.4 |
| Carousel (2018 revival) | 79 pts | 21 | 100 | 61 | 71.5 |
| Wicked | 77 pts | 15 | 92 | 27 | 71.3 |

For comparison, Hamilton had a 38-point spread (62-100, avg 89.5) — even
the harshest critic still gave it a B-.

What stands out:
- **Just in Time** is currently the most polarizing show on Broadway.
  One critic gave it a literal zero. Others gave it a 95. That's as
  split as it gets.
- **Gary** (Nathan Lane, 2019) had both a perfect 100 and a 12 — across
  46 reviews. Critics could not agree on this one at all.
- **Spectacle musicals dominate.** Moulin Rouge, Water for Elephants,
  Almost Famous — critics either love the spectacle or find it hollow.
- **Wicked** at 77-point spread is wild. It's a beloved cultural
  phenomenon, but some critics absolutely hated it (15/100) while
  others were ecstatic (92/100).
- **The Lion King** has a bigger spread than Wicked — a 100 AND a 20.
  But the average (79) shows most critics loved it.
- **Be More Chill** is the internet fandom effect in data form: 47
  reviews, massive range, below-average score.

Data from broadwayscorecard.com — 11,400+ reviews across 685 shows.

What show's polarization surprises you the most?
```

---

### POST 4: Critic vs Audience Disagreements

**Title:** `The biggest critic/audience disagreements on Broadway, according to data`

**Body:**
```
I combined critic review scores with audience data from ShowScore,
Mezzanine, and Reddit sentiment analysis. Here's where they disagree
the most.

**Shows audiences love more than critics:**

| Show | Critic Avg | Audience Score | Gap |
|------|-----------|----------------|-----|
| Godspell (2011) | 58 | 84 | +26 |
| Porgy and Bess (2012) | 60 | 85 | +25 |
| A Night with Janis Joplin | 66 | 89 | +23 |
| The Kite Runner | 59 | 82 | +23 |
| Motown the Musical | 63 | 85 | +22 |
| Wicked | 71 | 93 | +22 |
| The Parisian Woman | 48 | 70 | +22 |
| The Addams Family | 49 | 70 | +22 |

**Shows critics love more than audiences:**

| Show | Critic Avg | Audience Score | Gap |
|------|-----------|----------------|-----|
| The Assembled Parties | 77 | 61 | -16 |
| Old Times | 71 | 60 | -11 |
| The Encounter | 80 | 72 | -8 |
| Yellow Face | 82 | 74 | -8 |
| The Band's Visit | 90 | 82 | -8 |

The asymmetry here is the real story:
- **Audiences disagree with critics WAY more when they love a show.**
  The biggest "audience loves it" gap is +26 points. The biggest
  "critics love it" gap is only -16 points. Audiences are much more
  likely to embrace a show critics dismiss than vice versa.
- **IP and nostalgia drive the biggest gaps.** Motown, Godspell, The
  Kite Runner, The Addams Family — audiences show up for the brand.
  Critics judge the adaptation.
- **Wicked** is fascinating: critics gave it a 71 (solid but not
  spectacular) while audiences gave it a 93 based on 33,000+ ratings.
  That 22-point gap across that volume of audience data is remarkable.
- **The Band's Visit** is the inverse: critics gave it the highest
  score in the database (tied with Hamilton at 89.5) but audiences
  just thought it was "good" at 82. Still positive, just not the
  rapture critics felt.

Critic scores from broadwayscorecard.com. Audience scores from ShowScore
+ Mezzanine + Reddit sentiment combined.

Which side do you usually agree with — critics or audiences?
```

---

### POST 5: Plays vs Musicals

**Title:** `Do Broadway critics grade plays and musicals differently? Here's what 11,400 reviews say.`

**Body:**
```
Quick one. I was curious whether critics are systematically tougher or
easier on one form vs the other.

**Plays:** 71.4 average (5,809 reviews across 393 shows)
**Musicals:** 70.2 average (5,637 reviews across 292 shows)

So plays edge out musicals by 1.2 points. Not a huge gap. But the
interesting difference is in the **extremes:**

**Highest-scoring musicals:**
- Hamilton (89.5), The Band's Visit (89.5), She Loves Me (85.8),
  Maybe Happy Ending (85.5)

**Lowest-scoring musicals:**
- Doctor Zhivago (42.5), Diana (43.6), Bad Cinderella (44.3),
  Scandalous (45.1)

**Highest-scoring plays:**
- What the Constitution Means to Me (87.0), The Ferryman (86.3),
  Three Tall Women (86.3), Jitney (86.1)

**Lowest-scoring plays:**
- Relatively Speaking (42.0), High (42.4), Breakfast at Tiffany's
  (44.9), Dead Accounts (46.4)

The floors are almost identical (42.0 vs 42.5), but the ceilings are
different: the best musicals hit 89.5, while the best plays top out
around 87. Counterintuitive — you'd expect plays to win on artistry.

My theory: the best musicals (Hamilton, Band's Visit) achieve a kind of
unanimous enthusiasm that's hard to replicate in straight plays. When a
musical truly works on every level — book, score, staging, performance
— even the toughest critics can't resist. Plays inspire more
"I appreciate this but it's not for me" reactions.

The bottom end tells a different story: the worst musicals (Doctor
Zhivago, Diana, Bad Cinderella) are all IP adaptations or jukebox
concepts. The worst plays are star vehicles that didn't work (Al Pacino
in China Doll, Uma Thurman in The Parisian Woman).

Data: broadwayscorecard.com

What's your take — should musicals and plays even be scored on the same
scale?
```

---

### POST 6: Best-Reviewed Shows

**Title:** `The 15 best-reviewed Broadway shows of the last 20 years, by the numbers`

**Body:**
```
Based on 11,400+ reviews from 490 outlets. Minimum 8 reviews per show.

| Rank | Show | Year | Type | Avg Score | Reviews |
|------|------|------|------|-----------|---------|
| 1 | Hamilton | 2015 | Musical | 89.5 | 44 |
| 1 | The Band's Visit | 2017 | Musical | 89.5 | 22 |
| 3 | What the Constitution Means to Me | 2019 | Play | 87.0 | 8 |
| 4 | The Ferryman | 2018 | Play | 86.3 | 17 |
| 5 | Three Tall Women | 2018 | Play | 86.3 | 9 |
| 6 | Jitney | 2017 | Play | 86.1 | 18 |
| 7 | Sunday in the Park with George | 2017 | Musical | 86.0 | 8 |
| 8 | She Loves Me | 2016 | Musical | 85.8 | 20 |
| 9 | Maybe Happy Ending | 2024 | Musical | 85.5 | 25 |
| 10 | The Humans | 2016 | Play | 85.5 | 14 |
| 11 | The Color Purple | 2015 | Musical | 85.4 | 17 |
| 12 | Angels in America | 2018 | Play | 84.8 | 69 |
| 13 | A Strange Loop | 2022 | Musical | 84.7 | 33 |
| 14 | Kimberly Akimbo | 2022 | Musical | 84.5 | 28 |
| 15 | Merrily We Roll Along | 2023 | Musical | 84.0 | 30 |

Things that stand out:
- **Hamilton and The Band's Visit are tied at #1** (89.5). Hamilton has
  TWICE as many reviews (44 vs 22) and still matches Band's Visit's
  average. That consistency across that many critics is remarkable.
- **Maybe Happy Ending (2024) at #9.** The newest show on the list,
  still running. 25 critics, 85.5 average. That's a strong debut.
- **Angels in America has the most reviews of any top-15 show** (69!)
  and still averaged 84.8. When you have that many critics agreeing,
  the signal is very strong.
- **2016-2018 dominates.** 7 of the top 15 opened in that window:
  She Loves Me, The Humans, Jitney, The Band's Visit, The Ferryman,
  Three Tall Women, Angels in America.
- **Plays and musicals are evenly split** — 7 plays, 8 musicals.

Full data at broadwayscorecard.com

What would be on YOUR top 15 that critics missed?
```

---

### POST 7: Worst-Reviewed Shows

**Title:** `The 15 worst-reviewed Broadway shows of the last 20 years (sorry)`

**Body:**
```
The flip side of my best-reviewed post. Minimum 8 reviews per show.

| Rank | Show | Year | Type | Avg Score | Reviews |
|------|------|------|------|-----------|---------|
| 1 | Relatively Speaking | 2011 | Play | 42.0 | 9 |
| 2 | High | 2011 | Play | 42.4 | 12 |
| 3 | Doctor Zhivago | 2015 | Musical | 42.5 | 22 |
| 4 | Diana, The Musical | 2021 | Musical | 43.6 | 26 |
| 5 | Bad Cinderella | 2023 | Musical | 44.3 | 28 |
| 6 | Breakfast at Tiffany's | 2013 | Play | 44.9 | 18 |
| 7 | Scandalous | 2012 | Musical | 45.1 | 8 |
| 8 | Dead Accounts | 2012 | Play | 46.4 | 14 |
| 9 | Bronx Bombers | 2014 | Play | 46.5 | 13 |
| 10 | China Doll | 2015 | Play | 47.4 | 39 |
| 11 | The Parisian Woman | 2017 | Play | 47.9 | 16 |
| 12 | Baby It's You! | 2011 | Musical | 48.5 | 16 |
| 13 | The Addams Family | 2010 | Musical | 48.5 | 11 |
| 14 | Macbeth (2022) | 2022 | Play | 49.1 | 16 |
| 15 | The Queen of Versailles | 2025 | Musical | 52.0 | 25 |

Observations:
- **Diana and Bad Cinderella** have 25+ reviews each and still average
  under 45. That means a LOT of critics all independently said "nope."
  Bad Cinderella has the most reviews (28) of any bottom-5 show.
- **China Doll** (Al Pacino) has 39 reviews at 47.4 — the most-reviewed
  show on the worst list. Star power creates interest but can't save
  bad material.
- **2010-2013 was brutal.** 7 of the bottom 15 opened in that window.
  That tracks with the season rankings: 2011-2012 and 2012-2013 were
  the two worst-reviewed seasons overall.
- **The Sam Gold Macbeth** (Daniel Craig, Ruth Negga) at #14 was one
  of the most anticipated productions of 2022 and one of the biggest
  critical disappointments.
- **Queen of Versailles** is the only current (2025) show on the list.

Data: broadwayscorecard.com

What's missing from this list that you think deserves to be here?
```

---

### POST 8: How the NYT's Criticism Evolved

**Title:** `How Broadway criticism changed when the NYT switched lead critics: Brantley vs Green, by the numbers`

**Body:**
```
The New York Times is the single most influential Broadway outlet — 568
reviews in my database. But the paper's perspective shifted when Jesse
Green succeeded Ben Brantley as co-chief critic.

**By the numbers:**
- **Ben Brantley** (NYT): 294 reviews, average score 67.9
- **Jesse Green** (NYT): 122 reviews, average score 71.5

Green's NYT reviews average 3.6 points higher than Brantley's. That
might not sound like a lot, but it can mean the difference between a
show landing in "mixed" vs "positive" territory.

What's really interesting is Green's split across outlets:
- At the NYT: 71.5 avg (122 reviews)
- At Vulture: 68.9 avg (174 reviews)
- At TheaterMania: 74.2 avg (53 reviews)

Same critic, three platforms, three different score profiles. His
Vulture reviews were notably tougher than his NYT reviews. His
TheaterMania reviews were the most generous of all. The institution
shapes the critic as much as the critic shapes the institution.

**The institutional question:** When the paper of record's lead critic
shifts 3.6 points in one direction, does that meaningfully change which
shows succeed? The NYT is the outlet producers fear most. A 3.6-point
shift across 100+ shows — that's the difference between a 69 ("mixed")
and a 73 ("generally positive") in how the industry reads it.

And if Green scores differently at different outlets, what does
"objectivity" even mean in criticism? Is he a 68.9 critic (Vulture),
a 71.5 critic (NYT), or a 74.2 critic (TheaterMania)?

Note: Scores are derived from review text using a mix of explicit
ratings and AI-assisted interpretation. These are approximations, not
numbers the critics assigned themselves.

Data: broadwayscorecard.com

Do you notice a difference in how the NYT covers Broadway now vs the
Brantley era?
```

---

## PHASE 3: OUTREACH EMAILS (Start Week 6, After 2+ Posts Land Well)

Only send these after at least 2 Reddit posts have gotten positive reception (30+ upvotes, no mod removal). Include a link to your best-performing post as social proof.

---

### Email: Howard Sherman

**To:** Find via howardsherman.net contact page

**Subject:** Broadway data transparency — thought you'd find this interesting

**Body:**
```
Hi Howard,

I've been building Broadway Scorecard (broadwayscorecard.com), a free
review aggregator that makes Broadway's critical reception and financial
data publicly accessible.

What might interest you specifically: we track recoupment data for
120+ shows (capitalization, weekly running costs, weeks to recoup) —
information that's usually only available to insiders.

I've been sharing data analyses on r/Broadway and the community
response has been positive:
[LINK TO YOUR BEST REDDIT POST]

Given your writing about transparency and access in theater, I thought
you might find it worth a look.

Happy to answer any questions or share data for a piece.

Best,
Tom
```

---

### Email: Ken Davenport

**To:** Via producerabroadway.com contact

**Subject:** Broadway recoupment tracker — data for your readers

**Body:**
```
Hi Ken,

I built a free Broadway recoupment tracker at broadwayscorecard.com/biz
that covers 120+ shows — capitalization, weekly running costs, estimated
recoupment percentage, and weeks to recoup.

As someone who's written extensively about the business side of Broadway,
I thought your readers might find the data useful. Some interesting
findings:

- [INSERT A SPECIFIC DATA POINT FROM YOUR /BIZ DATA, e.g.,
  "The average musical this season is running at X% of capacity"]

I've been sharing analyses on r/Broadway with good reception:
[LINK TO BEST POST]

Would love to contribute a guest post or data for your blog if you're
interested — something like "How quickly do Broadway shows recoup,
by the numbers."

Best,
Tom
```

---

### Email: Broadway Briefing

**To:** Via broadwaybriefing.com contact/subscribe page

**Subject:** Tool for your readers — free Broadway review + box office database

**Body:**
```
Hi there,

I run Broadway Scorecard (broadwayscorecard.com), a free database of
11,400 Broadway reviews across 685 shows, plus box office data, audience
buzz, and commercial performance tracking.

Thought it might be worth a mention in the newsletter as a research
tool for your industry readership. Some highlights:

- Reviews from 490 outlets with transparent scoring methodology
- Weekly box office with WoW and YoY comparisons
- Recoupment tracking for 120+ shows
- Audience sentiment combining ShowScore, Mezzanine, and Reddit data

I've been sharing data analyses on r/Broadway:
[LINK TO BEST POST]

Happy to provide any additional context.

Best,
Tom
```

---

### Email: Chris Peterson (OnStage Blog)

**Subject:** Data-driven Broadway analysis — guest post idea

**Body:**
```
Hi Chris,

I've been building a Broadway review aggregator (broadwayscorecard.com)
and sharing data analyses on r/Broadway that have gotten good traction:
[LINK TO BEST POST]

Would you be interested in a guest post? I'm thinking something like
"The Most Polarizing Broadway Shows of the Decade, By the Numbers" or
"Which Broadway Outlet Is the Toughest Grader?" — data-driven pieces
with tables and analysis your readers would enjoy.

The data is all free and open — 11,400 reviews, 685 shows, 20 seasons.

Let me know if any angle interests you.

Best,
Tom
```

---

### Follow-Up Email (Send 7 Days After No Response)

**Subject:** `Re: [original subject]`

**Body:**
```
Hi [Name],

Just bumping this in case it got buried. Happy to answer any questions
about the data or adjust the angle to better fit your audience.

Best,
Tom
```

---

## TRACKING (Simple Spreadsheet)

Create a Google Sheet with two tabs:

**Tab 1: Reddit Posts**

| Post # | Title | Date Posted | Upvotes | Comments | Removed? | Notes |
|--------|-------|-------------|---------|----------|----------|-------|
| 1 | Season rankings | | | | | |
| 2 | Outlet rankings | | | | | |
| 3 | Polarizing shows | | | | | |
| ... | | | | | | |

**Tab 2: Outreach**

| Contact | Email Sent | Date | Response? | Backlink? | Follow-Up Sent | Notes |
|---------|-----------|------|-----------|-----------|----------------|-------|
| NYU Tisch | | | | | | |
| Columbia | | | | | | |
| Howard Sherman | | | | | | |
| Ken Davenport | | | | | | |
| Broadway Briefing | | | | | | |
| Chris Peterson | | | | | | |

---

## QUICK REFERENCE: WHAT TO DO EACH WEEK

| Week | Reddit | Outreach | Notes |
|------|--------|----------|-------|
| 1-3 | Comment on r/Broadway daily (no links, no posts) | Send university emails + Broadway.org | Building credibility |
| 4 | **Post #1** (Season rankings) | Create Twitter @BwayScorecard | First real post |
| 5 | **Post #2** (Outlet rankings) | — | Let posts breathe |
| 6 | **Post #3** (Polarizing shows) | Send Howard Sherman + Ken Davenport emails | Start outreach |
| 7 | **Post #4** (Critic vs audience) | Send Broadway Briefing + Chris Peterson | |
| 8 | **Post #5** (Plays vs musicals) | Follow up on unanswered emails | |
| 9 | **Post #6** (Best-reviewed) | — | |
| 10 | **Post #7** (Worst-reviewed) | Pitch podcast appearance | |
| 11 | **Post #8** (NYT evolution) | — | |
| 12+ | New analyses from future topics list | Continue as needed | |

---

## IF THINGS GO WRONG

**Post gets removed by mods:**
Repost without the broadwayscorecard.com link. Put data in the post body. If anyone asks "where's this data from?" reply with the link in comments.

**Someone challenges the data accuracy:**
Reply honestly: "Good question — about 70% of the scores are AI-derived from review text, not explicit critic ratings. For reviews with star ratings or letter grades, those are used directly. Full methodology is published at broadwayscorecard.com/methodology. If you spot something that looks off, I'd genuinely appreciate the feedback."

**A critic responds negatively:**
Don't argue. Reply: "Fair point — these are approximations based on published review text, not scores the critics assigned. I appreciate the feedback and I'm always working to improve accuracy."

**Post gets zero traction:**
Don't panic. Try a different angle next time. The "worst-reviewed" and "polarizing" posts tend to generate the most debate. Listicles and rankings get more engagement than pure analysis.

---

## SEO STRATEGY (Added Feb 2026)

### Current State (Feb 6, 2026)
- **12.1k impressions / 19 clicks / 0.2% CTR** (7-day average)
- **Average position: 10.7** (bottom of page 1 / top of page 2)
- Brand search "broadwayscorecard" returns golf courses, not the site
- No rich snippets (star ratings) appearing despite structured data
- Competitors (Show-Score, DTLI, BroadwayWorld, Broadway.com) have 10-20 years of domain authority

### Technical SEO (Done -- Shipped Feb 2026)
These are already live on the site:
- [x] Comprehensive JSON-LD structured data (TheaterEvent, AggregateRating, Review, FAQ, Breadcrumb, ItemList)
- [x] Dynamic meta titles/descriptions on all 738 show pages
- [x] Sitemap with 800+ URLs and smart priority settings
- [x] AI crawlers explicitly allowed (GPTBot, ClaudeBot, PerplexityBot, Google-Extended)
- [x] Rating scale converted from 0-100 to 1-5 stars in schema.org (Google prefers this for rich snippets)
- [x] `dateModified` added to show schemas (signals content freshness)
- [x] `inLanguage: "en"` added across all schemas
- [x] Staging/preview Vercel deployments blocked from indexing

### Off-Site SEO (YOU Need to Do These)

These are the highest-impact actions. No amount of on-site optimization compensates for a lack of backlinks and brand signals on a new domain.

**Priority 1: Fix Brand Search (Week 1-2)**
- [ ] **Google Business Profile** -- Claim "Broadway Scorecard" as a brand entity. This is how Google learns to associate the word "broadwayscorecard" with your domain instead of golf courses. Go to business.google.com and register.
- [ ] **Create social profiles** with consistent "Broadway Scorecard" branding:
  - Twitter/X: @BwayScorecard
  - Instagram: @broadwayscorecard
  - Threads: @broadwayscorecard
  - Even if you don't post much, the profiles create brand signals Google uses for entity association.
- [ ] **Wikipedia** -- Not a page about the site (would get deleted), but if you're ever referenced in a reliable source, a mention on the Broadway-related Wikipedia pages helps enormously.

**Priority 2: Backlinks (Ongoing)**
- [ ] University outreach emails (see Phase 1 above) -- .edu links are the highest-value backlinks
- [ ] **Theater blogs and forums** -- Comment authentically on BroadwayWorld forums, TheaterMania discussions, etc. with a link in your profile/signature
- [ ] **Reddit r/Broadway** -- The Phase 2 posts above are designed to generate organic backlinks when people reference your data
- [ ] **Guest posts** -- The Phase 3 outreach emails above target theater bloggers who accept guest content
- [ ] **HARO / Connectively** -- Sign up as a source. When journalists need Broadway data/quotes, you can respond and get cited with a link.

**Priority 3: Content That Ranks (Ongoing)**
- [ ] **"Best Broadway Shows 2026" guide** -- Your existing guide at `/guides/best-broadway-musicals` is indexed but not ranking. Consider a year-specific URL like `/guides/best-broadway-shows-2026` that targets the exact query people search.
- [ ] **"Best Broadway Shows for Kids 2026"** -- Getting 29 impressions with 0 clicks. A dedicated landing page targeting this exact query would rank faster than competing on the generic homepage.
- [ ] **"Cheap Broadway Tickets"** -- Already have a guide at `/guides/cheap-broadway-tickets`. This is a high-volume query worth pushing.
- [ ] **Show-specific landing pages** are already working -- "mamma mia musical review" got a click. Each of your 738 show pages is a long-tail keyword opportunity.

### What Success Looks Like
- **Month 1-3:** Brand search working (searching "broadwayscorecard" finds the site). Rich snippets starting to appear. 50-100 clicks/week.
- **Month 3-6:** Ranking page 1 for long-tail queries like "best broadway musicals 2026", "[show name] reviews". 200-500 clicks/week.
- **Month 6-12:** Competing for head terms like "broadway reviews", "broadway show ratings". 1,000+ clicks/week.
- **Month 12+:** Established domain authority. Rich snippets on most show pages. Featured in AI Overviews.

---

## AUTOMATED SOCIAL MEDIA (Added Feb 2026)

The site now has a fully automated social media posting system. Once you set up the accounts and API keys below, it runs forever with zero maintenance.

### What It Does
- **1 tweet per day** at 10 AM ET, content rotates automatically:
  - Monday: Weekly box office recap (top 5 grossing shows)
  - Tuesday: Show spotlight (random high-scoring currently running show)
  - Wednesday: Data insight ("did you know" fact, LLM-generated)
  - Thursday: Weekend picks (top-rated open shows)
  - Friday: Audience vs critics (biggest score gap)
  - Saturday: Closing soon (shows ending within 30 days)
  - Sunday: New reviews roundup
- **Automatic opening night posts** — when a show transitions from previews to open, a tweet goes out with the score
- **Each tweet includes a custom social card image** (show poster + score badge, box office chart, etc.)
- **Tweet text is LLM-generated** via Claude Sonnet — varied, conversational, never robotic
- **Cost: ~$0.10/month** (Claude API for text generation)

### Setup Steps (One-Time, ~30 Minutes)

**Step 1: Create a Twitter/X Account**
- Go to x.com and create @BwayScorecard (or whatever handle is available)
- Set profile pic, bio ("Aggregated Broadway show ratings from 250+ critic outlets"), link to broadwayscorecard.com
- Follow a few Broadway accounts so it looks real

**Step 2: Get Twitter API Keys (Free)**
1. Go to https://developer.x.com/ and sign in with your @BwayScorecard account
2. Click "Sign up for Free Account" (the free tier allows 500 tweets/month — we use ~30)
3. Create a new "App" (call it "Broadway Scorecard Bot" or similar)
4. Set App permissions to **"Read and Write"** (important!)
5. Go to "Keys and Tokens" tab and generate all 4:
   - API Key (also called Consumer Key)
   - API Key Secret (Consumer Secret)
   - Access Token
   - Access Token Secret
6. Save all 4 values — you'll need them for the next step

**Step 3: Add API Keys to GitHub**
1. Go to https://github.com/thomaspryor/Broadwayscore/settings/secrets/actions
2. Add these 4 secrets (click "New repository secret" for each):
   - `TWITTER_API_KEY` → paste the API Key
   - `TWITTER_API_SECRET` → paste the API Key Secret
   - `TWITTER_ACCESS_TOKEN` → paste the Access Token
   - `TWITTER_ACCESS_SECRET` → paste the Access Token Secret

**Step 4: Test It**
- Go to the Actions tab in GitHub
- Find "Social Media Post"
- Click "Run workflow" → set `dry_run` to `true` → click "Run"
- Check the workflow summary to see what it would have posted
- If it looks good, run again with `dry_run` set to `false` for the first real tweet

**That's it.** The daily cron handles everything from here. You'll never need to touch it again.

### Phase 2: Instagram (Optional, Future)
Instagram requires a Business account + Facebook Page + Meta App Review (1-3 weeks of setup pain). Alternative: Ayrshare ($29/mo) gives you a single API for Twitter + Instagram.

Not set up yet. The system is designed so Instagram can be added later without changing anything — just a new posting function in `scripts/lib/twitter-client.js`.

### If Something Breaks
- The workflow will silently skip if Twitter credentials are missing or invalid
- Check Actions tab → "Social Media Post" for logs
- To temporarily disable: just remove the `schedule` trigger from `.github/workflows/social-post.yml`
- To force a specific post: Actions → "Social Media Post" → Run workflow → pick a type
