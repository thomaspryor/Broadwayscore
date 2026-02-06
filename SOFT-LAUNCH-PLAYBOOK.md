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
covering 5,790 professional Broadway reviews across 657 shows and 20 seasons.

It includes data that's hard to find elsewhere:
- Critic reviews from 257 outlets with transparent scoring methodology
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
It's a free, independent review aggregator tracking 5,790 critic reviews
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

**Title:** `I analyzed 5,790 Broadway reviews from the last 20 seasons. Here's how each season stacks up.`

**Body:**
```
I've been building a database of professional Broadway reviews — currently
5,790 reviews across 657 shows from 257 outlets (NYT, Vulture, Variety,
Post, TheaterMania, Hollywood Reporter, and dozens more).

I scored each review on a 0-100 scale using a mix of explicit critic ratings
(star ratings, letter grades) and AI-assisted interpretation of review text
when no explicit rating was given. Then I averaged by season.

Here's what the data shows:

| Season | Shows | Reviews | Avg Score |
|--------|-------|---------|-----------|
| 2018-2019 | 32 | 312 | 75.1 |
| 2017-2018 | 31 | 278 | 73.8 |
| 2016-2017 | 40 | 250 | 73.8 |
| 2023-2024 | 34 | 926 | 73.3 |
| 2019-2020 | 16 | 110 | 73.3 |
| 2021-2022 | 36 | 418 | 72.8 |
| 2010-2011 | 38 | 149 | 72.8 |
| 2014-2015 | 36 | 307 | 72.6 |
| 2024-2025 | 52 | 919 | 72.3 |
| 2022-2023 | 44 | 922 | 71.5 |
| 2013-2014 | 38 | 236 | 70.5 |
| 2011-2012 | 36 | 136 | 70.3 |
| 2015-2016 | 37 | 251 | 69.7 |
| 2009-2010 | 34 | 106 | 69.4 |
| 2012-2013 | 37 | 162 | 67.2 |
| 2005-2006 | 26 | 47 | 65.8 |

**The best-reviewed season of the last 20 years: 2018-2019** (75.1 avg).
That's the season of Hadestown, Oklahoma! revival, The Ferryman, and
Network with Bryan Cranston.

**The worst: 2012-2013** (67.2). Jekyll & Hyde, Chaplin, Ghost the Musical,
and Breakfast at Tiffany's all opened that season.

This current season (2024-2025) is landing right in the middle of the pack
at 72.3 with 52 shows — the most crowded season in recent memory.

Some interesting patterns:
- The 1.3-point difference between best and worst isn't huge, but it's
  consistent — certain seasons cluster better shows
- 2019-2020 would've ranked higher if COVID hadn't cut it short (only
  16 shows had time to open)
- The late 2010s (2016-2019) were genuinely a golden stretch

Methodology note: scores are aggregated from published reviews. Where
critics gave explicit ratings (stars, letter grades), those are used
directly. For reviews without explicit ratings (~70% of the corpus),
scores are derived from review text using an AI scoring model.
Full methodology at broadwayscorecard.com/methodology

What surprises you? Does the ranking match your gut feeling about
which seasons were strongest?
```

---

### POST 2: Outlet Rankings (Toughest vs Most Generous)

**Title:** `Which Broadway outlets are the toughest graders? I looked at 5,790 reviews to find out.`

