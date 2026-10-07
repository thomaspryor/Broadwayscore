import { Metadata } from 'next';
import Link from 'next/link';
import { BASE_URL } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Privacy Policy - Broadway Scorecard',
  description: 'Privacy policy for Broadway Scorecard website and mobile app.',
  alternates: { canonical: `${BASE_URL}/privacy` },
  openGraph: {
    title: 'Privacy Policy — Broadway Scorecard',
    description: 'Privacy policy for Broadway Scorecard website and mobile app.',
    url: `${BASE_URL}/privacy`,
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary',
    title: 'Privacy Policy — Broadway Scorecard',
    description: 'Privacy policy for Broadway Scorecard website and mobile app.',
  },
};

const h2 = 'text-xl font-bold text-white mb-3';
const h3 = 'text-base font-semibold text-white mb-1';
const linkClass = 'text-brand hover:underline';

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="text-center mb-10">
        <h1 className="text-4xl sm:text-5xl font-extrabold text-white">Privacy Policy</h1>
        <p className="text-gray-400 mt-3">Last updated: October 2, 2026</p>
      </div>

      <div className="card p-6 sm:p-8 space-y-6">
        <section>
          <h2 className={h2}>Overview</h2>
          <p className="text-gray-300">
            Broadway Scorecard (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) runs the website
            broadwayscorecard.com and the Broadway Scorecard iPhone app. This policy explains what we collect,
            why, who helps us process it, and how to delete it. You can read scores and reviews without an
            account. An account is only needed to rate shows and keep track of what you&apos;ve seen.
          </p>
        </section>

        <section>
          <h2 className={h2}>Your Account</h2>
          <div className="space-y-3 text-gray-300">
            <p>
              You can sign in with Google or Apple, or with an email address and password in the app. We store
              your email address, the name and profile photo your sign-in provider shares with us (we use these
              as your display name and photo), and an account ID.
            </p>
            <p>
              Signing in on the website also adds your email address to our show alert emails (opening nights,
              new reviews and similar news). Every email has an unsubscribe link, and unsubscribing doesn&apos;t
              affect your account.
            </p>
          </div>
        </section>

        <section>
          <h2 className={h2}>What You Save</h2>
          <div className="space-y-4 text-gray-300">
            <div>
              <h3 className={h3}>Ratings, reviews and history</h3>
              <p>
                The ratings, written reviews and notes you add, photos you attach to a review in the app, and
                the dates you saw each show. These are visible only to you.
              </p>
            </div>
            <div>
              <h3 className={h3}>Watchlist and plans</h3>
              <p>
                Shows you want to see and the dates you plan to go. These are visible only to you.
              </p>
            </div>
            <div>
              <h3 className={h3}>Lists</h3>
              <p>
                Lists are private when you create them. A public list can be seen by anyone, including people you never
                sent the link to: the list, the shows and notes on it, and your display name and profile photo.
                The link preview shown by messaging apps and social networks includes your display name.
              </p>
            </div>
            <div>
              <h3 className={h3}>Imported history</h3>
              <p>
                If you import your theatre history, you either paste the address of your public Show Score
                profile (we read the reviews shown on it), upload the export file from Mezzanine, or upload
                screenshots from Theatr. Theatr screenshots are sent to our AI provider, Anthropic, to read the
                show names and dates, and are not stored by us. We save the
                ratings and dates that match shows in our catalog. When a title doesn&apos;t match, we record
                the title and our search for it so we can add missing shows. If you add a show that isn&apos;t
                in our catalog, its title and details become part of our public catalog.
              </p>
            </div>
            <div>
              <h3 className={h3}>App notifications</h3>
              <p>
                If you allow notifications in the app, we store your device&apos;s push token and link it to
                your account so we can send alerts. You can turn notifications off in your iPhone&apos;s
                Settings.
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className={h2}>Analytics and Error Reports</h2>
          <div className="space-y-3 text-gray-300">
            <p>
              We measure how the site and app are used so we can fix problems and decide what to build. This
              covers pages viewed, buttons and features used, device and browser type, and approximate region.
            </p>
            <p>
              On the website we record about one in ten visits as a session replay (clicks, scrolling and page
              changes) to find bugs and confusing screens. Replays hide what you type into password, email and
              multi-line text fields such as reviews and notes. They also hide the text on your My Shows and
              diary pages, your name in the menu, and your notes on show pages. Text typed into other fields,
              such as search boxes, can appear in a replay.
            </p>
            <p>
              When you&apos;re signed in, analytics events and error reports carry your account ID. App error
              reports can also include your email address so we can follow up on a problem with your account.
            </p>
          </div>
        </section>

        <section>
          <h2 className={h2}>Ticket Links</h2>
          <p className="text-gray-300">
            Some ticket links are affiliate links, and we may earn a commission when you buy. When you click one
            on the website, we pass a random analytics ID to the affiliate network (Impact) so we can tell which
            links lead to sales. It doesn&apos;t include your name or email address. Once you reach a ticket
            seller&apos;s site, their privacy policy applies.
          </p>
        </section>

        <section>
          <h2 className={h2}>Other Submissions</h2>
          <p className="text-gray-300">
            If you send feedback, suggest a missing critic review, or subscribe to show alerts without an
            account, we keep what you send, including your email address if you give it, to respond and to send
            the alerts you asked for.
          </p>
        </section>

        <section>
          <h2 className={h2}>What We Don&apos;t Do</h2>
          <ul className="list-disc pl-5 space-y-2 text-gray-300">
            <li>We don&apos;t sell or rent your personal information.</li>
            <li>We don&apos;t show third-party ads or share your data with ad networks.</li>
            <li>We don&apos;t collect your precise location or your contacts.</li>
          </ul>
        </section>

        <section>
          <h2 className={h2}>Services We Use</h2>
          <div className="space-y-2 text-gray-300">
            <p>These companies process data for us, each under its own privacy policy:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Supabase stores accounts and everything you save.</li>
              <li>Google and Apple handle sign-in when you choose them.</li>
              <li>Vercel hosts the website and provides basic page analytics.</li>
              <li>Google Analytics and PostHog provide usage analytics and session replays.</li>
              <li>Sentry collects error reports.</li>
              <li>Anthropic reads Theatr screenshots you upload to import your history.</li>
              <li>Formspree receives email sign-ups and form submissions, and Resend sends our emails.</li>
              <li>Expo delivers app notifications and app updates.</li>
              <li>Impact runs affiliate tracking for ticket links.</li>
            </ul>
          </div>
        </section>

        <section>
          <h2 className={h2}>Storage on Your Device</h2>
          <p className="text-gray-300">
            The website and app keep some data on your device: your sign-in session, preferences, and cached
            show data for faster loading and offline use in the app. You can clear the app&apos;s cache from its
            Settings screen. Clearing your browser data signs you out of the website.
          </p>
        </section>

        <section>
          <h2 className={h2}>Deleting Your Account</h2>
          <div className="space-y-3 text-gray-300">
            <p>
              On the website, open the menu and choose Delete account. In the app, go to Settings. Deleting your
              account immediately removes your ratings, reviews, review photos, watchlist, lists, import
              records, push tokens and profile, then the account itself. It can&apos;t be undone.
            </p>
            <p>
              Deleting your account doesn&apos;t unsubscribe you from show alert emails. Use the unsubscribe
              link in any email for that. Analytics and error records keep your old account ID but are no longer
              linked to any account. Copies in our providers&apos; backups expire on their normal schedule.
            </p>
            <p>
              For a copy of your data or any other request, contact us through the{' '}
              <Link href="/feedback" className={linkClass}>feedback page</Link>.
            </p>
          </div>
        </section>

        <section>
          <h2 className={h2}>Children&apos;s Privacy</h2>
          <p className="text-gray-300">
            Our services aren&apos;t directed at children under 13, and you must be 13 or older to create an
            account. If we learn that a child under 13 has created an account, we will delete it.
          </p>
        </section>

        <section>
          <h2 className={h2}>Changes to This Policy</h2>
          <p className="text-gray-300">
            We may update this policy from time to time. Changes will be posted on this page with a new date.
          </p>
        </section>

        <section>
          <h2 className={h2}>Contact</h2>
          <p className="text-gray-300">
            If you have questions about this privacy policy, please reach out through our{' '}
            <Link href="/feedback" className={linkClass}>feedback page</Link>.
          </p>
        </section>
      </div>

      <div className="text-center mt-8">
        <Link href="/" className="text-brand hover:underline text-sm">
          &larr; Back to Broadway Scorecard
        </Link>
      </div>
    </div>
  );
}
