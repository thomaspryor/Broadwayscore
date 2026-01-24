# Operating Guidelines for Broadway Scorecard Sessions

These guidelines apply to all Claude Code sessions working on this project.

## Core Principles

### 1. Use Sub-Agents Liberally

Parallelize work whenever possible:

```
GOOD: Launch 3 sub-agents to scrape 3 different aggregators simultaneously
BAD: Scrape aggregators one at a time, waiting for each to complete
```

When to use sub-agents:
- Multiple independent data fetches
- Parallel file processing
- Concurrent validation tasks
- Any I/O-bound operations that don't depend on each other

### 2. Self-Verification Checklist

Before completing any session, verify:

- [ ] JSON files are valid (parse without errors)
- [ ] TypeScript compiles: `npx tsc --noEmit`
- [ ] Build passes: `npm run build`
- [ ] New files follow naming conventions
- [ ] IDs follow canonical format
- [ ] No hardcoded credentials or secrets

Spot-check examples:
- Read 2-3 generated files to verify structure
- Validate a sample review ID against the show it references
- Confirm URLs are valid and accessible

### 3. Operate Autonomously

**Make reasonable decisions without asking:**
- Data format choices within established conventions
- Error handling strategies
- File organization within defined directories
- Retry counts and timing

**Do ask when:**
- Changing scoring methodology
- Adding new data sources
- Modifying published API contracts
- Making breaking changes to data schema
- Anything affecting user-facing behavior

**When in doubt:** Make the conservative choice, document your reasoning, and continue.

### 4. Error Handling Strategy

**For transient errors (network, rate limits):**
1. Retry up to 4 times with exponential backoff
2. Log the error with context
3. Continue with other work
4. Summarize failures at end of session

```typescript
// Example retry pattern
async function fetchWithRetry(url: string, maxRetries = 4): Promise<Response | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      if (response.status === 429) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
    } catch (error) {
      console.log(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  return null;
}
```

**For permanent errors (404, missing data):**
1. Log the error
2. Skip that item
3. Continue with other work
4. Report in final summary

**Never:**
- Silently swallow errors
- Retry indefinitely
- Let one failure stop all work

### 5. Commit and Push Frequently

Commit after each logical unit of work:
- After adding/updating data for a single show
- After completing a batch of similar operations
- Before switching to a different type of task
- At minimum every 10-15 minutes of active work

Commit message format:
```
feat: Brief description of what was added

- Specific detail 1
- Specific detail 2
```

Categories:
- `feat:` - New features or data
- `fix:` - Bug fixes
- `refactor:` - Code restructuring
- `docs:` - Documentation changes
- `chore:` - Maintenance tasks

### 6. Session Reporting

At the end of each session, summarize:

1. **What was completed:**
   - Files created/modified
   - Shows processed
   - Reviews added

2. **What failed (if anything):**
   - URLs that couldn't be accessed
   - Data that couldn't be parsed
   - Shows that need manual attention

3. **What's next:**
   - Remaining work for future sessions
   - Dependencies on other sessions
   - Blockers identified

## Data Quality Standards

### Review Data

Every review should have:
- Valid show ID (exists in shows.json)
- Valid outlet ID (from outlets.ts or UNKNOWN)
- URL that resolves (or note if broken)
- Assigned score 0-100
- At least one of: originalRating, bucket, or thumb

### Aggregator Data

Every aggregator fetch should:
- Archive the raw HTML
- Extract structured data
- Note the fetch timestamp
- Flag any parsing errors

### LLM Scores

Every LLM score should:
- Include the model used
- Include confidence level
- Include reasoning
- Be reproducible with same prompt version

## Performance Guidelines

### Parallel Operations
- Maximum 5 concurrent web requests
- Maximum 10 concurrent file operations
- Use batching for large datasets

### Resource Limits
- Don't load entire data files into memory unnecessarily
- Stream large files when possible
- Clean up temporary files

### Rate Limiting
- Respect robots.txt
- Add delays between requests to same domain (1-2 seconds)
- Use caching for repeated lookups

## Security

### Never commit:
- API keys or secrets
- User credentials
- Personal information
- Paywalled content verbatim

### Always:
- Use environment variables for secrets
- Sanitize user input
- Validate URLs before fetching
- Check file paths for traversal attacks