**Body:**
```
Using the same database of 5,790 Broadway reviews, I looked at which
outlets consistently grade shows the highest and lowest.

(Important caveat: this doesn't mean "best" or "worst" — harsh outlets
might just have higher standards, and generous outlets might focus on
accessible shows.)

**The toughest outlets** (30+ reviews minimum):

| Outlet | Reviews | Avg Score |
|--------|---------|-----------|
| TheWrap | 129 | 61.9 |
| Lighting & Sound America | 63 | 64.9 |
| New York Post | 253 | 68.2 |
| Vulture | 270 | 68.7 |
| The New York Times | 513 | 69.2 |

**The most generous outlets:**

| Outlet | Reviews | Avg Score |
|--------|---------|-----------|
| Entertainment Weekly | 151 | 77.7 |
| Deadline | 100 | 77.4 |
| Theatrely | 73 | 76.4 |
| TheaterMania | 265 | 74.9 |
| New York Theatre Guide | 130 | 74.5 |

**The biggest publications sit in the middle:**

| Outlet | Reviews | Avg Score |
|--------|---------|-----------|
| Variety | 496 | 72.6 |
| Wall Street Journal | 229 | 71.0 |
| Hollywood Reporter | 174 | 73.6 |
| Washington Post | 164 | 72.7 |
| The Guardian | 117 | 71.1 |

Some things that jumped out:
- The NYT and NY Post are both on the tough end — the two biggest NYC
  papers are also the hardest to please
- There's a 15.8-point gap between TheWrap (61.9) and Entertainment
  Weekly (77.7). That's enormous.
- The "prestige" outlets (NYT, Vulture, New Yorker) cluster tougher.
  The trade/entertainment outlets (EW, Deadline, THR) cluster more
  generous.

Methodology: same as my previous post — mix of explicit critic ratings
and AI-assisted scoring from review text.
broadwayscorecard.com/methodology for the full breakdown.

Does this match your experience reading these outlets?
```

---

### POST 3: Most Polarizing Shows

**Title:** `The most polarizing Broadway shows of the last decade — where critics were most split`

**Body:**
```
Some shows get universal acclaim. Others divide critics completely.
I measured "polarization" as the spread between the highest and lowest
review score for each show (minimum 10 reviews).

**The most divisive shows:**

| Show | Spread | Low | High | Reviews | Avg |
|------|--------|-----|------|---------|-----|
| Water for Elephants | 82 pts | 12 | 94 | 24 | 72.4 |
| The Cottage | 81 pts | 12 | 93 | 24 | 61.3 |
| Moulin Rouge! | 80 pts | 20 | 100 | 38 | 72.4 |
| Once Upon a One More Time | 78 pts | 13 | 91 | 39 | 62.1 |
| Wicked (original run) | 77 pts | 15 | 92 | 26 | 73.3 |
| & Juliet | 73 pts | 14 | 87 | 29 | 71.9 |
| Back to the Future | 70 pts | 21 | 91 | 32 | 61.0 |
| Boop! The Musical | 66 pts | 20 | 86 | 24 | 70.4 |

For comparison, Hamilton had a 28-point spread (77-100, avg 90.5) — near
universal praise.

What stands out:
- **Spectacle musicals dominate this list.** Moulin Rouge, Water for
  Elephants, Back to the Future — critics either love the spectacle
  or find it hollow
- **Wicked being here is wild.** It's a beloved cultural phenomenon
  with a 73.3 average, but some critics absolutely hated it (15/100)
  while others were ecstatic (92/100)
- **Moulin Rouge** is the most "love it or hate it" — a 100 AND a 20
  from different critics, with a perfectly respectable 72.4 average

Data from broadwayscorecard.com — 5,790 reviews across 657 shows.

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
| Meteor Shower | 46 | 76 | +30 |
| American Psycho | 51 | 80 | +29 |
| Fish in the Dark | 53 | 78 | +25 |
| The Parisian Woman | 47 | 72 | +25 |
| Holiday Inn | 57 | 82 | +25 |
| Allegiance | 62 | 86 | +24 |
| Diana, The Musical | 40 | 64 | +24 |

**Shows critics love more than audiences:**

| Show | Critic Avg | Audience Score | Gap |
|------|-----------|----------------|-----|
| Old Times | 73 | 44 | -29 |
| John Lithgow: Stories By Heart | 73 | 47 | -26 |
| Million Dollar Quartet | 77 | 58 | -19 |
| Tootsie | 75 | 58 | -17 |
| An American in Paris | 84 | 67 | -17 |

Patterns:
- **Star vehicles top the "audiences love" list.** Meteor Shower (Steve
  Martin), Fish in the Dark (Larry David), Diana (the brand). Audiences
  show up for the star or the IP. Critics judge the writing.
- **Artsy/cerebral shows top the "critics love" list.** Old Times (Pinter),
  American in Paris (dance-heavy), Tootsie (clever but maybe too inside-
  baseball for casual theatergoers).
- **The Band's Visit** (critics 92, audience 78) is interesting — critics
  gave it the 2nd highest score of the last 20 years, but audiences just
  thought it was "good."

Critic scores from broadwayscorecard.com. Audience scores from ShowScore
+ Mezzanine + Reddit sentiment combined.

Which side do you usually agree with — critics or audiences?
```

