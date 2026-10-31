// BRO-6692: The Reviews Hub pages had no extractor pattern, so every ingest returned 0 chars.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractArticleTextFromUrl } = require('./article-extractor.js');

const body = 'A well-worn trope: vastly different characters thrown together by chance. '.repeat(6);
const page = `<html><nav>Menu chrome</nav><div class="post-content cf entry-content content-spacious"><p>Writer: A Writer</p><p>${body}</p><p>Runs until 8 February 2025</p></div><div class="the-post-tags">Tags: Birmingham</div><div class="author-box">About the author</div><div class="related-posts">Other reviews</div></html>`;

test('extracts the review body and stops before tags, author box and related posts', () => {
  const t = extractArticleTextFromUrl(page, 'https://www.thereviewshub.com/community-birmingham-rep/');
  assert.match(t, /Writer: A Writer/);
  assert.match(t, /Runs until 8 February 2025/);
  assert.doesNotMatch(t, /Menu chrome|Tags: Birmingham|About the author|Other reviews/);
});

test('real fetched page extracts a full review when the sample is on disk', async () => {
  const fs = await import('node:fs');
  const f = process.env.TRH_SAMPLE;
  if (!f || !fs.existsSync(f)) return;
  const t = extractArticleTextFromUrl(fs.readFileSync(f, 'utf8'), 'https://www.thereviewshub.com/community-birmingham-rep/');
  assert.ok(t.length > 1500, `got ${t.length} chars`);
});
