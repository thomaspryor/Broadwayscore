import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

// Use createRequire to import CommonJS module
const require = createRequire(import.meta.url);
const {
  getSiteConfig,
  getFailedFetches,
  clearFailedFetches,
  SITE_CONFIGS,
  extractContent,
} = require('../../scripts/lib/trade-press-scraper.js');

// ============================================================================
// SITE_CONFIGS Tests
// ============================================================================

describe('SITE_CONFIGS', () => {
  test('has required free sites configured', () => {
    const freeSites = ['deadline.com', 'variety.com', 'playbill.com', 'broadwayjournal.com', 'forbes.com'];
    for (const site of freeSites) {
      assert.ok(SITE_CONFIGS[site], `Missing config for ${site}`);
    }
  });

  test('has required paywalled sites configured', () => {
    const paywalledSites = ['nytimes.com', 'vulture.com'];
    for (const site of paywalledSites) {
      assert.ok(SITE_CONFIGS[site], `Missing config for ${site}`);
    }
  });

  test('each config has required fields', () => {
    for (const [key, config] of Object.entries(SITE_CONFIGS)) {
      // Required fields
      assert.ok(config.domain, `${key}: missing domain`);
      assert.ok(config.selectors, `${key}: missing selectors`);
      assert.ok(config.selectors.title, `${key}: missing selectors.title`);
      assert.ok(config.selectors.body, `${key}: missing selectors.body`);
      assert.ok(config.selectors.date, `${key}: missing selectors.date`);
      assert.ok(config.strategy, `${key}: missing strategy`);
      assert.strictEqual(typeof config.requiresAuth, 'boolean', `${key}: requiresAuth must be boolean`);
    }
  });

  test('paywalled sites have auth configuration', () => {
    for (const [key, config] of Object.entries(SITE_CONFIGS)) {
      if (config.requiresAuth) {
        assert.ok(config.loginUrl, `${key}: missing loginUrl for paywalled site`);
        assert.ok(config.credentialEnvVars, `${key}: missing credentialEnvVars for paywalled site`);
        assert.ok(config.credentialEnvVars.email, `${key}: missing credentialEnvVars.email`);
        assert.ok(config.credentialEnvVars.password, `${key}: missing credentialEnvVars.password`);
      }
    }
  });

  test('free sites do not require auth', () => {
    const freeSites = ['deadline.com', 'variety.com', 'playbill.com', 'broadwayjournal.com', 'forbes.com'];
    for (const site of freeSites) {
      assert.strictEqual(SITE_CONFIGS[site].requiresAuth, false, `${site} should not require auth`);
    }
  });

  test('strategy is valid', () => {
    const validStrategies = ['standard', 'api', 'playwright'];
    for (const [key, config] of Object.entries(SITE_CONFIGS)) {
      assert.ok(
        validStrategies.includes(config.strategy),
        `${key}: invalid strategy '${config.strategy}'`
      );
    }
  });
});

// ============================================================================
// getSiteConfig Tests
// ============================================================================

describe('getSiteConfig', () => {
  test('returns correct config for deadline.com URL', () => {
    const config = getSiteConfig('https://deadline.com/2024/01/broadway-grosses/');
    assert.ok(config);
    assert.strictEqual(config.domain, 'deadline.com');
    assert.strictEqual(config.requiresAuth, false);
  });

  test('returns correct config for variety.com URL', () => {
    const config = getSiteConfig('https://variety.com/2024/legit/news/broadway-news/');
    assert.ok(config);
    assert.strictEqual(config.domain, 'variety.com');
    assert.strictEqual(config.requiresAuth, false);
  });

  test('returns correct config for playbill.com URL', () => {
    const config = getSiteConfig('https://playbill.com/article/broadway-article');
    assert.ok(config);
    assert.strictEqual(config.domain, 'playbill.com');
  });

  test('returns correct config for nytimes.com URL', () => {
    const config = getSiteConfig('https://www.nytimes.com/2024/01/15/theater/broadway-review.html');
    assert.ok(config);
    assert.strictEqual(config.domain, 'nytimes.com');
    assert.strictEqual(config.requiresAuth, true);
    assert.ok(config.loginUrl);
    assert.ok(config.credentialEnvVars);
  });

  test('returns correct config for vulture.com URL', () => {
    const config = getSiteConfig('https://www.vulture.com/article/theater-review.html');
    assert.ok(config);
    assert.strictEqual(config.domain, 'vulture.com');
    assert.strictEqual(config.requiresAuth, true);
  });

  test('returns null for unknown domain', () => {
    const config = getSiteConfig('https://unknownsite.com/article');
    assert.strictEqual(config, null);
  });

  test('handles URL with www prefix', () => {
    const config = getSiteConfig('https://www.deadline.com/2024/01/article/');
    assert.ok(config);
    assert.strictEqual(config.domain, 'deadline.com');
  });

  test('is case-insensitive', () => {
    const config = getSiteConfig('https://DEADLINE.COM/article/');
    assert.ok(config);
    assert.strictEqual(config.domain, 'deadline.com');
  });

  test('includes key in returned config', () => {
    const config = getSiteConfig('https://deadline.com/article');
    assert.ok(config.key);
    assert.strictEqual(config.key, 'deadline.com');
  });
});

// ============================================================================
// extractContent Tests
// ============================================================================

