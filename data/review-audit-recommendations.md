# Review Database Audit - January 2026

## Summary
Audited 1,027 reviews for:
- Movie reviews confused with Broadway
- Touring production reviews
- West End/international reviews
- Regional production reviews

---

## 🔴 REMOVE - Not Broadway Reviews

### 1. stranger-things-2024 / BroadwayWorld (Alexander Cohen)
**Issue:** This is reviewing the **WEST END** production at Phoenix Theatre, London - NOT Broadway.
- URL contains "Phoenix-Theatre"
- Text says "plays at The Phoenix Theatre until 25 August"
- Published December 2023, Broadway didn't open until 2024
- **Action:** DELETE this review file

### 2. mamma-mia-2025 / Deadline (Greg Evans)
**Issue:** Explicitly reviews "touring production's stop at the Garden"
- Text: "This touring production's stop at the Garden has all the makings of a homecoming"
- This is the national tour playing MSG, not a new Broadway production
- **Action:** DELETE or move to separate "touring" category

### 3. mamma-mia-2025 / Multiple outlets
**Issue:** All these reviews are for the TOURING production at MSG, not Broadway:
- `cititour--brian-scott-lipton.json`
- `culture-sauce--thom-geier.json`
- `deadline--greg-evans.json`
- `new-york-theater--jonathan-mandell.json`
- `ny-stage-review--david-finkle.json`
- `ny-stage-review--michael-sommers.json`
- `timeout-ny--adam-feldman.json`
- `theatermania--pete-hempstead.json` (if it exists)

**Note:** If Mamma Mia 2025 IS the touring production, then the entire show entry might need to be recategorized or the show metadata updated to clarify it's a "Broadway engagement of the national tour" rather than a new production.

---

## 🟡 VERIFY - Possibly Not Broadway

### 4. the-lion-king-1997 / Columbus Dispatch (Michael Grossberg)
**Issue:** Regional paper, but published Nov 14, 1997 (day after Broadway opening)
- Could be legitimate if critic flew to NYC for opening
- No URL to verify
- Only has a short excerpt: "A triumph of theatrical imagination..."
- **Action:** KEEP but flag as low-confidence (only excerpt available)

### 5. the-lion-king-1997 / Other Regional Papers
These regional papers reviewed Lion King around 1997-1998:
- `denver-post--sandra-brooks-dillard.json`
- `milwaukee-journal-sentinel--damien-jaques.json`
- `sarasota-herald-tribune--jay-handelman.json`
- `seattle-post-intelligencer--jeffrey-eric-jenkins.json`
- `syracuse-herald-journal--joan-vadeboncoeur.json`
- `post-and-courier--dottie-ashley.json`

**Action:** Check publish dates - if within 2 weeks of Nov 13, 1997 opening, likely legitimate. If later (1998+), likely touring reviews and should be removed.

### 6. book-of-mormon-2011 / Chicago Tribune (Chris Jones)
**Issue:** Mentions "Cadillac Palace" (Chicago theater)
- Chris Jones IS the Chicago Tribune's Broadway critic and travels to NYC
- But this specific review might be of the Chicago production
- **Action:** Check URL/content to verify if reviewing Broadway or Chicago

---

## 🟢 FALSE POSITIVES - Keep These

These were flagged but are actually legitimate Broadway reviews:

### Reviews mentioning "Kennedy Center" or "National Theatre"
These mention pre-Broadway tryouts or development history, NOT that they're reviewing those productions:
- `aladdin-2014/nytimes--charles-isherwood.json` - Mentions Kennedy Center tryout in review of Broadway
- `hadestown-2019/*.json` - Mentions National Theatre London development
- `chess-2025/hollywood-reporter--richard-lawson.json` - Mentions Kennedy Center in history

### Reviews mentioning "tour" in context
These discuss future touring, not that they're reviewing a tour:
- `two-strangers-bway-2025/daily-beast--tim-teeman.json` - Mentions the show may tour
- `boop-2025/theatermania--pete-hempstead.json` - Context mentions touring generally
- `mj-2022/*.json` - Discuss the show will tour, but reviewing Broadway

---

## Recommendations

### Immediate Actions
1. **Delete** `stranger-things-2024/broadwayworld--alexander-cohen.json` (West End review)
2. **Verify** Mamma Mia 2025 show entry - is this a new production or touring engagement?
3. **Check dates** on Lion King regional reviews

### Database Improvements
1. Add `productionType` field to shows: `broadway_original`, `broadway_revival`, `broadway_transfer`, `touring_broadway_engagement`
2. Add `verified` boolean to reviews with source
3. For regional outlets, require URL verification before including

### Scraping Improvements
1. Reject reviews from non-NYC venues
2. Flag reviews from regional papers for manual review
3. Cross-check publication dates against Broadway opening dates
