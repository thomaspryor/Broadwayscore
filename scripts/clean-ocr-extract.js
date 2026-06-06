#!/usr/bin/env node
// Extract clean review text from newspapers.com OCR garble
// Replaces fullText with just the review portion, then standard scorer can handle it

const fs = require('fs');
const path = require('path');
const https = require('https');
const { safeWriteReview } = require('./lib/review-write-guard');
const { CLAUDE_SONNET } = require('./lib/models');

const envPath = path.join(__dirname, '..', '.env');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ||
  (fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').match(/ANTHROPIC_API_KEY=([^\n]+)/)?.[1] : null);

if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not found');
  process.exit(1);
}

const rtDir = path.join(__dirname, '..', 'data', 'review-texts');

function callClaude(prompt, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt + '\n\n' + text }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0]) {
            resolve(parsed.content[0].text);
          } else if (parsed.error) {
            reject(new Error(parsed.error.message));
          } else {
            reject(new Error('Unexpected response: ' + data.substring(0, 200)));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function extractReview(data) {
  const showName = data.showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
  
  const prompt = `You are extracting a THEATER REVIEW from OCR-scanned newspaper text.

The full OCR text below comes from a scanned newspaper page. It contains the actual review MIXED WITH adjacent articles, ads, movie listings, and other page content. This is normal for newspapers.com OCR extraction.

YOUR TASK: Extract ONLY the theater review text and return it as clean prose.

- The show being reviewed is: "${showName}"
- The newspaper is: ${data.outlet}
- The critic is likely: ${data.criticName}
- Find the section that is the theater review — it will discuss the show, performances, direction, etc.
- REMOVE all non-review content: other articles, ads, movie showtimes, weather, letters to the editor, etc.
- Clean up obvious OCR artifacts (broken words, missing spaces) where possible
- Preserve the critic's actual words — do NOT paraphrase or summarize
- Return the extracted review text as-is, with paragraph breaks preserved

If you CANNOT find a theater review in this text, respond with exactly: NO_REVIEW_FOUND

Return ONLY the extracted review text (or NO_REVIEW_FOUND). No preamble, no explanation.`;

  const textLimit = data.fullText.length > 12000 ? 10000 : data.fullText.length;
  const response = await callClaude(prompt, data.fullText.substring(0, textLimit));
  
  if (response.trim() === 'NO_REVIEW_FOUND') {
    return null;
  }
  
  // Basic validation: extracted text should be at least 200 chars
  if (response.trim().length < 200) {
    return null;
  }
  
  return response.trim();
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const limit = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '500');
  
  // Find all newspapers.com OCR files
  const toProcess = [];
  const dirs = fs.readdirSync(rtDir).filter(d => {
    try { return fs.statSync(path.join(rtDir, d)).isDirectory(); } catch { return false; }
  });

  for (const showDir of dirs) {
    const files = fs.readdirSync(path.join(rtDir, showDir)).filter(f => f.endsWith('-bway.json'));
    for (const f of files) {
      const filePath = path.join(rtDir, showDir, f);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      if (data.source !== 'newspapers-com-ocr') continue;
      if (!data.fullText || data.fullText.length < 200) continue;
      if (data.rejectedBy === 'manual-review') continue; // Skip manually rejected
      
      toProcess.push({ filePath, data, showDir, file: f });
    }
  }

  console.log(`Found ${toProcess.length} newspapers.com OCR files to clean (limit: ${limit})`);
  if (dryRun) {
    for (const item of toProcess.slice(0, 20)) {
      console.log(`  ${item.showDir}/${item.file} (${item.data.fullText.length} chars)`);
    }
    return;
  }

  let extracted = 0, noReview = 0, failed = 0;

  for (let i = 0; i < Math.min(toProcess.length, limit); i++) {
    const item = toProcess[i];
    process.stdout.write(`[${i+1}/${Math.min(toProcess.length, limit)}] ${item.showDir}/${item.data.outletId}... `);

    try {
      const cleanText = await extractReview(item.data);

      if (!cleanText) {
        console.log('NO REVIEW FOUND');
        // Mark as no-review so we don't keep retrying
        const fileData = JSON.parse(fs.readFileSync(item.filePath, 'utf8'));
        fileData.showNotMentioned = true;
        fileData.rejectedBy = 'ocr-extraction';
        fileData.rejectedReason = 'No theater review found in OCR text';
        // Remove any one-off scores
        delete fileData.assignedScore;
        delete fileData.llmScore;
        delete fileData.llmMetadata;
        safeWriteReview(item.filePath, fileData, { force: true });
        noReview++;
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      console.log(`EXTRACTED (${cleanText.length} chars from ${item.data.fullText.length})`);

      // Save: store original OCR as ocrFullText, put clean text in fullText
      const fileData = JSON.parse(fs.readFileSync(item.filePath, 'utf8'));
      fileData.ocrFullText = fileData.fullText; // Preserve original
      fileData.fullText = cleanText;
      fileData.ocrCleanedAt = new Date().toISOString();
      // Remove one-off scores so standard scorer handles it
      delete fileData.assignedScore;
      delete fileData.llmScore;
      delete fileData.llmMetadata;
      // Remove any rejection flags from earlier attempts
      delete fileData.rejectedBy;
      delete fileData.rejectedReason;
      delete fileData.showNotMentioned;
      safeWriteReview(item.filePath, fileData, { force: true });
      extracted++;

      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      failed++;
      if (e.message.includes('rate') || e.message.includes('overloaded')) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  console.log(`\nDone: ${extracted} extracted, ${noReview} no review found, ${failed} errors`);
  console.log(`Next step: run the standard ensemble scorer on these files.`);
}

main().catch(console.error);
