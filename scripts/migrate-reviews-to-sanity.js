#!/usr/bin/env node
/**
 * One-shot migration: read content/reviews/*.md, transform to Sanity showReview docs,
 * write to the configured Sanity project.
 *
 * Usage:
 *   export SANITY_API_WRITE_TOKEN=skXXX...   (Editor or Developer role token)
 *   export NEXT_PUBLIC_SANITY_PROJECT_ID=fp1ft8k8
 *   export NEXT_PUBLIC_SANITY_DATASET=production
 *   node scripts/migrate-reviews-to-sanity.js [--dry-run]
 *
 * Idempotent: uses the markdown filename as the Sanity _id so re-runs UPDATE rather
 * than create duplicates. Safe to re-run after editing a markdown file.
 */
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { createClient } = require('@sanity/client');

const REVIEWS_DIR = path.join(process.cwd(), 'content', 'reviews');
const DRY_RUN = process.argv.includes('--dry-run');

const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET || 'production';
const token = process.env.SANITY_API_WRITE_TOKEN;

if (!projectId) {
  console.error('Missing NEXT_PUBLIC_SANITY_PROJECT_ID');
  process.exit(1);
}
if (!DRY_RUN && !token) {
  console.error('Missing SANITY_API_WRITE_TOKEN. Create one at sanity.io/manage → API → Tokens (Editor role).');
  process.exit(1);
}

const STRESS_TEST_HEADING = /^##\s+broadway\s+stress\s+test\s*$/im;

function splitStressTest(content) {
  const match = content.match(STRESS_TEST_HEADING);
  if (!match || match.index === undefined) return { body: content, stressTest: null };
  return {
    body: content.slice(0, match.index).trim(),
    stressTest: content.slice(match.index + match[0].length).trim() || null,
  };
}

/**
 * Markdown → Portable Text (block array).
 * Minimal converter handling: paragraphs, h2/h3, bold/italic, links, blockquotes.
 * For richer features (lists, images), edit in Studio post-migration.
 */
function mdToBlocks(md) {
  if (!md) return [];
  const blocks = [];
  const paragraphs = md.split(/\n{2,}/);

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    let style = 'normal';
    let text = trimmed;
    if (/^###\s+/.test(text)) {
      style = 'h3';
      text = text.replace(/^###\s+/, '');
    } else if (/^##\s+/.test(text)) {
      style = 'h2';
      text = text.replace(/^##\s+/, '');
    } else if (/^>\s+/.test(text)) {
      style = 'blockquote';
      text = text.replace(/^>\s+/gm, '').replace(/\n/g, ' ');
    } else {
      text = text.replace(/\n/g, ' ');
    }

    const { children, markDefs } = parseInline(text);
    blocks.push({
      _type: 'block',
      _key: randomKey(),
      style,
      markDefs,
      children,
    });
  }
  return blocks;
}

function randomKey() {
  return Math.random().toString(36).slice(2, 14);
}

function parseInline(text) {
  // Tokenize: links [text](url), bold **x**, italic *x* / _x_
  const children = [];
  const markDefs = [];
  let i = 0;
  let buf = '';
  let activeMarks = [];

  function flush() {
    if (buf) {
      children.push({ _type: 'span', _key: randomKey(), text: buf, marks: [...activeMarks] });
      buf = '';
    }
  }

  while (i < text.length) {
    // Link: [label](url)
    const linkMatch = text.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      flush();
      const linkKey = randomKey();
      markDefs.push({ _type: 'link', _key: linkKey, href: linkMatch[2] });
      children.push({
        _type: 'span',
        _key: randomKey(),
        text: linkMatch[1],
        marks: [linkKey],
      });
      i += linkMatch[0].length;
      continue;
    }

    // Bold: **x**
    if (text.slice(i, i + 2) === '**') {
      flush();
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        children.push({
          _type: 'span',
          _key: randomKey(),
          text: text.slice(i + 2, end),
          marks: ['strong'],
        });
        i = end + 2;
        continue;
      }
    }

    // Italic: *x* (single asterisk, not part of **)
    if (text[i] === '*' && text[i + 1] !== '*') {
      flush();
      const end = text.indexOf('*', i + 1);
      if (end !== -1) {
        children.push({
          _type: 'span',
          _key: randomKey(),
          text: text.slice(i + 1, end),
          marks: ['em'],
        });
        i = end + 1;
        continue;
      }
    }

    buf += text[i];
    i++;
  }
  flush();
  if (children.length === 0) {
    children.push({ _type: 'span', _key: randomKey(), text: '', marks: [] });
  }
  return { children, markDefs };
}

function buildDoc(file, raw) {
  const { data, content } = matter(raw);
  const slug = file.replace(/\.md$/, '');

  if (!data.title || !data.show || !data.venue || data.score === undefined || !data.publishDate) {
    throw new Error(`Missing required frontmatter in ${file}`);
  }

  const { body, stressTest } = splitStressTest(content);

  const doc = {
    _id: `showReview.${slug}`,
    _type: 'showReview',
    title: data.title,
    slug: { _type: 'slug', current: slug },
    show: data.show,
    showSlug: data.showSlug || undefined,
    venue: data.venue,
    score: Number(data.score),
    dateAttended: data.dateAttended || data.publishDate,
    publishDate: data.publishDate,
    body: mdToBlocks(body),
  };
  if (stressTest) {
    doc.stressTest = mdToBlocks(stressTest);
  }
  return doc;
}

async function main() {
  if (!fs.existsSync(REVIEWS_DIR)) {
    console.error(`No reviews directory: ${REVIEWS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(REVIEWS_DIR).filter(
    (f) => f.endsWith('.md') && !f.startsWith('_')
  );
  console.log(`Found ${files.length} review file(s): ${files.join(', ')}`);

  const docs = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(REVIEWS_DIR, file), 'utf8');
      docs.push(buildDoc(file, raw));
    } catch (err) {
      console.error(`SKIPPED ${file}: ${err.message}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: would upsert these documents:');
    for (const d of docs) {
      console.log(`  ${d._id} — ${d.title} (${d.score}/100, body=${d.body.length} blocks${d.stressTest ? `, stressTest=${d.stressTest.length} blocks` : ''})`);
    }
    return;
  }

  const client = createClient({
    projectId,
    dataset,
    apiVersion: '2024-10-01',
    token,
    useCdn: false,
  });

  let tx = client.transaction();
  for (const d of docs) {
    tx = tx.createOrReplace(d);
  }
  const result = await tx.commit();
  console.log(`\nUpserted ${result.results.length} document(s):`);
  for (const r of result.results) {
    console.log(`  ${r.operation}: ${r.id}`);
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
