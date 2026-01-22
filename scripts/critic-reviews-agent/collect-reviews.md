# Critic Review Collection Workflow

## Usage
When asked to collect reviews for a show, follow this systematic workflow.

## Input
- Show name (e.g., "Bug", "Marjorie Prime")
- Show ID will be derived (e.g., "bug-2025", "marjorie-prime-2025")

## Phase 1: Discovery (Search All 3 Aggregators)

### 1.1 Search DTLI
```
Search: "[Show Name]" site:didtheylikeit.com OR "[Show Name]" "Did They Like It"
```
Extract: Total review count, positive/mixed/negative breakdown, list of outlets

### 1.2 Search Show-Score
```
Search: "[Show Name]" site:show-score.com Broadway
```
Extract: List of critic outlets mentioned

### 1.3 Search BroadwayWorld Review Roundup
```
Search: site:broadwayworld.com "Review Roundup" "[Show Name]"
```
Extract: All outlets and critics mentioned, any ratings/quotes

## Phase 2: Rating Collection

For EACH outlet found, search for the actual rating:
```
Search: "[Show Name]" Broadway review [Outlet Name] stars rating 2025
```

### Rating Conversion Table
| Original | Score |
|----------|-------|
| 5 stars / A+ / 10/10 | 100 |
| 4.5 stars / A | 95 |
| 4 stars / A- / B+ | 80-85 |
| 3.5 stars / B | 75 |
| 3 stars / B- / C+ | 65-70 |
| 2.5 stars / C | 55-60 |
| 2 stars / C- / D | 40-45 |
| 1 star / F | 20 |
| Critic's Pick | +3 bonus, typically 88-95 |
| Recommended | +2 bonus |

### Bucket Assignment
- 85-100: Rave (thumb: Up)
- 70-84: Positive (thumb: Up)
- 50-69: Mixed (thumb: Flat)
- 0-49: Pan (thumb: Down)

## Phase 3: Generate Report (DO NOT COMMIT YET)

Output a structured report:

```
=== REVIEW COLLECTION REPORT: [SHOW NAME] ===

Show ID: [show-id]
Collection Date: [date]

AGGREGATOR CROSS-CHECK:
- DTLI: [X] reviews ([Y] positive, [Z] mixed, [W] negative)
- Show-Score: [lists X outlets]
- BroadwayWorld: [lists X outlets]

REVIEWS FOUND: [total]

| # | Outlet | Critic | Rating Found | Score | Bucket | Tier |
|---|--------|--------|--------------|-------|--------|------|
| 1 | NYT | [name] | Critic's Pick | 90 | Rave | T1 |
| 2 | Vulture | [name] | Mixed | 65 | Mixed | T1 |
...

CALCULATED METRICS:
- Simple Average: [X]
- Rave: [X] | Positive: [X] | Mixed: [X] | Pan: [X]
- % Positive: [X]%

MISSING OUTLETS (found in aggregators but no review collected):
- [outlet name] - [reason: not found / no rating / etc.]

VALIDATION:
- [ ] Count matches DTLI? (We have [X], DTLI shows [Y])
- [ ] All T1 outlets checked?
- [ ] Ratings verified (not guessed from snippets)?

READY FOR HUMAN REVIEW
```

## Phase 4: Human Review

Present the report and ask:
1. Any corrections needed?
2. Any missing reviews to search for?
3. Approve to write to files?

## Phase 5: Write Data (After Approval)

Only after human approval:
1. Add show to `data/shows.json` if new
2. Add reviews to `data/reviews.json`
3. Run validation: `npx ts-node scripts/critic-reviews-agent/validate.ts [show-id]`
4. Commit with descriptive message
5. Push to branch

## Outlet Tier Reference

### Tier 1 (weight 1.0)
NYT, Vulture, Variety, Time Out NY, Hollywood Reporter, Washington Post, Associated Press

### Tier 2 (weight 0.85)
NY Post, NY Daily News, TheaterMania, Entertainment Weekly, Chicago Tribune,
New York Theatre Guide, New York Stage Review, The Wrap, Observer, The Daily Beast,
Deadline, The Guardian, New York Theater, amNewYork

### Tier 3 (weight 0.70)
Theatrely, Culture Sauce, One Minute Critic, Cititour, BroadwayWorld (reviews),
Front Mezz Junkies, Stage and Cinema, The Jitney, and other blogs/smaller outlets
