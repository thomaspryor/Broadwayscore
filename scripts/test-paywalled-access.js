#!/usr/bin/env node

/**
 * Test Paywalled Site Access
 *
 * Tests if stored credentials for NYT, Vulture, and WaPo actually work
 * by attempting login and accessing a paywalled article.
 *
 * Environment variables:
 *   NYT_EMAIL, NYT_PASSWORD (or NYTIMES_PASSWORD)
 *   VULTURE_EMAIL, VULTURE_PASSWORD
 *   WAPO_EMAIL, WAPO_PASSWORD (or WASHPOST_PASSWORD)
 *
 * Usage:
 *   node scripts/test-paywalled-access.js
 *   node scripts/test-paywalled-access.js --site=nyt
 *   node scripts/test-paywalled-access.js --headful  (show browser)
 */

const { chromium } = require('playwright');

// Parse command line args
const args = process.argv.slice(2);
const headful = args.includes('--headful') || args.includes('--headed');
const siteFilter = args.find(a => a.startsWith('--site='))?.split('=')[1];

// Test configuration for each site
const SITES = {
  nyt: {
    name: 'New York Times',
    loginUrl: 'https://myaccount.nytimes.com/auth/login',
    testArticle: 'https://www.nytimes.com/2024/03/21/theater/water-for-elephants-review-broadway.html',
    emailEnv: 'NYT_EMAIL',
    passwordEnv: ['NYT_PASSWORD', 'NYTIMES_PASSWORD'],
    login: async (page, email, password) => {
      console.log('    Navigating to NYT login...');
      await page.goto('https://myaccount.nytimes.com/auth/login', { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for email field
      console.log('    Waiting for email field...');
      const emailField = await page.waitForSelector('input[name="email"], input[type="email"], #email', { timeout: 15000 });
      await emailField.fill(email);

      // Click continue button
      console.log('    Clicking continue...');
      const continueBtn = await page.waitForSelector('button[type="submit"], button:has-text("Continue")', { timeout: 10000 });
      await continueBtn.click();

      // Wait for password field (NYT has two-step login)
      console.log('    Waiting for password field...');
      await page.waitForTimeout(2000);
      const passwordField = await page.waitForSelector('input[name="password"], input[type="password"], #password', { timeout: 15000 });
      await passwordField.fill(password);

      // Click login button
      console.log('    Clicking login...');
      const loginBtn = await page.waitForSelector('button[type="submit"], button:has-text("Log In"), button:has-text("Sign In")', { timeout: 10000 });
      await loginBtn.click();

      // Wait for navigation after login
      console.log('    Waiting for login to complete...');
      await page.waitForTimeout(5000);

      // Check for error messages
      const errorElement = await page.$('[data-testid="error-message"], .login-error, .error-message');
      if (errorElement) {
        const errorText = await errorElement.textContent();
        throw new Error(`Login error: ${errorText}`);
      }

      return true;
    },
    checkAccess: async (page, articleUrl) => {
      console.log('    Navigating to test article...');
      await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check for paywall indicators
      const paywallSelectors = [
        '[data-testid="paywall"]',
        '.css-mcm29f', // NYT paywall modal
        '[class*="PaywallButton"]',
        'button:has-text("Subscribe")',
        '[data-testid="inline-message"]'
      ];

      for (const selector of paywallSelectors) {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            return { success: false, reason: 'Paywall detected' };
          }
        }
      }

      // Check for article content
      const articleBody = await page.$('article, [data-testid="article-body"], .story-body, .StoryBodyCompanionColumn');
      if (!articleBody) {
        return { success: false, reason: 'Article body not found' };
      }

      const articleText = await articleBody.textContent();
      if (articleText.length < 500) {
        return { success: false, reason: `Article too short (${articleText.length} chars) - likely truncated` };
      }

      return { success: true, articleLength: articleText.length };
    }
  },

  vulture: {
    name: 'Vulture (NY Magazine)',
    loginUrl: 'https://www.vulture.com/login',
    testArticle: 'https://www.vulture.com/article/theater-review-water-for-elephants-broadway.html',
    emailEnv: 'VULTURE_EMAIL',
    passwordEnv: ['VULTURE_PASSWORD'],
    login: async (page, email, password) => {
      console.log('    Navigating to Vulture login...');

      // First go to vulture and find login
      await page.goto('https://www.vulture.com', { waitUntil: 'networkidle', timeout: 30000 });

      // Look for login/sign in link
      const loginLink = await page.$('a[href*="login"], a:has-text("Log In"), a:has-text("Sign In"), button:has-text("Log In")');
      if (loginLink) {
        await loginLink.click();
        await page.waitForTimeout(2000);
      } else {
        // Try direct login URL
        await page.goto('https://pyxis.nymag.com/auth', { waitUntil: 'networkidle', timeout: 30000 });
      }

      console.log('    Looking for email field...');
      const emailField = await page.waitForSelector('input[name="email"], input[type="email"], #email', { timeout: 15000 });
      await emailField.fill(email);

      // Check if there's a separate password field or continue button
      const passwordField = await page.$('input[name="password"], input[type="password"]');
      if (passwordField) {
        await passwordField.fill(password);
        const submitBtn = await page.$('button[type="submit"]');
        if (submitBtn) await submitBtn.click();
      } else {
        // Two-step login
        const continueBtn = await page.$('button[type="submit"], button:has-text("Continue")');
        if (continueBtn) {
          await continueBtn.click();
          await page.waitForTimeout(2000);
          const pwdField = await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 10000 });
          await pwdField.fill(password);
          const loginBtn = await page.$('button[type="submit"]');
          if (loginBtn) await loginBtn.click();
        }
      }

      console.log('    Waiting for login to complete...');
      await page.waitForTimeout(5000);

      return true;
    },
    checkAccess: async (page, articleUrl) => {
      console.log('    Navigating to test article...');
      await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check for paywall
      const paywallSelectors = [
        '.paywall',
        '[class*="Paywall"]',
        '.article-paywall',
        'div:has-text("Subscribe to continue reading")',
        '[data-testid="metered-paywall"]'
      ];

      for (const selector of paywallSelectors) {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            return { success: false, reason: 'Paywall detected' };
          }
        }
      }

      // Check for article content
      const articleBody = await page.$('article, .article-content, .article__content, [class*="ArticleBody"]');
      if (!articleBody) {
        return { success: false, reason: 'Article body not found' };
      }

      const articleText = await articleBody.textContent();
      if (articleText.length < 500) {
        return { success: false, reason: `Article too short (${articleText.length} chars)` };
      }

      return { success: true, articleLength: articleText.length };
    }
  },

  wapo: {
    name: 'Washington Post',
    loginUrl: 'https://www.washingtonpost.com/subscribe/signin/',
    testArticle: 'https://www.washingtonpost.com/entertainment/theater/2024/03/21/water-for-elephants-broadway-musical-review/',
    emailEnv: 'WAPO_EMAIL',
    passwordEnv: ['WAPO_PASSWORD', 'WASHPOST_PASSWORD'],
    login: async (page, email, password) => {
      console.log('    Navigating to WaPo login...');
      await page.goto('https://www.washingtonpost.com/subscribe/signin/', { waitUntil: 'networkidle', timeout: 30000 });

      console.log('    Looking for email field...');
      const emailField = await page.waitForSelector('input[name="email"], input[type="email"], #email', { timeout: 15000 });
      await emailField.fill(email);

      // WaPo usually has email first, then password on next screen
      const continueBtn = await page.$('button[type="submit"], button:has-text("Next"), button:has-text("Continue")');
      if (continueBtn) {
        await continueBtn.click();
        await page.waitForTimeout(2000);
      }

      console.log('    Looking for password field...');
      const passwordField = await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 15000 });
      await passwordField.fill(password);

      const loginBtn = await page.$('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
      if (loginBtn) {
        await loginBtn.click();
      }

      console.log('    Waiting for login to complete...');
      await page.waitForTimeout(5000);

      return true;
    },
    checkAccess: async (page, articleUrl) => {
      console.log('    Navigating to test article...');
      await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check for paywall
      const paywallSelectors = [
        '[data-qa="subscribe-promo"]',
        '.paywall',
        '[class*="Paywall"]',
        '#wall-bottom-drawer',
        'button:has-text("Subscribe")'
      ];

      for (const selector of paywallSelectors) {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            return { success: false, reason: 'Paywall detected' };
          }
        }
      }

      // Check for article content
      const articleBody = await page.$('article, [data-qa="article-body"], .article-body');
      if (!articleBody) {
        return { success: false, reason: 'Article body not found' };
      }

      const articleText = await articleBody.textContent();
      if (articleText.length < 500) {
        return { success: false, reason: `Article too short (${articleText.length} chars)` };
      }

      return { success: true, articleLength: articleText.length };
    }
  },

  wsj: {
    name: 'Wall Street Journal',
    loginUrl: 'https://sso.accounts.dowjones.com/login',
    testArticle: 'https://www.wsj.com/arts-culture/theater-review-swept-away-broadway-avett-brothers-musical-c54de174',
    emailEnv: 'WSJ_EMAIL',
    passwordEnv: ['WSJ_PASSWORD'],
    login: async (page, email, password) => {
      console.log('    Navigating to WSJ login...');
      await page.goto('https://sso.accounts.dowjones.com/login', { waitUntil: 'networkidle', timeout: 30000 });

      console.log('    Looking for email field...');
      const emailField = await page.waitForSelector('input[name="username"], input[type="email"], #username', { timeout: 15000 });
      await emailField.fill(email);

      // WSJ has continue button then password
      const continueBtn = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Next")');
      if (continueBtn) {
        await continueBtn.click();
        await page.waitForTimeout(2000);
      }

      console.log('    Looking for password field...');
      const passwordField = await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 15000 });
      await passwordField.fill(password);

      const loginBtn = await page.$('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
      if (loginBtn) {
        await loginBtn.click();
      }

      console.log('    Waiting for login to complete...');
      await page.waitForTimeout(5000);

      return true;
    },
    checkAccess: async (page, articleUrl) => {
      console.log('    Navigating to test article...');
      await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check for paywall
      const paywallSelectors = [
        '[class*="paywall"]',
        '[class*="Paywall"]',
        '.wsj-snippet-login',
        'button:has-text("Subscribe")',
        '[data-testid="paywall"]'
      ];

      for (const selector of paywallSelectors) {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            return { success: false, reason: 'Paywall detected' };
          }
        }
      }

      // Check for article content
      const articleBody = await page.$('article, .article-content, [class*="ArticleBody"]');
      if (!articleBody) {
        return { success: false, reason: 'Article body not found' };
      }

      const articleText = await articleBody.textContent();
      if (articleText.length < 500) {
        return { success: false, reason: `Article too short (${articleText.length} chars)` };
      }

      return { success: true, articleLength: articleText.length };
    }
  }
};

