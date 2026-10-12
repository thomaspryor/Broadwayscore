#!/usr/bin/env node
/**
 * Run real Theatr screenshots through the whole Theatr import, offline:
 * the live function's exact model request (supabase/functions/
 * theatr-screenshot-import/prompt.mjs), its validation (normalize.mjs), and
 * the client pipeline the site runs (overlapping batches, feed dates,
 * backfill days, merge, reaction ratings; src/lib/show-import.ts). Prints the
 * rows the import preview would show. Nothing is written anywhere.
 *
 * Why: the model step cannot be unit-tested, and the deployed function needs
 * a signed-in user. This is how a prompt change, or a new Theatr screen
 * layout, gets checked against real screenshots before it ships (BRO-5082).
 *
 * Usage (needs ANTHROPIC_API_KEY; screenshots in scroll order, top first):
 *   npx tsx scripts/theatr-import-smoke.mjs shot1.png shot2.png ...
 *   npx tsx scripts/theatr-import-smoke.mjs --json shots/*.png   # raw rows too
 *
 * Costs one model call per batch of up to 6 screenshots.
 */
import path from 'node:path';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { MODEL, SYSTEM_PROMPT, OUTPUT_SCHEMA } from '../supabase/functions/theatr-screenshot-import/prompt.mjs';
import { normalizeExtraction, MAX_IMAGES_PER_CALL } from '../supabase/functions/theatr-screenshot-import/normalize.mjs';
import {
  overlapBatches,
  theatrRowsPipeline,
  theatrNotices,
  effectiveRating,
  DEFAULT_REACTION_RATINGS,
  REACTION_LABELS,
} from '../src/lib/show-import.ts';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npx tsx scripts/theatr-import-smoke.mjs [--json] <screenshot> [...]  (needs ANTHROPIC_API_KEY)');
  process.exit(0);
}
const showJson = args.includes('--json');
const files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('Give at least one screenshot path. --help for usage.');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set.');
  process.exit(2);
}

/** Same downscale as the clients: long edge 1568px, JPEG 0.85. */
async function toImage(file) {
  const buf = await sharp(file).resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { mediaType: 'image/jpeg', data: buf.toString('base64') };
}

const client = new Anthropic();
const today = new Date().toISOString().slice(0, 10);
const batches = overlapBatches(files.map((_, i) => i), MAX_IMAGES_PER_CALL);
const rowsByBatch = [];

for (const [b, batch] of batches.entries()) {
  const images = await Promise.all(batch.map((i) => toImage(files[i])));
  const content = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }));
  content.push({ type: 'text', text: `List every show on ${images.length === 1 ? 'this screenshot' : `these ${images.length} screenshots`}.` });
  const started = Date.now();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  const text = res.content.find((c) => c.type === 'text');
  if (res.stop_reason !== 'end_turn' || !text) {
    console.error(`batch ${b + 1}: stop_reason=${res.stop_reason}`);
    process.exit(1);
  }
  const extraction = JSON.parse(text.text);
  const { entries, dropped } = normalizeExtraction(extraction, today);
  rowsByBatch.push(entries);
  console.log(`batch ${b + 1}/${batches.length}: ${batch.map((i) => path.basename(files[i])).join(', ')} → ${entries.length} rows, ${dropped} dropped, unreadable ${extraction.unreadable_images} (${((Date.now() - started) / 1000).toFixed(1)}s, ${res.usage.input_tokens} in / ${res.usage.output_tokens} out)`);
  if (showJson) console.log(JSON.stringify(entries, null, 1));
}

const { entries, feedDates, backfillDropped } = theatrRowsPipeline(rowsByBatch, today);
console.log(`\n${entries.length} import rows (today=${today}):`);
for (const e of entries) {
  const rating = effectiveRating(e.rating, e.reaction, DEFAULT_REACTION_RATINGS);
  const how = e.rating != null ? `score ${e.sourceScore} → ★${e.rating}` : e.reaction ? `${REACTION_LABELS[e.reaction]} → ★${rating}` : 'unrated';
  const review = e.reviewText ? ` | review ${e.reviewText.length} chars` : '';
  console.log(`  ${e.kind === 'diary' ? 'SEEN    ' : 'WANT    '} ${e.title}${e.venue ? ` (${e.venue})` : ''} | ${e.date || 'no date'} | ${e.kind === 'diary' ? how : ''}${review}`);
}
console.log('\nNotices:');
for (const n of theatrNotices(entries, { picked: files.length, failedScreenshots: 0, unreadable: 0, feedDates, backfillDropped })) console.log(`  - ${n}`);
