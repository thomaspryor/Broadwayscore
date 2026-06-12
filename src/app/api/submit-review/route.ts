import { NextRequest, NextResponse } from 'next/server';

const GITHUB_REPO = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';
const GH_DISPATCH_TOKEN = process.env.GH_DISPATCH_TOKEN || '';

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown-source';
  }
}

function formatIssueTitle(reviewUrl: string, showName: string, outletName: string): string {
  const outlet = outletName || extractDomain(reviewUrl);
  const show = showName || 'Unknown Show';
  return `[Review Submission] ${outlet} review of ${show}`;
}

function formatIssueBody(
  reviewUrl: string,
  showName: string,
  outletName: string,
  criticName: string,
  notes: string
): string {
  return [
    '### Review URL',
    reviewUrl,
    '',
    '### Show Name',
    showName || '_No response_',
    '',
    '### Outlet Name',
    outletName || '_No response_',
    '',
    '### Critic Name',
    criticName || '_No response_',
    '',
    '### Additional Notes',
    notes || '_No response_',
    '',
    '---',
    '*Submitted via [broadwayscorecard.com/submit-review](https://broadwayscorecard.com/submit-review)*',
  ].join('\n');
}

async function createGitHubIssue(title: string, body: string): Promise<number | null> {
  const [owner, repo] = GITHUB_REPO.split('/');
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GH_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels: ['review-submission', 'needs-validation'] }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`GitHub issue creation failed: ${res.status} — ${err}`);
    return null;
  }
  const data = await res.json();
  return data.number as number;
}


export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const honeypot = (formData.get('_gotcha') as string) || '';
    if (honeypot) {
      return NextResponse.json({ ok: true }); // Silent for bots
    }

    const reviewUrl = ((formData.get('review_url') as string) || '').trim();
    if (!reviewUrl) {
      return NextResponse.json(
        { errors: [{ message: 'Review URL is required.' }] },
        { status: 400 }
      );
    }

    if (!GH_DISPATCH_TOKEN) {
      console.error('GH_DISPATCH_TOKEN not configured');
      return NextResponse.json(
        { errors: [{ message: 'Submission service unavailable. Please try again later.' }] },
        { status: 503 }
      );
    }

    const showName = ((formData.get('show_name') as string) || '').trim();
    const outletName = ((formData.get('outlet_name') as string) || '').trim();
    const criticName = ((formData.get('critic_name') as string) || '').trim();
    const notes = ((formData.get('notes') as string) || '').trim();

    const title = formatIssueTitle(reviewUrl, showName, outletName);
    const body = formatIssueBody(reviewUrl, showName, outletName, criticName, notes);

    const issueNumber = await createGitHubIssue(title, body);
    if (!issueNumber) {
      return NextResponse.json(
        { errors: [{ message: 'Failed to queue submission. Please try again.' }] },
        { status: 500 }
      );
    }

    // GH_DISPATCH_TOKEN is a PAT, so creating the issue fires the `issues` event
    // which triggers process-review-submission.yml directly — no manual dispatch needed.
    // (GITHUB_TOKEN would suppress the event, requiring explicit dispatch; PATs do not.)

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('submit-review error:', err);
    return NextResponse.json(
      { errors: [{ message: 'Something went wrong. Please try again.' }] },
      { status: 500 }
    );
  }
}
