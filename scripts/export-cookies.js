#!/usr/bin/env node
/**
 * Export Cookies Helper
 *
 * Launches a headful Playwright browser, navigates to a site,
 * waits for the user to log in manually, then exports all cookies
 * for that domain in Playwright-compatible format.
 *
 * Usage:
 *   node scripts/export-cookies.js --domain=wsj.com
 *   node scripts/export-cookies.js --domain=newyorker.com
 *   node scripts/export-cookies.js --domain=nytimes.com
 *   node scripts/export-cookies.js --domain=vulture.com
 *   node scripts/export-cookies.js --domain=washingtonpost.com
 *
 * Output:
 *   - Saves to data/cookies/{domain-key}.json (for local testing)
 *   - Prints base64-encoded version (for pasting into GitHub Secrets)
 *
 * The cookie file format is compatible with Playwright's context.addCookies().
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Parse CLI args
const args = process.argv.slice(2);
const domainArg = args.find(a => a.startsWith('--domain='))?.split('=')[1];

if (!domainArg) {
  console.error('Usage: node scripts/export-cookies.js --domain=wsj.com');
  console.error('');
  console.error('Supported domains:');
  console.error('  wsj.com, newyorker.com, nytimes.com, vulture.com, washingtonpost.com');
  process.exit(1);
}

// Map domains to their login URLs and file keys
const DOMAIN_CONFIG = {
  'wsj.com': {
    fileKey: 'wsj',
    envVar: 'WSJ_COOKIES',
    loginUrl: 'https://accounts.wsj.com/login',
    siteUrl: 'https://www.wsj.com',
  },
  'newyorker.com': {
    fileKey: 'newyorker',
    envVar: 'NEWYORKER_COOKIES',
    loginUrl: 'https://www.newyorker.com/auth/initiate?redirectURL=https%3A%2F%2Fwww.newyorker.com%2F&source=HB',
    siteUrl: 'https://www.newyorker.com',
  },
  'nytimes.com': {
    fileKey: 'nytimes',
    envVar: 'NYT_COOKIES',
    loginUrl: 'https://myaccount.nytimes.com/auth/login',
    siteUrl: 'https://www.nytimes.com',
  },
  'vulture.com': {
    fileKey: 'vulture',
    envVar: 'VULTURE_COOKIES',
    loginUrl: 'https://subs.nymag.com/account',
    siteUrl: 'https://www.vulture.com',
  },
  'washingtonpost.com': {
    fileKey: 'wapo',
    envVar: 'WAPO_COOKIES',
    loginUrl: 'https://www.washingtonpost.com/subscribe/signin/',
    siteUrl: 'https://www.washingtonpost.com',
  },
};

const domainConfig = DOMAIN_CONFIG[domainArg];
if (!domainConfig) {
  console.error(`Unsupported domain: ${domainArg}`);
  console.error('Supported: ' + Object.keys(DOMAIN_CONFIG).join(', '));
  process.exit(1);
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log(`\nCookie Export Tool for ${domainArg}`);
  console.log('='.repeat(50));

  // Load Playwright
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    console.error('Playwright is required. Install with: npm install playwright');
    process.exit(1);
  }

  console.log('\nLaunching browser (headful mode)...');
  console.log('A browser window will open. Please log in to the site manually.\n');

  const browser = await playwright.chromium.launch({
    headless: false, // Headful so user can interact
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  const page = await context.newPage();

  // Navigate to the login page
  console.log(`Navigating to: ${domainConfig.loginUrl}`);
  await page.goto(domainConfig.loginUrl, { timeout: 60000 }).catch(() => {});

  console.log('\n' + '='.repeat(50));
  console.log('LOG IN TO THE SITE IN THE BROWSER WINDOW.');
  console.log('Once you are logged in and can see content,');
  console.log('come back here and press Enter.');
  console.log('='.repeat(50) + '\n');

  await prompt('Press Enter after logging in... ');

  // Navigate to the main site to ensure all cookies are set
  console.log(`\nNavigating to ${domainConfig.siteUrl} to capture final cookies...`);
  await page.goto(domainConfig.siteUrl, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Extract all cookies
  const allCookies = await context.cookies();

  // Filter to cookies relevant to this domain
  const domainCookies = allCookies.filter(c => {
    const cookieDomain = c.domain.replace(/^\./, '');
    return cookieDomain === domainArg ||
           cookieDomain.endsWith('.' + domainArg) ||
           domainArg.endsWith('.' + cookieDomain);
  });

  console.log(`\nExtracted ${domainCookies.length} cookies for ${domainArg} (${allCookies.length} total)`);

  if (domainCookies.length === 0) {
    console.error('No cookies found for this domain. Are you sure you logged in?');
    await browser.close();
    process.exit(1);
  }

  // Format cookies for Playwright compatibility
  const formattedCookies = domainCookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    ...(c.expires > 0 ? { expires: c.expires } : {}),
  }));

  // Save to local file
  const cookiesDir = path.join('data', 'cookies');
  if (!fs.existsSync(cookiesDir)) {
    fs.mkdirSync(cookiesDir, { recursive: true });
  }
  const filePath = path.join(cookiesDir, `${domainConfig.fileKey}.json`);
  fs.writeFileSync(filePath, JSON.stringify(formattedCookies, null, 2) + '\n');
  console.log(`\nSaved to: ${filePath}`);

  // Generate base64 for GitHub Secrets
  const base64 = Buffer.from(JSON.stringify(formattedCookies)).toString('base64');

  console.log('\n' + '='.repeat(50));
  console.log(`GitHub Secret name: ${domainConfig.envVar}`);
  console.log('='.repeat(50));
  console.log('\nBase64-encoded value (copy this into GitHub Secrets):');
  console.log('\n' + base64);
  console.log('\n' + '='.repeat(50));
  console.log(`\nTo set the GitHub Secret:`);
  console.log(`  gh secret set ${domainConfig.envVar} --body "${base64.length > 100 ? base64.substring(0, 50) + '...' : base64}"`);
  console.log(`\nOr paste the full base64 value above into:`);
  console.log(`  GitHub repo > Settings > Secrets > Actions > New repository secret`);
  console.log(`  Name: ${domainConfig.envVar}`);

  // List some key cookie names for verification
  const keyNames = formattedCookies.map(c => c.name).slice(0, 10);
  console.log(`\nKey cookies: ${keyNames.join(', ')}${formattedCookies.length > 10 ? '...' : ''}`);

  await browser.close();
  console.log('\nDone. Browser closed.');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
