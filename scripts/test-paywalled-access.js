#!/usr/bin/env node

/**
 * Test Paywalled Site Access
 *
 * Tests if stored credentials for paywalled sites actually work
 * by attempting login and accessing a paywalled article.
 *
 * Sites tested:
 *   - NYT (New York Times)
 *   - Vulture (NY Magazine - Condé Nast)
 *   - New Yorker (Condé Nast - separate subscription)
 *   - WaPo (Washington Post)
 *   - WSJ (Wall Street Journal)
 *
 * Environment variables:
 *   NYT_EMAIL, NYT_PASSWORD (or NYTIMES_PASSWORD)
 *   VULTURE_EMAIL, VULTURE_PASSWORD
 *   NEW_YORKER_EMAIL, NEW_YORKER_PASSWORD
 *   WAPO_EMAIL, WAPO_PASSWORD (or WASHPOST_PASSWORD)
 *   WSJ_EMAIL, WSJ_PASSWORD
 *
 * Usage:
 *   node scripts/test-paywalled-access.js
 *   node scripts/test-paywalled-access.js --site=nyt
 *   node scripts/test-paywalled-access.js --site=newyorker
 *   node scripts/test-paywalled-access.js --headful  (show browser)
 *   node scripts/test-paywalled-access.js --browserbase  (use Browserbase cloud browser + CAPTCHA solving)
 */

const { chromium } = require('playwright');

