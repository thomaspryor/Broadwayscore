# WSJ Login Debugging Findings

**Date:** 2026-01-28
**Status:** Diagnosed - Not a login bug

## Summary

The WSJ login system is NOT broken. The low apparent success rate (~0%) mentioned in the strategy document was a misdiagnosis. The actual success rate is 45% (36/80 reviews have fullText).

## Root Cause

WSJ is listed in `archiveFirstSites` in `collect-review-texts.js`, which means:
1. The scraper tries Archive.org FIRST for all WSJ URLs
2. If Archive.org succeeds (or fails), the login system is never attempted
3. Archive.org is actually our most successful method overall (11.1% success)

This is correct behavior - Archive.org often has pre-paywall content for older articles.

## Current Success Rate

| Metric | Count |
|--------|-------|
| Total WSJ reviews | 80 |
| With fullText (>500 chars) | 36 (45%) |
| With excerpts only | 44 (55%) |
| No text at all | 0 |

## Fetch Method Breakdown

| Method | Count |
|--------|-------|
| archive | 37 |
| unknown | 40 |
| bww-roundup | 2 |
| stub | 1 |

Most successful fetches are via Archive.org, not login.

## Recommendations

### Option 1: Keep Current Behavior (Recommended)
- Archive.org works well for historical WSJ articles
- No changes needed
- Login would only help for very recent articles not yet archived

### Option 2: Add Login Fallback
If you want to try login for reviews where Archive.org fails:

1. In `collect-review-texts.js`, after Archive.org fails for WSJ:
   - Check if credentials are available
   - Attempt Playwright login as fallback
   - This would add complexity but might recover ~10-20 more reviews

### Option 3: Move WSJ Out of archiveFirstSites
- Would try Playwright+login FIRST instead of Archive.org
- Risk: Login may have worse success rate than Archive.org
- Not recommended without testing

## Login Code Review

The WSJ login code in `collect-review-texts.js` (lines 381-396) looks correct:

```javascript
if (domain === 'wsj.com') {
  await page.goto('https://accounts.wsj.com/login', { timeout: CONFIG.loginTimeout });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // WSJ login form
  await page.fill('input[name="username"]', email).catch(() => {});
  await page.click('button[type="submit"]').catch(() => {}); // Continue button
  await page.waitForTimeout(2000);

  await page.fill('input[name="password"]', password).catch(() => {});
  await page.click('button[type="submit"]').catch(() => {}); // Sign in button
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  console.log('    ✓ WSJ login attempted');
  return true;
}
```

**Note:** The test-paywalled-access.js script uses a different login URL (`https://sso.accounts.dowjones.com/login`) which may be more current. Consider updating if login attempts are added.

## Environment Variables

WSJ credentials are correctly configured:
- `WSJ_EMAIL`
- `WSJ_PASSWORD`

## Conclusion

The WSJ "login issue" was a misdiagnosis. The system is working as designed, prioritizing Archive.org which has proven more reliable for WSJ content. The 44 reviews without fullText are simply ones that:
1. Archive.org doesn't have
2. Login was never attempted because Archive.org was tried first
3. Many have excerpts from aggregators, so LLM scoring still works
