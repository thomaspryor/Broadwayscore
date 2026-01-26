# SEO & AI Engine Optimization (AEO) Plan for Broadway Scorecard

## Executive Summary

With Gartner predicting a 25% drop in traditional search volume by 2026, optimizing for AI-powered search engines (ChatGPT, Perplexity, Google AI Overviews, Claude) is now critical. This plan covers both traditional SEO best practices and the emerging field of **Generative Engine Optimization (GEO)** / **Answer Engine Optimization (AEO)**.

---

## Part 1: AI Engine Optimization (AEO/GEO)

### Why This Matters Now

- **60%+ of searches** now end without a click (users get answers from AI overviews)
- **ChatGPT processes 37.5M daily searches** (740% growth in user adoption)
- LLMs cite only **2-7 domains per response** (vs 10 blue links in traditional search)
- Content updated within **30 days earns 3.2x more citations**

### Key Differences from Traditional SEO

| Traditional SEO | AI Engine Optimization |
|-----------------|------------------------|
| Rank on page 1 | Get cited in AI answers |
| Backlinks matter | Citation authority matters |
| Keyword density | Semantic clarity |
| 10 blue links compete | 2-7 sources get cited |

### What Makes Content Get Cited by AI

1. **Clear Structure** - H2/H3/bullet points = 40% more likely to be cited
2. **Original Data** - Pages with data tables earn **4.1x more citations**
3. **Statistics** - Adding specific stats boosts citations by 5.5%+
4. **FAQ Format** - Q&A matches how users ask questions
5. **Freshness** - Content updated in last 30 days = 3.2x more citations
6. **Schema Markup** - Proper Article + FAQ schema = 28% more citations

---

## Part 2: Current State Assessment

### What Broadway Scorecard Already Has (Good)

- **Organization Schema** - Site identity
- **WebSite Schema** - With search action
- **TheaterEvent Schema** - Full show details with:
  - Aggregate ratings
  - Individual reviews
  - Ticket offers
  - Cast/performers
  - Director
- **BreadcrumbList Schema** - Navigation context
- **ItemList Schema** - For browse pages
- **GPTBot allowed** in robots.txt

### What's Missing (Opportunities)

| Gap | Impact |
|-----|--------|
| **No llms.txt file** | AI systems can't understand site structure |
| **robots.txt incomplete** | Missing ClaudeBot, PerplexityBot, others |
| **Sitemap URL wrong** | Points to Vercel preview, not production |
| **No FAQ schema** | Missing 28% citation boost |
| **No Article schema on methodology** | Less likely to be cited for "how are Broadway shows rated" |

---

## Part 3: Implementation Plan

### Phase 1: Technical Foundation (Quick Wins)

#### 1.1 Update robots.txt
```
User-agent: *
Allow: /

# AI Search Crawlers (for citations)
User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

Sitemap: https://broadwayscorecard.com/sitemap.xml
```

#### 1.2 Create llms.txt File
Create `/public/llms.txt` - a markdown file that helps LLMs understand your site:

```markdown
# Broadway Scorecard

> The independent Broadway review aggregator. We combine critic reviews from major outlets into a single composite score for every Broadway show.

## What We Do

Broadway Scorecard aggregates reviews from professional theater critics (New York Times, Vulture, Variety, etc.) and calculates a weighted score for each Broadway show. Think "Rotten Tomatoes for Broadway."

## Key Pages

- [All Shows](https://broadwayscorecard.com/): Browse 40+ Broadway shows with scores
- [How Scoring Works](https://broadwayscorecard.com/methodology): Our tier-weighted scoring system
- [Best Musicals](https://broadwayscorecard.com/browse/best-broadway-musicals): Top-rated musicals
- [Shows for Kids](https://broadwayscorecard.com/browse/broadway-shows-for-kids): Family-friendly recommendations

## Data We Provide

- **Critic Scores**: 0-100 composite scores based on weighted reviews
- **Review Counts**: Number of critic reviews per show
- **Show Details**: Cast, creative team, venue, runtime
- **Ticket Links**: Where to buy tickets
- **Box Office**: Weekly grosses and capacity

## Source Attribution

All reviews and ratings belong to their respective publications. We aggregate and normalize scores but do not create original reviews.
```

### Phase 2: Schema Enhancements

#### 2.1 Add FAQ Schema to Methodology Page
Add FAQPage schema with common questions like:
- "How is the Broadway Scorecard score calculated?"
- "What outlets do you include?"
- "How are reviews weighted?"