// Get credentials from environment
function getCredentials(site) {
  const config = SITES[site];
  const email = process.env[config.emailEnv];

  let password = null;
  for (const envVar of config.passwordEnv) {
    if (process.env[envVar]) {
      password = process.env[envVar];
      break;
    }
  }

  return { email, password };
}

// Test a single site
async function testSite(browser, siteKey) {
  const config = SITES[siteKey];
  const result = {
    site: config.name,
    key: siteKey,
    credentialsFound: false,
    loginSuccess: false,
    articleAccess: false,
    error: null,
    details: {}
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${config.name}`);
  console.log('='.repeat(60));

  // Check credentials
  const { email, password } = getCredentials(siteKey);

  if (!email || !password) {
    result.error = `Credentials missing (${config.emailEnv}=${email ? 'set' : 'MISSING'}, password=${password ? 'set' : 'MISSING'})`;
    console.log(`  ❌ ${result.error}`);
    return result;
  }

  result.credentialsFound = true;
  result.details.email = email;
  console.log(`  ✓ Credentials found for: ${email}`);

  // Create a new context for this test
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();

  try {
    // Attempt login
    console.log(`\n  Step 1: Attempting login...`);
    await config.login(page, email, password);
    result.loginSuccess = true;
    console.log(`  ✓ Login completed (no obvious errors)`);

    // Test article access
    console.log(`\n  Step 2: Testing article access...`);
    console.log(`    URL: ${config.testArticle}`);
    const accessResult = await config.checkAccess(page, config.testArticle);

    if (accessResult.success) {
      result.articleAccess = true;
      result.details.articleLength = accessResult.articleLength;
      console.log(`  ✓ Article accessible (${accessResult.articleLength} chars)`);
    } else {
      result.details.accessError = accessResult.reason;
      console.log(`  ⚠️ Article NOT accessible: ${accessResult.reason}`);
    }

  } catch (err) {
    result.error = err.message;
    console.log(`  ❌ Error: ${err.message}`);

    // Take screenshot on error
    try {
      const screenshotPath = `/tmp/${siteKey}-error-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      result.details.screenshot = screenshotPath;
      console.log(`    Screenshot saved: ${screenshotPath}`);
    } catch (e) {
      // Ignore screenshot errors
    }
  } finally {
    await context.close();
  }

  return result;
}

