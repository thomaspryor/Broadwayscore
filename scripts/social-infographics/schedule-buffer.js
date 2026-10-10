#!/usr/bin/env node
/**
 * Schedule all 16 social infographic posts to Buffer across 5 channels.
 * Posts 1-9: daily starting 2026-03-29
 * Posts 10-16: every other day
 * Time: 10am America/Denver (UTC-6 in spring/MDT)
 */

const https = require('https');
const captions = require('./captions.json');

const BUFFER_TOKEN = process.env.BUFFER_TOKEN;
if (!BUFFER_TOKEN) {
  console.error('BUFFER_TOKEN env var is required. Generate one in Buffer → Settings → API & Apps.');
  process.exit(1);
}
const BASE_URL = 'https://broadwayscorecard.com/og/social';

const CHANNELS = {
  instagram: { id: '69adf7f67be9f8b171375290', caption: 'long',  size: '4x5', metadata: { instagram: { type: 'post', shouldShareToFeed: true } } },
  threads:   { id: '69adf8167be9f8b1713752f6', caption: 'short', size: '4x5' },
  bluesky:   { id: '69adf8ac7be9f8b1713754bb', caption: 'short', size: '1x1' },
  twitter:   { id: '69adf9617be9f8b1713756d4', caption: 'short', size: '1x1' },
  facebook:  { id: '69adfb857be9f8b171375c63', caption: 'long',  size: '1x1', metadata: { facebook: { type: 'post' } } },
};

// Schedule: posts 1-9 daily, 10-16 every other day, at 10am MDT (UTC-6)
const SCHEDULE = [
  { postIdx: 0,  date: '2026-03-29' },
  { postIdx: 1,  date: '2026-03-30' },
  { postIdx: 2,  date: '2026-03-31' },
  { postIdx: 3,  date: '2026-04-01' },
  { postIdx: 4,  date: '2026-04-02' },
  { postIdx: 5,  date: '2026-04-03' },
  { postIdx: 6,  date: '2026-04-04' },
  { postIdx: 7,  date: '2026-04-05' },
  { postIdx: 8,  date: '2026-04-06' },
  { postIdx: 9,  date: '2026-04-08' },
  { postIdx: 10, date: '2026-04-10' },
  { postIdx: 11, date: '2026-04-12' },
  { postIdx: 12, date: '2026-04-14' },
  { postIdx: 13, date: '2026-04-16' },
  { postIdx: 14, date: '2026-04-18' },
  { postIdx: 15, date: '2026-04-20' },
];

function getImageUrl(post, size) {
  const file = post.file;
  if (size === '4x5') return `${BASE_URL}/${file}-4x5.png`;
  return `${BASE_URL}/${file}.png`;
}

function mpcCall(method, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: Date.now(),
      params: { name: method, arguments: args },
    });
    const req = https.request(
      {
        hostname: 'mcp.buffer.com',
        path: '/mcp',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${BUFFER_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          // Parse SSE data lines
          for (const line of data.split('\n')) {
            if (line.startsWith('data:')) {
              try {
                const d = JSON.parse(line.slice(5).trim());
                if (d.result) {
                  const content = d.result.content || [];
                  for (const c of content) {
                    if (c.type === 'text') {
                      try { return resolve(JSON.parse(c.text)); }
                      catch { return resolve(c.text); }
                    }
                  }
                  return resolve(d.result);
                }
                if (d.error) return reject(new Error(d.error.message));
              } catch {}
            }
          }
          reject(new Error('No valid response: ' + data.slice(0, 200)));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const posts = captions.posts;
  let scheduled = 0;
  let failed = 0;

  // --only=instagram,facebook to re-run specific platforms
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const onlyPlatforms = onlyArg ? onlyArg.split('=')[1].split(',') : null;
  const channelEntries = Object.entries(CHANNELS).filter(([p]) => !onlyPlatforms || onlyPlatforms.includes(p));

  console.log(`Scheduling ${SCHEDULE.length * channelEntries.length} posts total...\n`);

  for (const { postIdx, date } of SCHEDULE) {
    const post = posts[postIdx];
    const dueAt = `${date}T10:00:00-06:00`; // 10am MDT

    for (const [platform, ch] of channelEntries) {
      const text = post[ch.caption];
      const imageUrl = getImageUrl(post, ch.size);
      const label = `[${date}] ${post.title} → ${platform}`;

      try {
        const result = await mpcCall('create_post', {
          channelId: ch.id,
          schedulingType: 'automatic',
          mode: 'addToQueue',
          text,
          assets: {
            images: [
              {
                url: imageUrl,
                metadata: { altText: post.title },
              },
            ],
          },
          ...(ch.metadata ? { metadata: ch.metadata } : {}),
        });

        if (result?.error) throw new Error(result.error);
        const postId = result?.id || result?.data?.id || JSON.stringify(result).slice(0, 40);
        console.log(`✓ ${label} (${postId})`);
        scheduled++;
      } catch (err) {
        console.error(`✗ ${label}: ${err.message}`);
        failed++;
      }

      // Rate limit: 1s between calls to avoid 429s
      await sleep(1000);
    }

    console.log(''); // blank line between days
  }

  console.log(`\nDone: ${scheduled} scheduled, ${failed} failed.`);
}

main().catch(console.error);
