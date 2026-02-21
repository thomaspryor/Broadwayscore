#!/usr/bin/env node
/**
 * Paywall Browser Login — Persistent Profile Approach
 *
 * Opens a headed Playwright browser with a PERSISTENT profile directory.
 * User logs in manually. Session cookies persist across script runs so
 * future extraction scripts can access paywalled content without re-login.
 *
 * This is the same approach proven for newspapers.com (see memory/newspapers-com-pipeline.md).
 * Key advantage over cookie injection: no expiry, no DataDome fingerprint mismatch.
 *
 * Usage:
 *   node scripts/paywall-browser-login.js --site=nyt
 *   node scripts/paywall-browser-login.js --site=wsj
 *   node scripts/paywall-browser-login.js --site=bloomberg
 *   node scripts/paywall-browser-login.js --site=newspapers   # newspapers.com
 *
 * After login:
 *   node scripts/paywall-browser-extract.js --site=nyt --url=URL
 *
 * Profile directories: /tmp/{site}-browser-profile/
 * Profiles persist until /tmp is cleared (typically on reboot).
 */

const readline = require('readline');

const SITES = {
  nyt: {
    name: 'New York Times',
    loginUrl: 'https://myaccount.nytimes.com/auth/login',
    testUrl: 'https://www.nytimes.com/',
    profileDir: '/tmp/nyt-browser-profile',
  },
  wsj: {
    name: 'Wall Street Journal',
    loginUrl: 'https://accounts.wsj.com/login',
    testUrl: 'https://www.wsj.com/',
    profileDir: '/tmp/wsj-browser-profile',
  },
  bloomberg: {
    name: 'Bloomberg',
    loginUrl: 'https://www.bloomberg.com/account/signin',
    testUrl: 'https://www.bloomberg.com/',
    profileDir: '/tmp/bloomberg-browser-profile',
  },
  newspapers: {
    name: 'Newspapers.com',
    loginUrl: 'https://www.newspapers.com/signin/',
    testUrl: 'https://www.newspapers.com/',
    profileDir: '/tmp/newspapers-browser-profile',
  },
};

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
  const args = process.argv.slice(2);
  const siteArg = args.find(a => a.startsWith('--site='))?.split('=')[1];

  if (!siteArg || !SITES[siteArg]) {
    console.error('Usage: node scripts/paywall-browser-login.js --site=SITE');
    console.error('');
    console.error('Available sites:');
    for (const [key, site] of Object.entries(SITES)) {
      console.error(`  ${key.padEnd(12)} — ${site.name}`);
    }
    process.exit(1);
  }

  const site = SITES[siteArg];
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Paywall Browser Login: ${site.name}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Profile: ${site.profileDir}`);

  const { chromium } = require('playwright');

  console.log('\nLaunching browser (headed mode — do NOT close it)...');
  const context = await chromium.launchPersistentContext(site.profileDir, {
    headless: false,
    viewport: { width: 1200, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  const page = context.pages()[0] || await context.newPage();

  // Check if already logged in by visiting the test URL first
  console.log(`\nChecking if already logged in...`);
  await page.goto(site.testUrl, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  console.log(`\nNavigating to login page: ${site.loginUrl}`);
  await page.goto(site.loginUrl, { timeout: 30000 }).catch(() => {});

  console.log(`\n${'='.repeat(50)}`);
  console.log('LOG IN TO THE SITE IN THE BROWSER WINDOW.');
  console.log('');
  console.log('If you are ALREADY logged in, just press Enter.');
  console.log(`${'='.repeat(50)}\n`);

  await prompt('Press Enter after logging in... ');

  // Navigate to test URL to confirm login worked
  console.log(`\nVerifying login — navigating to ${site.testUrl}...`);
  await page.goto(site.testUrl, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Get cookies count as confirmation
  const cookies = await context.cookies();
  const siteCookies = cookies.filter(c => {
    const domain = c.domain.replace(/^\./, '');
    const siteDomain = new URL(site.testUrl).hostname.replace(/^www\./, '');
    return domain.includes(siteDomain) || siteDomain.includes(domain);
  });

  console.log(`\n✓ Session saved to ${site.profileDir}`);
  console.log(`  ${siteCookies.length} cookies stored for ${site.name}`);
  console.log(`\nYou can now close this browser. The profile persists.`);
  console.log(`\nNext step — extract a review:`);
  console.log(`  node scripts/paywall-browser-extract.js --site=${siteArg} --url=ARTICLE_URL`);

  await prompt('\nPress Enter to close browser... ');
  await context.close();
  console.log('Done.');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
