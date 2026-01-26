# Formspree Setup Guide

This guide shows you how to set up Formspree for the feedback form. Formspree is a free service that handles form submissions without needing a backend.

## Why Formspree?

- ✅ **Free tier**: 50 submissions/month (plenty for feedback)
- ✅ **No backend needed**: Just HTML forms
- ✅ **Spam protection**: Built-in honeypot and reCAPTCHA
- ✅ **Email notifications**: Get notified of new submissions
- ✅ **API access**: Fetch submissions programmatically

## Step 1: Create Formspree Account

1. **Sign up**: Go to https://formspree.io/register
2. **Email verification**: Verify your email address
3. **Free plan**: Select the free plan (50 submissions/month)

## Step 2: Create a Form

1. **Dashboard**: Log in to https://formspree.io/forms
2. **New Form**: Click "New Form"
3. **Form Name**: Name it "Broadway Scorecard Feedback"
4. **Create**: Click "Create Form"

You'll get a **Form ID** that looks like: `abc123xyz`

## Step 3: Configure Form Settings

In the Formspree form settings:

### Email Notifications
- ✅ Enable email notifications
- Add your email: `thomas.pryor@gmail.com` (or preferred email)
- Subject line: `New Broadway Scorecard Feedback - {{category}}`

### Spam Protection
- ✅ Enable honeypot (already in form code)
- Optional: Enable reCAPTCHA for extra protection

### Response Settings
- After submission: Redirect to custom URL
- Redirect URL: `https://broadwayscorecard.vercel.app/feedback?success=true`

## Step 4: Add Form ID to Environment Variables

### For Local Development (Optional)

Create `.env.local` in project root:
```bash
NEXT_PUBLIC_FORMSPREE_ENDPOINT=https://formspree.io/f/abc123xyz
```

Replace `abc123xyz` with your actual Form ID.

### For Production (Vercel)

1. **Vercel Dashboard**: Go to https://vercel.com/thomaspryor/broadwayscore/settings/environment-variables
2. **Add Variable**:
   - Name: `NEXT_PUBLIC_FORMSPREE_ENDPOINT`
   - Value: `https://formspree.io/f/abc123xyz`
   - Environment: Production
3. **Save**: Click "Save"
4. **Redeploy**: Trigger a new deployment

## Step 5: Get API Token (for Weekly Digest)

To enable the automated weekly feedback digest:

1. **Settings**: In Formspree, go to Account Settings
2. **API Tokens**: Click "API Tokens"
3. **Generate Token**: Create a new token
4. **Copy Token**: Save it securely

### Add to GitHub Secrets

1. **GitHub**: Go to https://github.com/thomaspryor/Broadwayscore/settings/secrets/actions
2. **New Secret**:
   - Name: `FORMSPREE_TOKEN`
   - Value: Your API token
3. **Add Secret**: Save

## Step 6: Update Form ID in Script

Edit `scripts/process-feedback.js` and replace `YOUR_FORM_ID` with your actual Form ID:

```javascript
const response = await fetch(
  `https://formspree.io/api/0/forms/abc123xyz/submissions?since=${since}`,
  // Replace abc123xyz with your form ID
```

## Step 7: Test the Setup

### Test Form Submission

1. **Go to**: https://broadwayscorecard.vercel.app/feedback
2. **Fill in**: Category, message, etc.
3. **Submit**: Click "Send Feedback"
4. **Check**:
   - You should see a success message
   - Check your email for notification
   - Check Formspree dashboard for the submission

### Test Weekly Digest (Manual)

1. **GitHub Actions**: Go to https://github.com/thomaspryor/Broadwayscore/actions
2. **Select**: "Process Feedback Submissions"
3. **Run Workflow**: Click "Run workflow"
4. **Check**: A GitHub issue will be created with the feedback digest

## How It Works

### User Flow
1. User visits `/feedback` page
2. Fills out form and submits
3. Formspree receives submission
4. User gets confirmation
5. You get email notification

### Weekly Digest Flow
1. **Every Monday at 9 AM UTC**: GitHub Action runs
2. **Fetch**: Gets submissions from last 7 days via Formspree API
3. **Categorize**: Claude API analyzes and categorizes feedback
4. **Create Issue**: Posts summary as GitHub issue
5. **Email**: GitHub notifies you about the new issue

## Feedback Categories

The AI automatically categorizes feedback into:

- **Bug**: Something not working correctly
- **Feature Request**: Ideas for new features
- **Content Error**: Wrong show data or scores
- **Praise**: Positive feedback
- **Other**: General feedback

Each gets a **priority** (High/Medium/Low) and a **recommended action**.

## Monitoring Feedback

### Formspree Dashboard
- View all submissions: https://formspree.io/forms
- Export data as CSV
- See submission trends

### GitHub Issues
- Weekly digests: Search for label `feedback-digest`
- All feedback summaries in one place
- Comment and discuss with team

### Email Notifications
- Instant notification when someone submits feedback
- Includes all form fields
- Reply directly if email provided

## Costs

### Formspree Free Tier
- 50 submissions/month
- Unlimited forms
- Email notifications
- API access

**If you exceed 50/month**: Upgrade to Paid plan ($10/month for 1000 submissions)

### Alternative: GitHub Issues Only

Don't want to use Formspree? You can use GitHub Issues directly:

1. Remove Formspree form
2. Add link to: https://github.com/thomaspryor/Broadwayscore/issues/new
3. Users create issues directly
4. No external service needed

## Troubleshooting

### Form not submitting
- Check `NEXT_PUBLIC_FORMSPREE_ENDPOINT` environment variable
- Verify Form ID is correct
- Check browser console for errors

### Not receiving emails
- Check Formspree form settings
- Verify email notification is enabled
- Check spam folder

### Weekly digest not running
- Check `FORMSPREE_TOKEN` secret is set
- Verify API token has correct permissions
- Check GitHub Actions logs for errors

### API rate limits
- Free tier: 100 requests/month
- Requests reset monthly
- Upgrade if needed

## Support

- **Formspree Docs**: https://help.formspree.io/
- **Formspree Support**: support@formspree.io
- **This Project**: Open an issue on GitHub

---

Once set up, the feedback system runs automatically with no maintenance required!