---

### POST 5: Plays vs Musicals

**Title:** `Do Broadway critics grade plays and musicals differently? Here's what 5,790 reviews say.`

**Body:**
```
Quick one. I was curious whether critics are systematically tougher or
easier on one form vs the other.

**Plays:** 72.9 average (2,665 reviews across 374 shows)
**Musicals:** 71.6 average (3,125 reviews across 283 shows)

So plays edge out musicals by 1.3 points. Not a huge gap. But the
interesting difference is in the **extremes:**

**Highest-scoring musicals:**
- Hamilton (90.5), The Band's Visit (91.8), A Strange Loop (88.9)

**Lowest-scoring musicals:**
- Jekyll & Hyde (40.2), Diana (40.3), Doctor Zhivago (40.5)

**Highest-scoring plays:**
- Angels in America (92.0), The Lehman Trilogy (90.4), The Normal Heart (89.8)

**Lowest-scoring plays:**
- Breakfast at Tiffany's (40.8), China Doll (41.6), The Parisian Woman (46.8)

Musicals have a wider range — they produce the biggest hits AND the biggest
flops. Plays cluster more tightly around the average.

My theory: musicals are bigger financial bets (higher capitalization,
longer development) so producers take bigger swings. Some land, some
crash spectacularly. Plays are smaller and more author-driven, so the
quality floor is higher.

Data: broadwayscorecard.com

What's your take — should musicals and plays even be scored on the same
scale?
```

---

### POST 6: Best-Reviewed Shows

**Title:** `The 15 best-reviewed Broadway shows of the last 20 years, by the numbers`

**Body:**
```
Based on 5,790 reviews from 257 outlets. Minimum 5 reviews per show.

| Rank | Show | Year | Type | Avg Score | Reviews |
|------|------|------|------|-----------|---------|
| 1 | Angels in America | 2018 | Play | 92.0 | 7 |
| 2 | The Band's Visit | 2017 | Musical | 91.8 | 10 |
| 3 | Hamilton | 2015 | Musical | 90.5 | 45 |
| 4 | The Lehman Trilogy | 2021 | Play | 90.4 | 5 |
| 5 | The Normal Heart | 2011 | Play | 89.8 | 5 |
| 6 | Three Tall Women | 2018 | Play | 89.2 | 5 |
| 7 | A Strange Loop | 2022 | Musical | 88.9 | 17 |
| 8 | Hello, Dolly! | 2017 | Musical | 88.4 | 9 |
| 9 | Jitney | 2017 | Play | 87.8 | 8 |
| 10 | She Loves Me | 2016 | Musical | 87.3 | 9 |
| 11 | Hills of California | 2024 | Play | 87.3 | 6 |
| 12 | The Sound Inside | 2019 | Play | 87.0 | 5 |
| 13 | A View from the Bridge | 2015 | Play | 86.9 | 8 |
| 14 | A Raisin in the Sun | 2014 | Play | 86.7 | 7 |
| 15 | Anything Goes | 2011 | Musical | 86.0 | 9 |

Things that stand out:
- **Revivals dominate.** Angels in America, Hello Dolly, She Loves Me,
  A View from the Bridge, A Raisin in the Sun, Anything Goes — all
  revivals. 6 of the top 15 are revivals.
- **Hamilton is "only" #3.** It has by far the most reviews (45) and
  still averaged 90.5. That's insanely consistent across that many critics.
- **Plays outnumber musicals** in the top 15 (9 plays vs 6 musicals).
- **2017-2018 was stacked.** The Band's Visit, Hello Dolly, Jitney, and
  Angels in America all opened within a year of each other.

Full data at broadwayscorecard.com

What would be on YOUR top 15 that critics missed?
```

