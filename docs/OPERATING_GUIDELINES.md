# Operating Guidelines for Broadway Scorecard Sessions

These guidelines apply to ALL Claude Code sessions working on this project.

---

## 1. USE SUB-AGENTS LIBERALLY

Sub-agents are cheap. Use them aggressively for parallel work.

**Always parallelize independent operations:**
```
GOOD: Fetching 3 aggregators (DTLI, Show-Score, BWW) = 3 parallel agents
BAD:  Fetching aggregators sequentially, waiting for each to complete
```

**When to use sub-agents:**
- Multiple web fetches (each aggregator = separate agent)
- Batch file processing (split shows into groups)
- Parallel validation tasks
- Any I/O-bound work that doesn't depend on prior results

**Example pattern:**
```
Task: Gather reviews for 10 shows from 3 sources

Launch:
  - Agent 1: Fetch DTLI for all 10 shows
  - Agent 2: Fetch Show-Score for all 10 shows
  - Agent 3: Fetch BWW for all 10 shows

All 3 run simultaneously. 3x faster than sequential.
```

---

## 2. CHECK YOUR WORK REGULARLY

### Validate JSON after writing
```typescript
// Always verify JSON is valid before moving on
const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
```

### Spot-check 2-3 examples per batch
- Read generated files to verify structure
- Confirm review IDs reference valid shows
- Check URLs are accessible

### Run build before pushing
```bash
npm run build  # Must pass
```

### Cross-reference against sources
- Compare review counts: our data vs aggregator claims
- Verify critic names match across sources
- Flag discrepancies for investigation

---

## 3. OPERATE AUTONOMOUSLY

### DO NOT ask permission for:
- ✅ File changes within your scope (your assigned directories)
- ✅ Implementation choices (how to parse, what format to use)
- ✅ Fixing bugs you discover
- ✅ Commits and pushes
- ✅ Retrying with different approaches when first attempt fails
- ✅ Adding error handling or logging
- ✅ Choosing between equivalent valid options

### DO ask for:
- ❓ Changing `src/types/canonical.ts` (affects all sessions)
- ❓ Deleting data files (irreversible)
- ❓ When blocked after 3+ attempts at different approaches
- ❓ Changing scoring methodology
- ❓ Adding new data sources not in the plan
- ❓ Breaking changes to existing schemas

**When in doubt:** Make the conservative choice, document your reasoning, and continue.

---

## 4. HANDLE ERRORS GRACEFULLY

### Retry 4x with fallbacks
```typescript
async function fetchWithRetry(url: string, maxRetries = 4): Promise<Response | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;

      // Rate limited - wait and retry
      if (response.status === 429) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }

      // Permanent failure - try fallback
      if (response.status === 403) {
        return tryFallbackSource(url);
      }
    } catch (error) {
      console.log(`Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  return null;  // Give up, but don't throw
}
```

### Log failures, continue with remaining work
```typescript
const results = { success: [], failed: [] };

for (const show of shows) {
  try {
    const data = await fetchShowData(show);
    results.success.push(show.id);
  } catch (error) {
    results.failed.push({ id: show.id, error: error.message });
    // Continue with next show - don't stop
  }
}
```

### Summarize issues at end
```
Session complete.
✅ Processed: 18 shows
❌ Failed: 2 shows
   - hamilton-2015: 403 Forbidden (site blocking)
   - wicked-2003: Timeout after 4 retries

Next steps: Manual intervention needed for failed shows.
```

**Never:**
- Stop all work because one item failed
- Silently swallow errors (always log)
- Retry indefinitely

---

## 5. DATA INTEGRITY FIRST

### Validate against schema before saving
```typescript
import { Review } from '@/types/canonical';

function saveReview(review: unknown): void {
  // Validate required fields
  if (!review.id || !review.showId || !review.outletId) {
    throw new Error(`Invalid review: missing required fields`);
  }

  // Validate score range
  if (review.assignedScore < 0 || review.assignedScore > 100) {
    throw new Error(`Invalid score: ${review.assignedScore}`);
  }

  // Only save if valid
  fs.writeFileSync(filepath, JSON.stringify(review, null, 2));
}
```

### Never write invalid or partial data
- If extraction fails mid-way, don't save partial results
- Use atomic writes (write to temp file, then rename)
- Validate JSON can be parsed back after writing

### Preserve existing data
- Read existing file before overwriting
- Merge new data with existing, don't replace
- Keep backup of previous version if making significant changes

---

## 6. COMMIT & PUSH FREQUENTLY

### Commit after each logical unit
- After processing each show
- After completing a batch of similar operations
- Before switching to a different type of task

### Push every 3-5 commits
```bash
# Pattern:
git add <files>
git commit -m "feat: Add reviews for show-name"
# ... repeat 3-5 times ...
git push
```

### Commit message format
```
feat: Brief description

- Detail 1
- Detail 2

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

**Categories:**
- `feat:` - New features or data
- `fix:` - Bug fixes
- `refactor:` - Code restructuring
- `docs:` - Documentation
- `chore:` - Maintenance

---

## Session End Checklist

Before ending any session:

- [ ] All JSON files parse without errors
- [ ] TypeScript compiles: `npx tsc --noEmit`
- [ ] Build passes: `npm run build`
- [ ] All changes committed and pushed
- [ ] Summary of completed work provided
- [ ] Failed items documented with reasons
- [ ] Next steps identified for follow-up