#### 2.2 Add FAQ Schema to Show Pages
Dynamic FAQs per show:
- "What is the critic score for [Show]?"
- "Is [Show] still running on Broadway?"
- "Where is [Show] playing?"

#### 2.3 Add Article Schema to Methodology
Helps "how Broadway scores work" queries cite your methodology.

### Phase 3: Content Optimization for AI

#### 3.1 Add "Quick Facts" Boxes to Show Pages
AI systems love extractable data. Add a structured section:

```
Quick Facts: Hamilton
- Critic Score: 92/100 (23 reviews)
- Status: Now Playing
- Theater: Richard Rodgers Theatre
- Runtime: 2 hours 45 minutes
- Opened: August 6, 2015
```

#### 3.2 Keep Data Fresh
AI prefers recently-updated content. Your automated scrapers already help with this. Consider adding "Last Updated" timestamps visible on pages.

#### 3.3 Answer Common Questions Directly
Add content that directly answers questions people ask AI:
- "What's the best Broadway show right now?"
- "Is [Show] worth seeing?"
- "What are the best Broadway musicals for kids?"

### Phase 4: Monitoring & Measurement

#### Key Metrics to Track

1. **AI Visibility Score** - How often you appear in AI responses
2. **Source Citations** - Times AI models reference your site
3. **Share of Voice** - Your % vs competitors (Show Score, DTLI)
4. **Query Coverage** - Breadth of prompts where you appear

#### Tools

- **Otterly.ai** - Tracks ChatGPT, Perplexity, Google AIO citations
- **Hall** - GEO monitoring across multiple AI platforms
- **HubSpot AI Search Grader** - Free benchmark tool

---

## Part 4: Traditional SEO (Still Important)

### Schema Markup Status

| Schema Type | Status | Pages |
|-------------|--------|-------|
| Organization | Implemented | Site-wide |
| WebSite | Implemented | Site-wide |
| TheaterEvent | Implemented | Show pages |
| AggregateRating | Implemented | Show pages |
| Review | Implemented | Show pages |
| Offer | Implemented | Show pages |
| BreadcrumbList | Implemented | Available |
| ItemList | Implemented | Browse pages |
| FAQPage | ✅ Implemented | Methodology, shows |
| Article | ✅ Implemented | Methodology |

### Technical SEO Checklist

- [x] JSON-LD format (Google preferred)
- [x] Sitemap.xml generated
- [x] Canonical URLs set
- [x] Mobile responsive
- [x] Open Graph tags
- [x] Twitter cards
- [x] Fix sitemap URL in robots.txt
- [x] Add FAQ schema
- [x] Add Article schema
- [x] Create llms.txt

---

## Priority Order

### Immediate (This Week) ✅ COMPLETE
1. ✅ Fix robots.txt (add AI crawlers, fix sitemap URL)
2. ✅ Create llms.txt file

### Short-term (This Month) ✅ COMPLETE
3. ✅ Add FAQ schema to methodology page (already existed)
4. ✅ Add FAQ schema to show pages (dynamic)
5. ✅ Add "Quick Facts" structured data boxes
6. ✅ Add Article schema to methodology page

### Phase 3.2 ✅ COMPLETE
7. ✅ Add "Last Updated" timestamps to show pages

### Ongoing
8. Set up AI citation monitoring
9. Keep content fresh (you're already doing this with scrapers)
10. Answer new common questions as they emerge

---

## Sources

Research compiled from:
- [HubSpot: Answer Engine Optimization Trends 2026](https://blog.hubspot.com/marketing/answer-engine-optimization-trends)
- [Superlines: Complete GEO Guide 2026](https://www.superlines.io/articles/generative-engine-optimization-geo-guide)
- [Shopify: What Is AEO?](https://www.shopify.com/blog/what-is-aeo)
- [Search Engine Land: How to Optimize for AI Search](https://searchengineland.com/how-to-optimize-content-for-ai-search-engines-a-step-by-step-guide-467272)
- [Backlinko: Schema Markup Guide](https://backlinko.com/schema-markup-guide)
- [llmstxt.org: The llms.txt Specification](https://llmstxt.org/)
- [GenRank: Robots.txt for AI Crawlers](https://genrank.io/blog/optimizing-your-robots-txt-for-generative-ai-crawlers/)
- [Frase: FAQ Schema for AI Search](https://www.frase.io/blog/faq-schema-ai-search-geo-aeo)