---

### POST 7: Worst-Reviewed Shows

**Title:** `The 15 worst-reviewed Broadway shows of the last 20 years (sorry)`

**Body:**
```
The flip side of my best-reviewed post. Minimum 5 reviews per show.

| Rank | Show | Year | Type | Avg Score | Reviews |
|------|------|------|------|-----------|---------|
| 1 | Jekyll & Hyde | 2013 | Musical | 40.2 | 5 |
| 2 | Diana, The Musical | 2021 | Musical | 40.3 | 16 |
| 3 | Doctor Zhivago | 2015 | Musical | 40.5 | 8 |
| 4 | Breakfast at Tiffany's | 2013 | Play | 40.8 | 5 |
| 5 | China Doll | 2015 | Play | 41.6 | 8 |
| 6 | Bad Cinderella | 2023 | Musical | 41.9 | 18 |
| 7 | Meteor Shower | 2017 | Play | 46.0 | 6 |
| 8 | Bronx Bombers | 2014 | Play | 46.4 | 8 |
| 9 | The Parisian Woman | 2017 | Play | 46.8 | 5 |
| 10 | A Time to Kill | 2013 | Play | 48.3 | 6 |
| 11 | Ghost The Musical | 2012 | Musical | 48.7 | 6 |
| 12 | Holler If Ya Hear Me | 2014 | Musical | 48.7 | 7 |
| 13 | Junk | 2017 | Play | 49.5 | 6 |
| 14 | Cirque du Soleil Paramour | 2016 | Musical | 50.5 | 6 |
| 15 | American Psycho | 2016 | Musical | 50.6 | 11 |

Observations:
- **Diana and Bad Cinderella** are the only ones with 15+ reviews AND
  still under 42. That means a LOT of critics all independently said "nope."
- **2013 was brutal.** Jekyll & Hyde, Breakfast at Tiffany's, and A Time
  to Kill all from one season. (2012-2013 was the worst-reviewed season
  in my dataset.)
- **IP adaptations struggle.** Doctor Zhivago, Breakfast at Tiffany's,
  Ghost, American Psycho — beloved source material doesn't guarantee
  a good musical.
- **Star power doesn't save you.** China Doll (Al Pacino), Meteor
  Shower (Steve Martin/Amy Schumer), The Parisian Woman (Uma Thurman).

Data: broadwayscorecard.com

What's missing from this list that you think deserves to be here?
```

---

### POST 8: How the NYT's Criticism Evolved

**Title:** `How Broadway criticism changed when the NYT switched lead critics: Brantley vs Green, by the numbers`

**Body:**
```
The New York Times is the single most influential Broadway outlet — 513
reviews in my database. But the paper's perspective shifted when Jesse
Green succeeded Ben Brantley as co-chief critic.

**By the numbers:**
- **Ben Brantley** (NYT): 236 shows reviewed, average score 68.1
- **Jesse Green** (NYT): 112 shows reviewed, average score 71.5

Green's NYT reviews average 3.4 points higher than Brantley's. That
might not sound like a lot, but it can mean the difference between a
show landing in "mixed" vs "positive" territory.

What's interesting is Green's split across outlets:
- At the NYT: 71.5 avg (112 shows)
- At Vulture: 68.9 avg (124 shows)

His Vulture reviews were notably tougher than his NYT reviews. Same
critic, different platforms, different scores. Make of that what you will.

**The institutional question:** When the paper of record's lead critic
shifts 3+ points in one direction, does that meaningfully change which
shows succeed? The NYT is the outlet producers fear most. A 3-point
shift across 100+ shows isn't nothing.

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
5,790 Broadway reviews across 657 shows, plus box office data, audience
buzz, and commercial performance tracking.

Thought it might be worth a mention in the newsletter as a research
tool for your industry readership. Some highlights:

- Reviews from 257 outlets with transparent scoring methodology
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

The data is all free and open — 5,790 reviews, 657 shows, 20 seasons.

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