// Main test runner
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        PAYWALLED SITE ACCESS TEST                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nMode: ${headful ? 'Headful (visible browser)' : 'Headless'}`);
  console.log(`Sites to test: ${siteFilter || 'all'}\n`);

  // Launch browser
  const browser = await chromium.launch({
    headless: !headful,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const results = [];
  const sitesToTest = siteFilter ? [siteFilter] : Object.keys(SITES);

  for (const siteKey of sitesToTest) {
    if (!SITES[siteKey]) {
      console.log(`\n⚠️ Unknown site: ${siteKey}`);
      continue;
    }

    const result = await testSite(browser, siteKey);
    results.push(result);
  }

  await browser.close();

  // Print summary
  console.log('\n\n');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    RESULTS SUMMARY                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  for (const r of results) {
    let status;
    if (!r.credentialsFound) {
      status = '❌ MISSING CREDENTIALS';
    } else if (!r.loginSuccess) {
      status = '❌ LOGIN FAILED';
    } else if (!r.articleAccess) {
      status = '⚠️  LOGIN OK, PAYWALL STILL ACTIVE';
    } else {
      status = '✅ FULLY WORKING';
    }

    console.log(`${r.site.padEnd(25)} ${status}`);
    if (r.error) {
      console.log(`${''.padEnd(25)} Error: ${r.error}`);
    }
    if (r.details.accessError) {
      console.log(`${''.padEnd(25)} Access issue: ${r.details.accessError}`);
    }
  }

  // Exit with error if any site failed completely
  const anyFailed = results.some(r => !r.credentialsFound || !r.loginSuccess);
  if (anyFailed) {
    console.log('\n⚠️ Some sites need attention - see details above');
  }

  // Return results for programmatic use
  return results;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