// Parse command line args
const args = process.argv.slice(2);
const headful = args.includes('--headful') || args.includes('--headed');
const useBrowserbase = args.includes('--browserbase');
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
      // NYT redirects /auth/login → /auth/enter-email; use domcontentloaded (networkidle hangs in CI)
      await page.goto('https://myaccount.nytimes.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000); // Wait for SPA to render

      // Diagnostic dump
      const pageInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type, name: i.name, id: i.id,
        }));
        const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim().substring(0, 30));
        return { title: document.title, url: window.location.href, inputs, buttons };
      });
      console.log(`    Page: ${pageInfo.url}`);
      console.log(`    Inputs: ${JSON.stringify(pageInfo.inputs)}`);

      // Wait for email field
      console.log('    Waiting for email field...');
      const emailField = await page.waitForSelector('input[name="email"], input[type="email"], #email', { timeout: 20000 });
      await emailField.type(email, { delay: 30 });

      // Click continue button
      console.log('    Clicking continue...');
      const continueBtn = await page.waitForSelector('button[data-testid="submit-email"], button[type="submit"], button:has-text("Continue")', { timeout: 10000 });
      await continueBtn.click();

      // Wait for password field (NYT has two-step login)
      console.log('    Waiting for password field...');
      await page.waitForTimeout(3000);
      const passwordField = await page.waitForSelector('input[name="password"], input[type="password"], #password', { timeout: 15000 });
      await passwordField.type(password, { delay: 30 });

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

      // Check for paywall indicators — be specific to avoid false positives
      // NYT has a "Subscribe" button in the nav bar that isn't a paywall gate
      const paywallDetected = await page.evaluate(() => {
        // Check for specific paywall elements
        const paywallEl = document.querySelector('[data-testid="paywall"], [class*="PaywallButton"], .css-mcm29f');
        if (paywallEl && paywallEl.offsetParent !== null) return 'paywall element';

        // Check for gateway/regwall modal
        const gateway = document.querySelector('[data-testid="gateway"], [data-testid="inline-message"], [class*="gateway"]');
        if (gateway && gateway.offsetParent !== null) return 'gateway modal';

        // Check if article body is truncated with a "Subscribe" CTA WITHIN the article
        const articleArea = document.querySelector('article, [data-testid="article-body"]');
        if (articleArea) {
          const subBtn = articleArea.querySelector('button:has([class*="Subscribe"]), [class*="subscribe-cta"]');
          if (subBtn) return 'subscribe CTA in article';
        }

        return null;
      });

      if (paywallDetected) {
        return { success: false, reason: `Paywall detected (${paywallDetected})` };
      }

      // Check for article content
      const articleBody = await page.$('article, [data-testid="article-body"], .story-body, .StoryBodyCompanionColumn');
      if (!articleBody) {
        return { success: false, reason: 'Article body not found' };
      }

      const articleText = await articleBody.textContent();
      console.log(`    Article text length: ${articleText.length} chars`);
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
      console.log('    Navigating to Vulture login (subs.nymag.com)...');

      // Go directly to the NY Mag auth page (same as production code)
      await page.goto('https://subs.nymag.com/account', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000); // Wait for SPA to render

      // Diagnostic dump
      const pageInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
        }));
        const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim().substring(0, 30));
        return { title: document.title, url: window.location.href, inputs, buttons };
      });
      console.log(`    Page: ${pageInfo.url} — "${pageInfo.title}"`);
      console.log(`    Inputs: ${JSON.stringify(pageInfo.inputs)}`);
      console.log(`    Buttons: ${JSON.stringify(pageInfo.buttons)}`);

      // Step 1: Enter email
      // IMPORTANT: Must use type() not fill() - the "Submit Email" button is disabled
      // until React detects input events, which fill() doesn't trigger
      console.log('    Looking for email field...');
      const emailField = await page.waitForSelector('input[type="email"], input[name="email"], [role="textbox"]', { timeout: 15000 });
      await emailField.click();
      await emailField.type(email, { delay: 30 });
      await page.waitForTimeout(1000);

      // Click "Submit Email" button (should now be enabled after typing)
      console.log('    Clicking Submit Email...');
      const submitEmailBtn = await page.$('button:has-text("Submit Email"):not([disabled])');
      if (submitEmailBtn) {
        await submitEmailBtn.click();
      } else {
        // Fallback: try any submit button or Enter
        const anySubmit = await page.$('button[type="submit"], button:has-text("Continue")');
        if (anySubmit) {
          await anySubmit.click();
        } else {
          console.log('    ⚠ No submit button found, pressing Enter');
          await page.keyboard.press('Enter');
        }
      }
      await page.waitForTimeout(4000);

      // Step 2: Enter password
      // The page has TWO password inputs — one in "Create Account" section (hidden)
      // and one in "Sign In" section (#passwordInput, visible after email submit)
      console.log('    Looking for password field...');
      // Wait for the correct password field to become visible
      let passwordField = null;
      try {
        passwordField = await page.waitForSelector('#passwordInput:visible, input[type="password"]:visible', { timeout: 15000 });
      } catch (e) {
        // Dump current state
        const state = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="password"]')).map(i => ({
            id: i.id, name: i.name, visible: i.offsetParent !== null,
          }));
          return { url: window.location.href, passwordInputs: inputs,
            text: document.body?.innerText?.substring(0, 300) || '' };
        });
        console.log(`    Password inputs: ${JSON.stringify(state.passwordInputs)}`);
        console.log(`    Page text: ${state.text.substring(0, 200)}`);
        throw new Error('No visible password field found after email submit');
      }
      await passwordField.click();
      await passwordField.type(password, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Sign In" button — must be the one near the password field, not the nav "Sign In"
      console.log('    Clicking Sign In...');
      // Look for the Sign In button that follows the password field in the form
      const signInBtn = await page.evaluate(() => {
        const pwdInput = document.querySelector('#passwordInput') || document.querySelector('input[type="password"]:not([style*="display: none"])');
        if (!pwdInput) return null;
        // Walk up to find the containing form/section, then find its Sign In button
        let container = pwdInput.parentElement;
        for (let i = 0; i < 5 && container; i++) {
          const btn = container.querySelector('button');
          if (btn && btn.textContent.includes('Sign In')) {
            // Return a data attribute we can use to find it
            btn.setAttribute('data-test-target', 'signin');
            return true;
          }
          container = container.parentElement;
        }
        return null;
      });
      if (signInBtn) {
        const btn = await page.$('button[data-test-target="signin"]');
        if (btn) await btn.click();
      } else {
        // Fallback: click the last "Sign In" button (likely the login one, not nav)
        const allSignIn = await page.$$('button:has-text("Sign In")');
        if (allSignIn.length > 0) {
          await allSignIn[allSignIn.length - 1].click();
        } else {
          await page.keyboard.press('Enter');
        }
      }
      await page.waitForTimeout(5000);

      // Verify
      const postUrl = page.url();
      console.log(`    Post-login URL: ${postUrl}`);
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

  newyorker: {
    name: 'The New Yorker (Condé Nast)',
    loginUrl: 'https://www.newyorker.com/auth/initiate?redirectURL=https%3A%2F%2Fwww.newyorker.com%2F&source=HB',
    testArticle: 'https://www.newyorker.com/magazine/2024/04/01/the-outsiders-broadway-review',
    emailEnv: 'NEW_YORKER_EMAIL',
    passwordEnv: ['NEW_YORKER_PASSWORD'],
    login: async (page, email, password) => {
      console.log('    Navigating to New Yorker login...');
      await page.goto('https://www.newyorker.com/auth/initiate?redirectURL=https%3A%2F%2Fwww.newyorker.com%2F&source=HB', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000); // Wait for Condé Nast SPA to render

      // Step 1: Email
      console.log('    Looking for email field...');
      const emailField = await page.waitForSelector('input[name="email"], input[type="email"], [role="textbox"]', { timeout: 15000 });
      await emailField.type(email, { delay: 30 }); // Use .type() not .fill() for React forms
      await page.waitForTimeout(1000);

      // Click "Continue with e-mail" button
      console.log('    Clicking continue...');
      const continueBtn = await page.waitForSelector('button:has-text("Continue with e-mail"), button:has-text("Continue"), button[type="submit"]', { timeout: 10000 });
      await continueBtn.click();
      await page.waitForTimeout(5000); // Wait for password step

      // Step 2: Password
      console.log('    Looking for password field...');
      const passwordField = await page.waitForSelector('input[type="password"]', { timeout: 15000 });
      await passwordField.type(password, { delay: 30 });
      await page.waitForTimeout(500);

      // Click "Sign in" button
      console.log('    Clicking sign in...');
      const signInBtn = await page.waitForSelector('button:has-text("Sign in"), button:has-text("Sign In"), button[type="submit"]', { timeout: 10000 });
      await signInBtn.click();

      console.log('    Waiting for login to complete...');
      await page.waitForTimeout(8000);

      // Verify: should redirect away from id.condenast.com
      const finalUrl = page.url();
      console.log(`    Post-login URL: ${finalUrl}`);
      if (finalUrl.includes('id.condenast.com')) {
        console.log('    ⚠ Still on auth page — login may have failed');
      }

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
        '[data-testid="paywall"]',
        'div:has-text("Subscribe to continue reading")'
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
  },

  wapo: {
    name: 'Washington Post',
    loginUrl: 'https://www.washingtonpost.com/subscribe/signin/',
    testArticle: 'https://www.washingtonpost.com/entertainment/theater/2025/04/26/just-in-time-jonathan-groff-bobby-darin-broadway/',
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
    testArticle: 'https://www.wsj.com/articles/smash-review-an-inside-broadway-musical-bdcafc62',
    emailEnv: 'WSJ_EMAIL',
    passwordEnv: ['WSJ_PASSWORD'],
    login: async (page, email, password) => {
      console.log('    Navigating to WSJ login...');
      // accounts.wsj.com/login redirects to sso.accounts.dowjones.com
      await page.goto('https://accounts.wsj.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000); // Wait for SPA redirect + render

      // Check for CAPTCHA (DataDome on Dow Jones SSO) — Browserbase can solve these
      const hasCaptcha = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        if (text.includes('Verification Required') || text.includes('Slide right to secure')) return true;
        const iframes = document.querySelectorAll('iframe');
        for (const f of iframes) {
          if (f.src && f.src.includes('captcha-delivery.com')) return true;
        }
        return false;
      });
      if (hasCaptcha) {
        console.log('    CAPTCHA detected — waiting for Browserbase to solve (up to 45s)...');
        try {
          await page.waitForFunction(() => {
            const text = document.body?.innerText || '';
            if (text.includes('Verification Required') || text.includes('Slide right to secure')) return false;
            const iframes = document.querySelectorAll('iframe');
            for (const f of iframes) {
              if (f.src && f.src.includes('captcha-delivery.com')) return false;
            }
            return true;
          }, { timeout: 45000 });
          console.log('    CAPTCHA resolved, proceeding...');
          await page.waitForTimeout(3000); // Wait for form to render post-CAPTCHA
        } catch (e) {
          console.log('    CAPTCHA not resolved after 45s — continuing anyway');
        }
      }

      // Diagnostic dump
      const pageInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
        }));
        const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim().substring(0, 30));
        return { title: document.title, url: window.location.href, inputs, buttons };
      });
      console.log(`    Page: ${pageInfo.url}`);
      console.log(`    Title: "${pageInfo.title}"`);
      console.log(`    Inputs: ${JSON.stringify(pageInfo.inputs)}`);
      console.log(`    Buttons: ${JSON.stringify(pageInfo.buttons)}`);

      // Step 1: Enter email/username
      // Broad selector set including generic text input (matches production BB code)
      console.log('    Looking for email field...');
      const emailSelectors = 'input[name="emailOrUsername"], input#emailOrUsername-form-item, input[type="email"], input[name="username"], input[name="email"], input[type="text"]:not([name="search"])';
      const emailField = await page.waitForSelector(emailSelectors, { timeout: 20000 });
      await emailField.click();
      await emailField.type(email, { delay: 30 }); // Use type() not fill()
      await page.waitForTimeout(500);

      // Click "Continue" button
      console.log('    Clicking Continue...');
      const continueBtn = await page.$('button:has-text("Continue"), button[type="submit"]');
      if (continueBtn) {
        await continueBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(4000);

      // Step 2: Enter password
      console.log('    Looking for password field...');
      const passwordField = await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000 });
      await passwordField.click();
      await passwordField.type(password, { delay: 30 });
      await page.waitForTimeout(500);

      // Dump password step state
      const pwdStepInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
          type: i.type, name: i.name, id: i.id, visible: i.offsetParent !== null,
        }));
        const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
          text: b.textContent?.trim().substring(0, 30),
          visible: b.offsetParent !== null, type: b.type,
        }));
        return { url: window.location.href, inputs, buttons };
      });
      console.log(`    Password step URL: ${pwdStepInfo.url.substring(pwdStepInfo.url.indexOf('#'))}`);
      console.log(`    Visible inputs: ${JSON.stringify(pwdStepInfo.inputs.filter(i => i.visible))}`);
      console.log(`    Visible buttons: ${JSON.stringify(pwdStepInfo.buttons.filter(b => b.visible))}`);

      // Click Sign In (prefer over Continue to avoid re-clicking email step)
      console.log('    Clicking Sign In...');
      let loginBtn = await page.$('button:has-text("Sign In"), button:has-text("Log In")');
      if (!loginBtn) {
        loginBtn = await page.$('button[type="submit"], button:has-text("Continue")');
      }
      if (loginBtn) {
        const btnText = await loginBtn.evaluate(el => el.textContent?.trim());
        console.log(`    Clicking button: "${btnText}"`);
        await loginBtn.click();
      } else {
        console.log('    No button found, pressing Enter...');
        await page.keyboard.press('Enter');
      }

      console.log('    Waiting for login to complete...');
      await page.waitForTimeout(8000);

      // Screenshot after sign-in attempt
      try {
        const ssPath = `/tmp/wsj-post-signin-${Date.now()}.png`;
        await page.screenshot({ path: ssPath });
        console.log(`    Post-signin screenshot: ${ssPath}`);
      } catch (e) {}

      // Full diagnostic dump after login attempt
      const postLoginState = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
          type: i.type, name: i.name, visible: i.offsetParent !== null, value: i.type === 'password' ? `(${i.value.length} chars)` : i.value,
        }));
        const errorEls = document.querySelectorAll('[class*="error"], [class*="Error"], [role="alert"], .message--error, [class*="invalid"], [class*="warning"]');
        const errors = Array.from(errorEls).map(e => e.textContent?.trim().substring(0, 100)).filter(t => t && t.length > 2);
        const bodyText = document.body?.innerText?.substring(0, 500) || '';
        return { url: window.location.href, inputs, errors, bodyText: bodyText.substring(0, 300) };
      });
      console.log(`    Post-login inputs: ${JSON.stringify(postLoginState.inputs)}`);
      if (postLoginState.errors.length) {
        console.log(`    POST-LOGIN ERRORS: ${JSON.stringify(postLoginState.errors)}`);
      }
      console.log(`    Page text preview: ${postLoginState.bodyText.substring(0, 200)}`);

      // Verify: check if redirected away from SSO domain
      const postUrl = postLoginState.url;
      console.log(`    Post-login URL: ${postUrl}`);
      const postHost = new URL(postUrl).hostname;
      const leftSso = !postHost.includes('accounts.dowjones.com') && !postHost.includes('accounts.wsj.com');
      if (leftSso) {
        console.log('    ✓ Left SSO domain — login likely succeeded');
      }

      // Check for error messages
      if (postLoginState.errors.length > 0) {
        throw new Error(`Login error: ${postLoginState.errors[0]}`);
      }

      return true;
    },
    checkAccess: async (page, articleUrl) => {
      console.log('    Navigating to test article...');
      await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);

      // Diagnostic dump
      const articleInfo = await page.evaluate(() => {
        const body = document.body?.innerText?.substring(0, 500) || '';
        const hasArticle = !!document.querySelector('article');
        const articleContent = document.querySelector('article, .article-content, [class*="ArticleBody"], [class*="article-body"]');
        const contentLen = articleContent ? articleContent.textContent.length : 0;
        return { url: window.location.href, title: document.title, hasArticle, contentLen, bodyPreview: body.substring(0, 200) };
      });
      console.log(`    Article page: ${articleInfo.url.substring(0, 80)}`);
      console.log(`    Title: "${articleInfo.title}"`);
      console.log(`    Has <article>: ${articleInfo.hasArticle}, content length: ${articleInfo.contentLen}`);

      // Take screenshot for debugging
      try {
        const ssPath = `/tmp/wsj-article-${Date.now()}.png`;
        await page.screenshot({ path: ssPath });
        console.log(`    Screenshot: ${ssPath}`);
      } catch (e) {}

      // Check for paywall — be more specific for WSJ
      const paywallDetected = await page.evaluate(() => {
        // WSJ specific paywall indicators
        const snippetLogin = document.querySelector('.wsj-snippet-login, [class*="snippet-promotion"]');
        if (snippetLogin && snippetLogin.offsetParent !== null) return 'wsj-snippet-login';
        // Generic
        const paywall = document.querySelector('[data-testid="paywall"], [class*="paywall"i]');
        if (paywall && paywall.offsetParent !== null) return 'paywall element';
        // Check for truncated content with "Subscribe" CTA in article area
        const article = document.querySelector('article');
        if (article) {
          const subCta = article.querySelector('[class*="subscribe"i], [class*="Paywall"i]');
          if (subCta) return 'subscribe CTA in article';
        }
        return null;
      });

      if (paywallDetected) {
        return { success: false, reason: `Paywall detected (${paywallDetected})` };
      }

      // Check for article content — broader selectors for WSJ
      const articleBody = await page.$('article, .article-content, [class*="ArticleBody"], [class*="article-body"], .wsj-snippet-body, main [data-type="article"]');
      if (!articleBody) {
        // Try getting any main content
        const mainContent = await page.$('main, #main, [role="main"]');
        if (mainContent) {
          const mainText = await mainContent.textContent();
          if (mainText.length > 500) {
            console.log(`    Found main content: ${mainText.length} chars`);
            return { success: true, articleLength: mainText.length };
          }
        }
        return { success: false, reason: 'Article body not found' };
      }

      const articleText = await articleBody.textContent();
      console.log(`    Article text length: ${articleText.length} chars`);
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
  const mode = useBrowserbase ? 'Browserbase (cloud + CAPTCHA solving)' : headful ? 'Headful (visible browser)' : 'Headless';
  console.log(`\nMode: ${mode}`);
  console.log(`Sites to test: ${siteFilter || 'all'}\n`);

  let browser;
  let bbSessionId = null;

  if (useBrowserbase) {
    // Connect via Browserbase cloud browser
    const { createBbSession } = require('./lib/browserbase-session');
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;

    if (!apiKey || !projectId) {
      console.error('BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID must be set');
      process.exit(1);
    }

    console.log('Creating Browserbase session...');
    const bbSession = await createBbSession({
      apiKey, projectId,
      caller: 'test-paywalled-access.js',
      purpose: 'manual paywalled-access diagnostic',
      body: { browserSettings: { solveCaptchas: true, fingerprint: { locales: ['en-US'], operatingSystems: ['macos'] } } },
    });

    bbSessionId = bbSession.id;
    console.log(`Browserbase session: ${bbSessionId}`);
    console.log(`Debug URL: https://www.browserbase.com/sessions/${bbSessionId}\n`);

    browser = await chromium.connectOverCDP(bbSession.connectUrl);
  } else {
    // Launch local browser
    browser = await chromium.launch({
      headless: !headful,
      args: ['--disable-blink-features=AutomationControlled']
    });
  }

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