describe('extractContent', () => {
  test('extracts title from simple HTML', () => {
    const html = `
      <html>
        <head><title>Page Title</title></head>
        <body>
          <h1 class="entry-title">Article Title</h1>
          <div class="entry-content">
            <p>This is the article body with enough content to pass the minimum length check for the test.</p>
          </div>
        </body>
      </html>
    `;
    const selectors = {
      title: 'h1.entry-title',
      body: '.entry-content',
      date: 'time[datetime]',
    };
    const result = extractContent(html, selectors);
    assert.strictEqual(result.title, 'Article Title');
  });

  test('extracts body content from paragraphs', () => {
    const html = `
      <html>
        <body>
          <article class="content">
            <p>First paragraph with enough content to be captured by the extraction logic.</p>
            <p>Second paragraph that also has sufficient length to be included in the result.</p>
          </article>
        </body>
      </html>
    `;
    const selectors = {
      title: 'h1',
      body: 'article.content',
      date: 'time',
    };
    const result = extractContent(html, selectors);
    assert.ok(result.body);
    assert.ok(result.body.includes('First paragraph'));
    assert.ok(result.body.includes('Second paragraph'));
  });

  test('extracts date from datetime attribute', () => {
    const html = `
      <html>
        <body>
          <time datetime="2024-01-15T10:00:00Z">January 15, 2024</time>
        </body>
      </html>
    `;
    const selectors = {
      title: 'h1',
      body: 'article',
      date: 'time[datetime]',
    };
    const result = extractContent(html, selectors);
    assert.strictEqual(result.publishDate, '2024-01-15T10:00:00Z');
  });

  test('extracts date from meta tag content attribute', () => {
    const html = `
      <html>
        <head>
          <meta property="article:published_time" content="2024-01-15T10:00:00Z">
        </head>
        <body></body>
      </html>
    `;
    const selectors = {
      title: 'h1',
      body: 'article',
      date: 'meta[property="article:published_time"]',
    };
    const result = extractContent(html, selectors);
    assert.strictEqual(result.publishDate, '2024-01-15T10:00:00Z');
  });

  test('tries multiple selectors in comma-separated list', () => {
    const html = `
      <html>
        <body>
          <h1 class="post-title">Fallback Title</h1>
          <div class="article-body">
            <p>Content that should be captured using the fallback selector in the list.</p>
          </div>
        </body>
      </html>
    `;
    const selectors = {
      title: 'h1.entry-title, h1.post-title',
      body: '.entry-content, .article-body',
      date: 'time',
    };
    const result = extractContent(html, selectors);
    assert.strictEqual(result.title, 'Fallback Title');
    assert.ok(result.body.includes('Content'));
  });

  test('handles missing elements gracefully', () => {
    const html = '<html><body><p>Just some text</p></body></html>';
    const selectors = {
      title: 'h1.nonexistent',
      body: '.nonexistent',
      date: 'time',
    };
    const result = extractContent(html, selectors);
    assert.strictEqual(result.title, null);
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.publishDate, null);
  });

  test('cleans up body text by removing extra whitespace', () => {
    const html = `
      <html>
        <body>
          <div class="content">
            <p>Text   with   extra    spaces   and sufficient length to be captured.</p>
          </div>
        </body>
      </html>
    `;
    const selectors = { title: 'h1', body: '.content', date: 'time' };
    const result = extractContent(html, selectors);
    assert.ok(result.body);
    assert.ok(!result.body.includes('   '), 'Multiple spaces should be collapsed');
  });
});

// ============================================================================
// Failed Fetches Tracking Tests
// ============================================================================

describe('getFailedFetches', () => {
  test('returns empty array initially', () => {
    clearFailedFetches();
    const failed = getFailedFetches();
    assert.ok(Array.isArray(failed));
    assert.strictEqual(failed.length, 0);
  });

  test('returns a copy, not the original array', () => {
    clearFailedFetches();
    const failed1 = getFailedFetches();
    const failed2 = getFailedFetches();
    assert.notStrictEqual(failed1, failed2);
  });
});

describe('clearFailedFetches', () => {
  test('clears the failed fetches array', () => {
    // Note: We can't easily add to failedFetches without calling scrapeTradeArticle
    // This test just verifies clearFailedFetches works
    clearFailedFetches();
    const failed = getFailedFetches();
    assert.strictEqual(failed.length, 0);
  });
});

// ============================================================================
// Edge Cases and Validation Tests
// ============================================================================

describe('Edge Cases', () => {
  test('getSiteConfig handles empty string', () => {
    const config = getSiteConfig('');
    assert.strictEqual(config, null);
  });

  test('getSiteConfig handles malformed URL', () => {
    const config = getSiteConfig('not-a-valid-url');
    assert.strictEqual(config, null);
  });

  test('SITE_CONFIGS nytimes has login selectors', () => {
    const config = SITE_CONFIGS['nytimes.com'];
    assert.ok(config.loginSelectors);
    assert.ok(config.loginSelectors.emailInput);
    assert.ok(config.loginSelectors.passwordInput);
    assert.ok(config.loginSelectors.loginSubmit);
  });

  test('all configs have at least 3 selector types', () => {
    for (const [key, config] of Object.entries(SITE_CONFIGS)) {
      const selectorCount = Object.keys(config.selectors).length;
      assert.ok(selectorCount >= 3, `${key}: should have at least 3 selectors, has ${selectorCount}`);
    }
  });

  test('total site count is 7', () => {
    const count = Object.keys(SITE_CONFIGS).length;
    assert.strictEqual(count, 7, `Expected 7 sites, got ${count}`);
  });
});
